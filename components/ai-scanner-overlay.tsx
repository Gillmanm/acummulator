'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, BrainCircuit, CheckCircle2, ChevronDown, X } from 'lucide-react';
import type { ActiveSymbol } from '@deriv/core';
import type { UseSmartChartsApiReturn } from '@/hooks/use-smartcharts-api';
import { analyzeAiTicks, type AiDirection, type AiTick, type AiTickAnalysis } from '@/lib/ai-tick-scanner';
import type { UseAccumulatorAiTraderReturn } from '@/hooks/use-accumulator-ai-trader';

const MAX_TICKS = 50;
type ExecutionMode = 'analysis' | 'paper' | 'live';

type EntryRequest = {
  direction: Exclude<AiDirection, 'WAIT'>;
  recommendedTicks: number;
  takeProfitTicks: number;
  stopLossTicks: number;
  growthTarget: number;
};

type Props = {
  activeSymbol: ActiveSymbol | null;
  symbols: ActiveSymbol[];
  isConnected: boolean;
  getQuotes: UseSmartChartsApiReturn['getQuotes'];
  subscribeQuotes: UseSmartChartsApiReturn['subscribeQuotes'];
  onPlaceEntry: (request: EntryRequest) => Promise<void>;
  aiTrader?: UseAccumulatorAiTraderReturn;
};

type AiResponse = {
  direction?: AiDirection;
  confidence?: number;
  recommendedTicks?: number;
  rationale?: string;
};

function parseTicks(response: unknown): AiTick[] {
  const payload = response as Record<string, unknown>;
  const history = (payload.history ?? payload) as Record<string, unknown>;
  const prices = Array.isArray(history.prices) ? history.prices.map(Number) : [];
  const times = Array.isArray(history.times) ? history.times.map(Number) : [];
  return prices
    .map((quote, index) => ({ quote, epoch: Number(times[index] ?? Math.floor(Date.now() / 1000) - prices.length + index) }))
    .filter(tick => Number.isFinite(tick.quote) && Number.isFinite(tick.epoch))
    .slice(-MAX_TICKS);
}

function statusFor(analysis: AiTickAnalysis): { label: string; className: string } {
  if (analysis.ready) return { label: `${analysis.direction} entry ready`, className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' };
  if (analysis.consolidation) return { label: 'Consolidation — wait', className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300' };
  return { label: 'Waiting for confirmation', className: 'border-border bg-muted/30 text-muted-foreground' };
}

export function AiScannerOverlay({
  activeSymbol,
  symbols,
  isConnected,
  getQuotes,
  subscribeQuotes,
  onPlaceEntry,
  aiTrader,
}: Props) {
  const [open, setOpen] = useState(false);
  const [ticks, setTicks] = useState<AiTick[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [marketSnapshots, setMarketSnapshots] = useState<Record<string, AiTick[]>>({});
  const [marketInput, setMarketInput] = useState('');
  const [growthTarget, setGrowthTarget] = useState(5);
  const [takeProfitTicks, setTakeProfitTicks] = useState(4);
  const [stopLossTicks, setStopLossTicks] = useState(3);
  const [minConfidence, setMinConfidence] = useState(68);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('analysis');
  const [aiResponse, setAiResponse] = useState<AiResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [entryBusy, setEntryBusy] = useState(false);

  const activeSymbolCode = activeSymbol?.underlying_symbol ?? '';
  const analysis = useMemo(() => analyzeAiTicks(ticks), [ticks]);
  const scannerStatus = statusFor(analysis);
  const effectiveReady = analysis.ready && analysis.confidence >= minConfidence;
  const direction = aiResponse?.direction && aiResponse.direction !== 'WAIT' ? aiResponse.direction : analysis.direction;
  const recommendedTicks = aiResponse?.recommendedTicks && aiResponse.recommendedTicks > 0 ? aiResponse.recommendedTicks : analysis.recommendedTicks;

  useEffect(() => {
    if (!activeSymbolCode || !isConnected) {
      setTicks([]);
      return;
    }
    let disposed = false;
    void getQuotes({ symbol: activeSymbolCode, count: MAX_TICKS }).then(response => {
      if (!disposed) setTicks(parseTicks(response));
    }).catch(() => { });
    const unsubscribe = subscribeQuotes({ symbol: activeSymbolCode }, quote => {
      const tick = quote.tick as { epoch?: number; quote?: number } | undefined;
      if (!tick || !Number.isFinite(Number(tick.quote))) return;
      setTicks(previous => [...previous, { epoch: Number(tick.epoch ?? Date.now() / 1000), quote: Number(tick.quote) }].slice(-MAX_TICKS));
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [activeSymbolCode, getQuotes, isConnected, subscribeQuotes]);

  useEffect(() => {
    if (!open || !isConnected || watchlist.length === 0) return;
    let disposed = false;
    const loadSnapshots = async () => {
      const entries = await Promise.all(watchlist.map(async symbol => {
        try {
          const response = await getQuotes({ symbol, count: MAX_TICKS });
          return [symbol, parseTicks(response)] as const;
        } catch {
          return [symbol, []] as const;
        }
      }));
      if (!disposed) setMarketSnapshots(Object.fromEntries(entries));
    };
    void loadSnapshots();
    const timer = window.setInterval(() => void loadSnapshots(), 15000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [getQuotes, isConnected, open, watchlist]);

  useEffect(() => {
    setWatchlist(current => current.includes(activeSymbolCode) || !activeSymbolCode ? current : [activeSymbolCode, ...current]);
  }, [activeSymbolCode]);

  const runGeminiAnalysis = async () => {
    if (!activeSymbolCode || ticks.length < 10) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const response = await fetch('/api/ai-scanner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: activeSymbolCode, ticks: ticks.slice(-MAX_TICKS), localAnalysis: analysis }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Gemini analysis is unavailable. Local analysis remains active.');
      setAiResponse(payload as AiResponse);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'Gemini analysis failed.');
    } finally {
      setAiLoading(false);
    }
  };

  const addMarket = () => {
    const value = marketInput.trim().toUpperCase();
    if (value && !watchlist.includes(value)) setWatchlist(current => [...current, value]);
    setMarketInput('');
  };

  const confirmEntry = async () => {
    if (!effectiveReady || (direction !== 'UP' && direction !== 'DOWN')) return;
    setEntryBusy(true);
    try {
      if (executionMode === 'live') {
        await onPlaceEntry({ direction, recommendedTicks, takeProfitTicks, stopLossTicks, growthTarget });
      }
      setConfirming(false);
    } finally {
      setEntryBusy(false);
    }
  };

  const formatQuote = (quote: number) => quote.toFixed(5);
  const history = [...ticks].reverse();

  return (
    <div className="relative mt-2 rounded-xl border border-border bg-card/80 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Market feed</p>
            <p className="truncate text-sm font-medium">Last 50 ticks · {activeSymbolCode || 'Active market'}</p>
          </div>
        </div>
        <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:opacity-90">
          <BrainCircuit className="h-3.5 w-3.5" /> AI scanner
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[430px] text-left text-xs">
          <thead className="bg-muted/40 text-muted-foreground"><tr><th className="px-3 py-2 font-medium sm:px-4">#</th><th className="px-3 py-2 font-medium">Time</th><th className="px-3 py-2 font-medium">Quote</th><th className="px-3 py-2 font-medium">Move</th></tr></thead>
          <tbody>
            {history.length === 0 ? <tr><td colSpan={4} className="px-4 py-7 text-center text-muted-foreground">{isConnected ? 'Collecting live ticks…' : 'Connect to collect tick history.'}</td></tr> : history.map((tick, index) => {
              const previous = history[index + 1]?.quote;
              const move = previous === undefined ? '—' : tick.quote >= previous ? 'UP' : 'DOWN';
              return <tr key={`${tick.epoch}-${index}`} className="border-t border-border/60"><td className="px-3 py-2 text-muted-foreground sm:px-4">{ticks.length - index}</td><td className="px-3 py-2 text-muted-foreground">{new Date(tick.epoch * 1000).toLocaleTimeString()}</td><td className="px-3 py-2 font-mono">{formatQuote(tick.quote)}</td><td className={`px-3 py-2 font-semibold ${move === 'UP' ? 'text-emerald-600 dark:text-emerald-400' : move === 'DOWN' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>{move}</td></tr>;
            })}
          </tbody>
        </table>
      </div>

      {open && <>
        <button type="button" aria-label="Close AI scanner" className="fixed inset-0 z-40 cursor-default bg-black/20 backdrop-blur-[1px]" onClick={() => setOpen(false)} />
        <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-background shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Live market intelligence</p><h2 className="text-lg font-semibold">AI scanner</h2></div><button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close AI scanner"><X className="h-5 w-5" /></button></div>
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <div className={`rounded-lg border px-3 py-2 text-sm font-semibold ${scannerStatus.className}`}><div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-current" />{scannerStatus.label}<span className="ml-auto text-xs font-normal">{analysis.confidence}%</span></div></div>
            <div className="grid grid-cols-4 gap-2 text-center text-[11px]"><div className="rounded-lg bg-muted/50 p-2"><span className="block text-muted-foreground">Trend</span><strong>{analysis.direction}</strong></div><div className="rounded-lg bg-muted/50 p-2"><span className="block text-muted-foreground">Ticks</span><strong>{recommendedTicks}</strong></div><div className="rounded-lg bg-muted/50 p-2"><span className="block text-muted-foreground">RSI</span><strong>{analysis.rsi.toFixed(0)}</strong></div><div className="rounded-lg bg-muted/50 p-2"><span className="block text-muted-foreground">Count</span><strong>{analysis.tickCountSinceLineChange}/{MAX_TICKS}</strong></div></div>
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground"><div className="mb-1 flex items-center gap-1.5 font-semibold text-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-primary" />Scanner conditions</div><p>EMA(5) / EMA(13), RSI(14), momentum, range, confidence, and consolidation are checked before entry.</p><p className="mt-1">New count starts after the detected EMA line direction changes.</p>{analysis.reasons.slice(0, 3).map(reason => <p key={reason} className="mt-1">• {reason}</p>)}</div>
            {aiTrader && (
              <div className="rounded-lg border border-primary/30 bg-primary/10 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-primary">Accumulator AI Engine</span>
                  <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-primary text-primary-foreground">
                    {aiTrader.aiMode === 'ai_only' ? 'AI ONLY' : 'AI ACTIVE'}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Channel Safety: {aiTrader.aiDecision?.barrierSafety || 'SAFE'} | Confidence: {aiTrader.aiDecision?.confidence || 75}%
                </p>
                <button
                  type="button"
                  disabled={aiTrader.isExecuting || aiTrader.status === 'COOLING_DOWN'}
                  onClick={async () => {
                    await aiTrader.executeAiEntry(true);
                    setOpen(false);
                  }}
                  className="w-full rounded-md bg-primary py-2 text-xs font-bold text-primary-foreground shadow hover:opacity-90 disabled:opacity-50"
                >
                  {aiTrader.isExecuting ? 'Placing AI Entry...' : 'Place AI Accumulator Entry Now'}
                </button>
              </div>
            )}
            <div className="flex gap-2"><button type="button" disabled={ticks.length < 10 || aiLoading} onClick={runGeminiAnalysis} className="flex-1 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">{aiLoading ? 'Analysing…' : 'Run Gemini analysis'}</button><button type="button" disabled={!effectiveReady} onClick={() => setConfirming(true)} className="flex-1 rounded-md border border-border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50">Review entry</button></div>
            {aiError && <p className="text-xs text-amber-600 dark:text-amber-400">{aiError}</p>}
            {aiResponse?.rationale && <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs"><p className="mb-1 font-semibold">Gemini rationale</p><p className="text-muted-foreground">{aiResponse.rationale}</p></div>}
            <section><h3 className="mb-2 text-sm font-semibold">Risk controls</h3><div className="grid grid-cols-2 gap-3">{[["Growth target %", growthTarget, setGrowthTarget, 0, 100], ["Take profit ticks", takeProfitTicks, setTakeProfitTicks, 1, 100], ["Stop loss ticks", stopLossTicks, setStopLossTicks, 1, 100], ["Min confidence %", minConfidence, setMinConfidence, 40, 99]].map(([label, value, setter, min, max]) => <label key={label as string} className="space-y-1 text-xs text-muted-foreground"><span>{label as string}</span><input type="number" min={min as number} max={max as number} value={value as number} onChange={event => (setter as (value: number) => void)(Number(event.target.value))} className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none ring-primary focus:ring-2" /></label>)}</div></section>
            <label className="block space-y-1 text-xs text-muted-foreground"><span>Execution mode</span><div className="relative"><select value={executionMode} onChange={event => setExecutionMode(event.target.value as ExecutionMode)} className="w-full appearance-none rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground"><option value="analysis">Analysis only</option><option value="paper">Paper trade with confirmation</option><option value="live">Live entry after confirmation</option></select><ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4" /></div></label>
            <section><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Multi-market watchlist</h3><span className="text-[11px] text-muted-foreground">Read-only snapshots</span></div><div className="flex gap-2"><input value={marketInput} placeholder="Add market symbol" onChange={event => setMarketInput(event.target.value)} onKeyDown={event => event.key === 'Enter' && addMarket()} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none ring-primary focus:ring-2" /><button type="button" onClick={addMarket} className="rounded-md border border-border px-3 py-2 text-xs font-semibold">Add</button></div><div className="mt-2 space-y-2">{watchlist.map(market => { const snapshot = market === activeSymbolCode ? ticks : marketSnapshots[market] ?? []; const marketAnalysis = analyzeAiTicks(snapshot); return <div key={market} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs"><div><strong>{market}</strong><p className="text-muted-foreground">{snapshot.length}/50 ticks · {marketAnalysis.direction}</p></div><span className={marketAnalysis.ready ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>{marketAnalysis.ready ? `${marketAnalysis.confidence}% ready` : 'Watching'}</span></div>; })}</div></section>
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><p>AI signals are probabilistic. Review direction, tick count, take profit, and stop loss before any entry. No guaranteed win rate is implied.</p></div>
          </div>
        </aside>
      </>}

      {confirming && <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4"><div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-xl border border-border bg-background p-5 shadow-2xl"><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Manual confirmation required</p><h3 className="mt-2 text-lg font-semibold">{direction} entry on {activeSymbolCode || 'active market'}</h3><p className="mt-2 text-sm text-muted-foreground">{executionMode === 'live' ? 'This will call the existing buy flow after your confirmation.' : 'This will record an analysis/paper decision only; no live order will be sent.'}</p><div className="mt-4 grid grid-cols-2 gap-2 text-xs"><div className="rounded-md bg-muted/50 p-2">Ticks<strong className="mt-1 block text-sm">{recommendedTicks}</strong></div><div className="rounded-md bg-muted/50 p-2">Confidence<strong className="mt-1 block text-sm">{analysis.confidence}%</strong></div><div className="rounded-md bg-muted/50 p-2">Take profit<strong className="mt-1 block text-sm">{takeProfitTicks}</strong></div><div className="rounded-md bg-muted/50 p-2">Stop loss<strong className="mt-1 block text-sm">{stopLossTicks}</strong></div></div><div className="mt-4 flex gap-2"><button type="button" onClick={() => setConfirming(false)} className="flex-1 rounded-md border border-border px-3 py-2 text-xs font-semibold">Cancel</button><button type="button" onClick={confirmEntry} disabled={entryBusy} className="flex-1 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">{entryBusy ? 'Working…' : executionMode === 'live' ? 'Confirm live entry' : 'Confirm paper review'}</button></div></div></div>}
    </div>
  );
}
