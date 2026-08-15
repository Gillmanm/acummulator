export interface ScannerCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MetricPoint {
  epoch: number;
  bandWidth: number;
  atr: number;
  ribbonSpread: number;
  bodyRatio: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface AnalyzedCandlePoint extends MetricPoint {
  bandWidthPercentile: number;
  atrPercentile: number;
  ribbonSpreadPercentile: number;
  consolidationQualified: boolean;
}

export interface CandleAnalysis {
  latest: AnalyzedCandlePoint;
  points: AnalyzedCandlePoint[];
  consecutiveQualified: number;
  bandWidthPercentile: number;
  atrPercentile: number;
  ribbonSpreadPercentile: number;
  consolidationQualified: boolean;
  candlestickConfirmed: boolean;
  vetoReason: string | null;
}

export interface ScannerTradeLog {
  id: string;
  symbol: string;
  detectedAt: string;
  growthRate: number;
  suggestedTickTarget: number;
  outcomeTicks?: number;
  outcome?: 'win' | 'loss' | 'open';
}

export const DEFAULT_TICK_TARGET = 6;
export const MIN_TRADE_SAMPLES = 10;

export function parseCandlesResponse(response: unknown): ScannerCandle[] {
  const payload = response as { candles?: unknown };
  if (!Array.isArray(payload?.candles)) return [];

  return payload.candles
    .map((raw) => {
      const candle = raw as Record<string, unknown>;
      const epoch = Number(candle.epoch ?? candle.open_time);
      const open = Number(candle.open);
      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);
      if (![epoch, open, high, low, close].every(Number.isFinite)) return null;
      return { epoch, open, high, low, close };
    })
    .filter((candle): candle is ScannerCandle => candle !== null)
    .sort((a, b) => a.epoch - b.epoch);
}

export function upsertCandle(candles: ScannerCandle[], next: ScannerCandle, limit = 100): ScannerCandle[] {
  const existing = candles.filter((candle) => candle.epoch !== next.epoch);
  return [...existing, next].sort((a, b) => a.epoch - b.epoch).slice(-limit);
}

function simpleAverage(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function emaSeries(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return output;

  let previous = simpleAverage(values.slice(0, period));
  output[period - 1] = previous;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    previous = (values[index] - previous) * multiplier + previous;
    output[index] = previous;
  }
  return output;
}

function atrSeries(candles: ScannerCandle[], period: number): Array<number | null> {
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });

  const output: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length < period) return output;
  let previous = simpleAverage(trueRanges.slice(0, period));
  output[period - 1] = previous;
  for (let index = period; index < candles.length; index += 1) {
    previous = ((previous * (period - 1)) + trueRanges[index]) / period;
    output[index] = previous;
  }
  return output;
}

export function metricSeries(candles: ScannerCandle[]): Array<MetricPoint | null> {
  const closes = candles.map((candle) => candle.close);
  const ema10 = emaSeries(closes, 10);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const atr14 = atrSeries(candles, 14);

  return candles.map((candle, index) => {
    if (index < 19 || ema10[index] === null || ema20[index] === null || ema50[index] === null || atr14[index] === null) {
      return null;
    }

    const window = closes.slice(index - 19, index + 1);
    const middle = simpleAverage(window);
    const variance = simpleAverage(window.map((value) => (value - middle) ** 2));
    const deviation = Math.sqrt(variance);
    const upper = middle + (2 * deviation);
    const lower = middle - (2 * deviation);
    const range = candle.high - candle.low;
    const bodyRatio = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
    const emaValues = [ema10[index]!, ema20[index]!, ema50[index]!];
    const price = Math.max(Math.abs(candle.close), Number.EPSILON);

    return {
      epoch: candle.epoch,
      bandWidth: Math.max(0, (upper - lower) / Math.max(Math.abs(middle), Number.EPSILON)),
      atr: atr14[index]!,
      ribbonSpread: (Math.max(...emaValues) - Math.min(...emaValues)) / price,
      bodyRatio,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    };
  });
}

function percentileRank(values: number[], value: number): number {
  if (values.length <= 1) return 100;
  const lessOrEqual = values.filter((candidate) => candidate <= value).length;
  return (lessOrEqual / values.length) * 100;
}

function isTight(point: AnalyzedCandlePoint): boolean {
  return point.bandWidthPercentile <= 25
    && point.atrPercentile <= 25
    && point.ribbonSpreadPercentile <= 25;
}

export function analyzeCandleSeries(candles: ScannerCandle[]): CandleAnalysis | null {
  const rawPoints = metricSeries(candles).filter((point): point is MetricPoint => point !== null);
  if (rawPoints.length < 20) return null;

  const points: AnalyzedCandlePoint[] = rawPoints.map((point, index) => {
    const trailing = rawPoints.slice(Math.max(0, index - 99), index + 1);
    return {
      ...point,
      bandWidthPercentile: percentileRank(trailing.map((item) => item.bandWidth), point.bandWidth),
      atrPercentile: percentileRank(trailing.map((item) => item.atr), point.atr),
      ribbonSpreadPercentile: percentileRank(trailing.map((item) => item.ribbonSpread), point.ribbonSpread),
      consolidationQualified: false,
    };
  });

  for (const point of points) point.consolidationQualified = isTight(point);
  const latest = points[points.length - 1];
  let consecutiveQualified = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (!points[index].consolidationQualified) break;
    consecutiveQualified += 1;
  }

  const recent = points.slice(-5);
  const confirmationWindow = recent.slice(-3);
  const candlestickConfirmed = confirmationWindow.length >= 3
    && confirmationWindow.every((point) => point.bodyRatio < 0.3);
  const vetoCandle = points.slice(-2).find((point) => point.bodyRatio > 0.6);
  const vetoReason = vetoCandle
    ? `Directional candle veto: body/range ${(vetoCandle.bodyRatio * 100).toFixed(0)}%`
    : null;

  return {
    latest,
    points,
    consecutiveQualified,
    bandWidthPercentile: latest.bandWidthPercentile,
    atrPercentile: latest.atrPercentile,
    ribbonSpreadPercentile: latest.ribbonSpreadPercentile,
    consolidationQualified: consecutiveQualified >= 3,
    candlestickConfirmed,
    vetoReason,
  };
}

export function suggestedGrowthRate(bandWidthPercentile: number): number {
  if (bandWidthPercentile <= 20) return 0.05;
  if (bandWidthPercentile <= 40) return 0.04;
  if (bandWidthPercentile <= 60) return 0.03;
  if (bandWidthPercentile <= 80) return 0.02;
  return 0.01;
}

export function suggestedTickTarget(growthRate: number, logs: ScannerTradeLog[]): { ticks: number; sampleCount: number } {
  const samples = logs
    .filter((log) => log.growthRate === growthRate && Number.isFinite(log.outcomeTicks))
    .map((log) => log.outcomeTicks as number)
    .filter((ticks) => ticks > 0);

  if (samples.length < MIN_TRADE_SAMPLES) {
    return { ticks: DEFAULT_TICK_TARGET, sampleCount: samples.length };
  }

  return {
    ticks: Math.max(1, Math.round(simpleAverage(samples) * 0.6)),
    sampleCount: samples.length,
  };
}

export function averageTicksPerCandle(tickCounts: Map<number, number>, candles: ScannerCandle[]): number {
  const counts = candles
    .map((candle) => tickCounts.get(candle.epoch) ?? 0)
    .filter((count) => count > 0);
  return counts.length ? simpleAverage(counts) : 0;
}

export function formatGrowthRate(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

export function formatTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
