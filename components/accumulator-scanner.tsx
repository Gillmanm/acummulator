'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, BarChart3, CheckCircle2, Clock3, ShieldCheck, Trash2 } from 'lucide-react';
import type { ActiveSymbol, DerivWS } from '@deriv/core';
import { useActiveSymbols } from '@deriv/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSmartChartsApi } from '@/hooks/use-smartcharts-api';
import {
  analyzeCandleSeries,
  formatGrowthRate,
  formatTime,
  parseCandlesResponse,
  suggestedGrowthRate,
  suggestedTickTarget,
  upsertCandle,
  type AnalyzedCandlePoint,
  type CandleAnalysis,
  type ScannerCandle,
  type ScannerTradeLog,
} from '@/lib/accumulator-scanner';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';

const ACCU_CONTRACT_TYPES = ['ACCU'];
const ONE_MINUTE = 60;
const FIVE_MINUTES = 300;
const MAX_CANDLES = 100;

interface ScannerSignal {
  id: string;
  symbol: string;
  timeframe: '1m';
  detectedAt: string;
  consolidationCandleCount: number;
  bandWidthPercentile: number;
  suggestedGrowthRate: number;
  suggestedTickTarget: number;
  candlestickConfirmed: boolean;
  vetoReason: string | null;
}

interface ZoneLog {
  id: string;
  symbol: string;
  timeframe: '1m';
  startTime: number;
  endTime: number | null;
  candleCount: number;
  approxTickCount: number | null;
  maxBandWidthPct: number;
  endedBy: 'breakout' | 'still_active';
}

interface MarketRuntime {
  symbol: ActiveSymbol;
  candles1m: ScannerCandle[];
  candles5m: ScannerCandle[];
  analysis1m: CandleAnalysis | null;
  analysis5m: CandleAnalysis | null;
  zoneStartEpoch: number | null;
  zoneCandleCount: number;
  zoneMaxBandWidthPct: number;
  zoneTicks: number;
  signaledZoneStart: number | null;
  lastTickEpoch: number | null;
  liveTickCount: number;
}

interface MarketSnapshot {
  symbol: string;
  displayName: string;
  analysis1m: CandleAnalysis | null;
  analysis5m: CandleAnalysis | null;
  zoneCandleCount: number;
  lastTickEpoch: number | null;
  liveTickCount: number;
  status: 'warming' | 'watching' | 'setup' | 'vetoed' | 'signal';
}

function emptyRuntime(symbol: ActiveSymbol): MarketRuntime {
  return {
    symbol,
    candles1m: [],
    candles5m: [],
    analysis1m: null,
    analysis5m: null,
    zoneStartEpoch: null,
    zoneCandleCount: 0,
    zoneMaxBandWidthPct: 0,
    zoneTicks: 0,
    signaledZoneStart: null,
    lastTickEpoch: null,
    liveTickCount: 0,
  };
}

function quoteToCandle(quote: Record<string, unknown>): ScannerCandle | null {
  const raw = (quote.ohlc ?? quote) as Record<string, unknown>;
  const epoch = Number(raw.open_time ?? raw.epoch ?? (quote.DT instanceof Date ? quote.DT.getTime() / 1000 : NaN));
  const open = Number(raw.open ?? quote.Open);
  const high = Number(raw.high ?? quote.High);
  const low = Number(raw.low ?? quote.Low);
  const close = Number(raw.close ?? quote.Close);
  if (![epoch, open, high, low, close].every(Number.isFinite)) return null;
  return { epoch, open, high, low, close };
}

function statusLabel(status: MarketSnapshot['status']): string {
  switch (status) {
    case 'signal': return 'Signal';
    case 'setup': return 'Consolidating';
    case 'vetoed': return 'Vetoed';
    case 'watching': return 'Watching';
    default: return 'Warming up';
  }
}

function statusClass(status: MarketSnapshot['status']): string {
  switch (status) {
    case 'signal': return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'setup': return 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'vetoed': return 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400';
    default: return 'border-border bg-muted/30 text-muted-foreground';
  }
}

function percentileText(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(0)}%`;
}

export function AccumulatorScanner({ ws, isConnected }: { ws: DerivWS | null; isConnected: boolean }) {
  const { symbols, isLoading: symbolsLoading } = useActiveSymbols(ws, isConnected, ACCU_CONTRACT_TYPES);
  const { getQuotes, subscribeQuotes } = useSmartChartsApi(ws);
  const [eligibleSymbols, setEligibleSymbols] = useState<ActiveSymbol[]>([]);
  const [snapshots, setSnapshots] = useState<MarketSnapshot[]>([]);
  const [signals, setSignals] = useState<ScannerSignal[]>([]);
  const [zoneLogs, setZoneLogs] = useState<ZoneLog[]>([]);
  const [tradeLogs, setTradeLogs] = useState<ScannerTradeLog[]>([]);
  const runtimesRef = useRef<Record<string, MarketRuntime>>({});
  const tradeLogsRef = useRef<ScannerTradeLog[]>([]);
  const zoneLogsRef = useRef<ZoneLog[]>([]);
  const snapshotTimerRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const storedTrades = window.localStorage.getItem('accumulator-scanner-trades');
      const storedZones = window.localStorage.getItem('accumulator-scanner-zones');
      if (storedTrades) {
        const parsed = JSON.parse(storedTrades) as ScannerTradeLog[];
        if (Array.isArray(parsed)) {
          tradeLogsRef.current = parsed;
          setTradeLogs(parsed);
        }
      }
      if (storedZones) {
        const parsed = JSON.parse(storedZones) as ZoneLog[];
        if (Array.isArray(parsed)) {
          zoneLogsRef.current = parsed;
          setZoneLogs(parsed);
        }
      }
    } catch {
      // A corrupted local log must never stop the live scanner.
    }
  }, []);

  useEffect(() => {
    if (!ws || !isConnected || symbols.length === 0) {
      setEligibleSymbols([]);
      return;
    }

    let disposed = false;
    const candidates = symbols.filter((symbol) => symbol.market === 'synthetic_index');

    async function confirmEligibility() {
      const checked = await Promise.all(candidates.map(async (symbol) => {
        try {
          const response = await ws!.send<{ contracts_for?: { available?: Array<{ contract_type?: string }> } }>({
            contracts_for: symbol.underlying_symbol,
          });
          const available = response.contracts_for?.available ?? [];
          return available.some((contract) => contract.contract_type === 'ACCU') ? symbol : null;
        } catch {
          return null;
        }
      }));
      if (!disposed) setEligibleSymbols(checked.filter((symbol): symbol is ActiveSymbol => symbol !== null));
    }

    confirmEligibility().catch(() => {
      if (!disposed) setEligibleSymbols([]);
    });
    return () => { disposed = true; };
  }, [ws, isConnected, symbols]);

  const snapshotFor = useCallback((runtime: MarketRuntime): MarketSnapshot => {
    const analysis = runtime.analysis1m;
    let status: MarketSnapshot['status'] = 'warming';
    if (analysis) {
      if (analysis.vetoReason) status = 'vetoed';
      else if (runtime.signaledZoneStart !== null) status = 'signal';
      else if (analysis.consolidationQualified) status = 'setup';
      else status = 'watching';
    }
    return {
      symbol: runtime.symbol.underlying_symbol,
      displayName: getSymbolDisplayName(runtime.symbol.underlying_symbol),
      analysis1m: runtime.analysis1m,
      analysis5m: runtime.analysis5m,
      zoneCandleCount: runtime.zoneCandleCount,
      lastTickEpoch: runtime.lastTickEpoch,
      liveTickCount: runtime.liveTickCount,
      status,
    };
  }, []);

  const flushSnapshots = useCallback(() => {
    setSnapshots(Object.values(runtimesRef.current)
      .map(snapshotFor)
      .sort((a, b) => a.symbol.localeCompare(b.symbol)));
  }, [snapshotFor]);

  const addZoneLog = useCallback((zone: ZoneLog) => {
    zoneLogsRef.current = [zone, ...zoneLogsRef.current].slice(0, 200);
    setZoneLogs(zoneLogsRef.current);
    try {
      window.localStorage.setItem('accumulator-scanner-zones', JSON.stringify(zoneLogsRef.current));
    } catch {
      // Local persistence is best effort.
    }
  }, []);

  const processCandle = useCallback((symbol: string, granularity: number, candle: ScannerCandle) => {
    const runtime = runtimesRef.current[symbol];
    if (!runtime) return;

    if (granularity === ONE_MINUTE) {
      runtime.candles1m = upsertCandle(runtime.candles1m, candle, MAX_CANDLES);
      runtime.analysis1m = analyzeCandleSeries(runtime.candles1m);
      const analysis = runtime.analysis1m;
      if (analysis?.consolidationQualified) {
        if (runtime.zoneStartEpoch === null) {
          runtime.zoneStartEpoch = candle.epoch;
          runtime.zoneTicks = 0;
          runtime.signaledZoneStart = null;
        }
        runtime.zoneCandleCount = analysis.consecutiveQualified;
        runtime.zoneMaxBandWidthPct = Math.max(runtime.zoneMaxBandWidthPct, analysis.latest.bandWidth * 100);

        const context = runtime.analysis5m;
        const contextConfirmed = Boolean(context && !context.vetoReason);
        const confirmed = analysis.candlestickConfirmed && !analysis.vetoReason && contextConfirmed;
        if (confirmed && runtime.signaledZoneStart !== runtime.zoneStartEpoch) {
          const growthRate = suggestedGrowthRate(analysis.bandWidthPercentile);
          const target = suggestedTickTarget(growthRate, tradeLogsRef.current);
          const signal: ScannerSignal = {
            id: `${symbol}-${candle.epoch}`,
            symbol,
            timeframe: '1m',
            detectedAt: new Date(candle.epoch * 1000).toISOString(),
            consolidationCandleCount: analysis.consecutiveQualified,
            bandWidthPercentile: analysis.bandWidthPercentile,
            suggestedGrowthRate: growthRate,
            suggestedTickTarget: target.ticks,
            candlestickConfirmed: true,
            vetoReason: null,
          };
          runtime.signaledZoneStart = runtime.zoneStartEpoch;
          setSignals((previous) => [signal, ...previous.filter((item) => item.symbol !== symbol)].slice(0, 50));
        }
      } else if (runtime.zoneStartEpoch !== null) {
        addZoneLog({
          id: `${symbol}-${runtime.zoneStartEpoch}`,
          symbol,
          timeframe: '1m',
          startTime: runtime.zoneStartEpoch,
          endTime: candle.epoch,
          candleCount: runtime.zoneCandleCount,
          approxTickCount: runtime.zoneTicks > 0 ? runtime.zoneTicks : null,
          maxBandWidthPct: runtime.zoneMaxBandWidthPct,
          endedBy: 'breakout',
        });
        runtime.zoneStartEpoch = null;
        runtime.zoneCandleCount = 0;
        runtime.zoneMaxBandWidthPct = 0;
        runtime.zoneTicks = 0;
        runtime.signaledZoneStart = null;
      }
    } else if (granularity === FIVE_MINUTES) {
      runtime.candles5m = upsertCandle(runtime.candles5m, candle, MAX_CANDLES);
      runtime.analysis5m = analyzeCandleSeries(runtime.candles5m);
    }

    if (snapshotTimerRef.current === null) {
      snapshotTimerRef.current = window.setTimeout(() => {
        snapshotTimerRef.current = null;
        flushSnapshots();
      }, 250);
    }
  }, [addZoneLog, flushSnapshots]);

  useEffect(() => {
    if (!ws || !isConnected || eligibleSymbols.length === 0) {
      setSnapshots([]);
      return;
    }

    let disposed = false;
    const unsubscribers: Array<() => void> = [];
    const runtimes: Record<string, MarketRuntime> = {};
    for (const symbol of eligibleSymbols) runtimes[symbol.underlying_symbol] = emptyRuntime(symbol);
    runtimesRef.current = runtimes;
    setSnapshots(eligibleSymbols.map((symbol) => snapshotFor(runtimes[symbol.underlying_symbol])));

    const loadInitial = async (symbol: ActiveSymbol, granularity: number) => {
      try {
        const response = await getQuotes({ symbol: symbol.underlying_symbol, granularity, count: MAX_CANDLES });
        if (disposed) return;
        const runtime = runtimesRef.current[symbol.underlying_symbol];
        if (!runtime) return;
        const candles = parseCandlesResponse(response);
        if (granularity === ONE_MINUTE) {
          runtime.candles1m = candles;
          runtime.analysis1m = analyzeCandleSeries(candles);
          const analysis = runtime.analysis1m;
          if (analysis?.consolidationQualified && candles.length > 0) {
            runtime.zoneStartEpoch = candles[candles.length - 1].epoch - ((analysis.consecutiveQualified - 1) * ONE_MINUTE);
            runtime.zoneCandleCount = analysis.consecutiveQualified;
            runtime.zoneMaxBandWidthPct = analysis.points
              .slice(-analysis.consecutiveQualified)
              .reduce((maximum, point) => Math.max(maximum, point.bandWidth * 100), 0);
          }
        } else {
          runtime.candles5m = candles;
          runtime.analysis5m = analyzeCandleSeries(candles);
        }
        flushSnapshots();
      } catch {
        // Individual markets can fail independently without stopping the scanner.
      }
    };

    for (const symbol of eligibleSymbols) {
      void loadInitial(symbol, ONE_MINUTE);
      void loadInitial(symbol, FIVE_MINUTES);
      unsubscribers.push(subscribeQuotes(
        { symbol: symbol.underlying_symbol, granularity: ONE_MINUTE, style: 'candles' },
        (quote) => {
          const candle = quoteToCandle(quote);
          if (candle) processCandle(symbol.underlying_symbol, ONE_MINUTE, candle);
        },
      ));
      unsubscribers.push(subscribeQuotes(
        { symbol: symbol.underlying_symbol, granularity: FIVE_MINUTES, style: 'candles' },
        (quote) => {
          const candle = quoteToCandle(quote);
          if (candle) processCandle(symbol.underlying_symbol, FIVE_MINUTES, candle);
        },
      ));

      ws.subscribe({ ticks: symbol.underlying_symbol, subscribe: 1 }, (response: Record<string, unknown>) => {
        const tick = response.tick as { epoch?: number } | undefined;
        if (!tick || !Number.isFinite(Number(tick.epoch))) return;
        const runtime = runtimesRef.current[symbol.underlying_symbol];
        if (!runtime) return;
        runtime.lastTickEpoch = Number(tick.epoch);
        runtime.liveTickCount += 1;
        if (runtime.zoneStartEpoch !== null && Number(tick.epoch) >= runtime.zoneStartEpoch) runtime.zoneTicks += 1;
      }).then(({ unsubscribe }) => {
        if (disposed) unsubscribe();
        else unsubscribers.push(unsubscribe);
      }).catch(() => { });
    }

    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (snapshotTimerRef.current !== null) {
        window.clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
    };
  }, [ws, isConnected, eligibleSymbols, getQuotes, subscribeQuotes, processCandle, snapshotFor, flushSnapshots]);

  const clearLogs = useCallback(() => {
    tradeLogsRef.current = [];
    zoneLogsRef.current = [];
    setTradeLogs([]);
    setZoneLogs([]);
    try {
      window.localStorage.removeItem('accumulator-scanner-trades');
      window.localStorage.removeItem('accumulator-scanner-zones');
    } catch {
      // Local persistence is best effort.
    }
  }, []);

  const readyCount = useMemo(() => snapshots.filter((snapshot) => snapshot.analysis1m !== null).length, [snapshots]);
  const setupCount = useMemo(() => snapshots.filter((snapshot) => snapshot.status === 'setup' || snapshot.status === 'signal').length, [snapshots]);

  return (
    <div className="space-y-4 pb-14">
      <Card className="border-primary/20 bg-card shadow-sm">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              <CardTitle>Accumulator Market Scanner</CardTitle>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Live signal-only monitoring for every synthetic-index symbol that supports ACCU contracts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={isConnected ? 'default' : 'outline'}>
              {isConnected ? 'Live feed' : 'Connecting'}
            </Badge>
            <Button type="button" variant="outline" size="sm" onClick={clearLogs}>
              <Trash2 className="mr-1.5 h-4 w-4" />
              Clear logs
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Eligible symbols</p>
            <p className="mt-1 text-2xl font-semibold">{eligibleSymbols.length}</p>
            <p className="text-xs text-muted-foreground">Confirmed through contracts_for</p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">History ready</p>
            <p className="mt-1 text-2xl font-semibold">{readyCount}/{eligibleSymbols.length}</p>
            <p className="text-xs text-muted-foreground">100 one-minute candles requested</p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Active setups</p>
            <p className="mt-1 text-2xl font-semibold">{setupCount}</p>
            <p className="text-xs text-muted-foreground">Three-candle consolidation minimum</p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Logged zones</p>
            <p className="mt-1 text-2xl font-semibold">{zoneLogs.length}</p>
            <p className="text-xs text-muted-foreground">Signals: {signals.length} · Trades: {tradeLogs.length}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border bg-slate-950 text-white shadow-sm">
        <CardHeader>
          <CardTitle className="text-white">Signal-only bot rules</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm text-slate-200 md:grid-cols-2 lg:grid-cols-4">
          <div className="flex gap-2"><BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" /><span><strong className="text-white">Data:</strong> 1-minute primary candles with 5-minute context.</span></div>
          <div className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /><span><strong className="text-white">Consolidation:</strong> BB(20,2), ATR(14), and EMA 10/20/50 below their own trailing 25th percentile for three candles.</span></div>
          <div className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><span><strong className="text-white">Veto:</strong> a body/range ratio above 0.6 in the last two candles blocks the signal.</span></div>
          <div className="flex gap-2"><Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" /><span><strong className="text-white">Target:</strong> suggested growth rate follows band-width percentile; tick target uses logged trade samples or a 6-tick conservative default.</span></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Market watchlist</CardTitle>
        </CardHeader>
        <CardContent>
          {symbolsLoading && eligibleSymbols.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-pulse" /> Loading ACCU-eligible markets…</div>
          ) : snapshots.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><AlertCircle className="h-4 w-4" /> No ACCU-eligible synthetic-index markets are available yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2">Market</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2">BB width</th>
                    <th className="px-2 py-2">ATR</th>
                    <th className="px-2 py-2">EMA ribbon</th>
                    <th className="px-2 py-2">Zone</th>
                    <th className="px-2 py-2">Context</th>
                    <th className="px-2 py-2">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((snapshot) => {
                    const analysis = snapshot.analysis1m;
                    return (
                      <tr key={snapshot.symbol} className="border-b border-border/60 last:border-0">
                        <td className="px-2 py-3"><div className="font-medium">{snapshot.displayName}</div><div className="text-xs text-muted-foreground">{snapshot.symbol}</div></td>
                        <td className="px-2 py-3"><Badge variant="outline" className={statusClass(snapshot.status)}>{statusLabel(snapshot.status)}</Badge></td>
                        <td className="px-2 py-3">{percentileText(analysis?.bandWidthPercentile)}</td>
                        <td className="px-2 py-3">{percentileText(analysis?.atrPercentile)}</td>
                        <td className="px-2 py-3">{percentileText(analysis?.ribbonSpreadPercentile)}</td>
                        <td className="px-2 py-3">{snapshot.zoneCandleCount >= 3 ? `${snapshot.zoneCandleCount} candles` : '—'}</td>
                        <td className="px-2 py-3">{snapshot.analysis5m ? (snapshot.analysis5m.vetoReason ? 'Vetoed' : snapshot.analysis5m.consolidationQualified ? 'Confirmed' : 'Open') : 'Loading'}</td>
                        <td className="px-2 py-3 text-xs text-muted-foreground">{snapshot.lastTickEpoch ? formatTime(snapshot.lastTickEpoch) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Entry signals</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {signals.length === 0 ? (
              <p className="text-sm text-muted-foreground">No confirmed signals yet. The bot will show them here after the 1-minute and 5-minute checks agree.</p>
            ) : signals.slice(0, 10).map((signal) => (
              <div key={signal.id} className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                <div className="flex items-center justify-between gap-2"><strong>{signal.symbol}</strong><Badge className="bg-emerald-600 text-white">SIGNAL ONLY</Badge></div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                  <span>Timeframe<strong className="block text-foreground">{signal.timeframe}</strong></span>
                  <span>Zone<strong className="block text-foreground">{signal.consolidationCandleCount} candles</strong></span>
                  <span>Growth<strong className="block text-foreground">{formatGrowthRate(signal.suggestedGrowthRate)}</strong></span>
                  <span>Target<strong className="block text-foreground">{signal.suggestedTickTarget} ticks</strong></span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Detected {new Date(signal.detectedAt).toLocaleString()} · No trade was placed.</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Consolidation log</CardTitle></CardHeader>
          <CardContent>
            {zoneLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Zones will be recorded here, including those that never produce a signal.</p>
            ) : (
              <div className="space-y-2">
                {zoneLogs.slice(0, 8).map((zone) => (
                  <div key={zone.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-2.5 text-xs">
                    <div><strong>{zone.symbol}</strong><div className="text-muted-foreground">{formatTime(zone.startTime)} · {zone.candleCount} candles · {zone.approxTickCount === null ? 'tick estimate pending' : `${zone.approxTickCount} ticks`}</div></div>
                    <Badge variant="outline">{zone.endedBy}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="flex gap-3 p-4 text-sm text-amber-900 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <p><strong>Risk notice:</strong> this page is signal-only and does not place trades. Consolidation detection can fail during sudden breaks, and a historical tick target is not a guarantee. Test on a demo account and review logged zones and outcomes before considering any execution integration.</p>
        </CardContent>
      </Card>
    </div>
  );
}
