export type AiTick = {
  epoch: number;
  quote: number;
};

export type AiDirection = 'UP' | 'DOWN' | 'WAIT';

export type AiTickAnalysis = {
  direction: AiDirection;
  confidence: number;
  recommendedTicks: number;
  tickCountSinceLineChange: number;
  emaFast: number;
  emaSlow: number;
  rsi: number;
  momentumPercent: number;
  rangePercent: number;
  consolidation: boolean;
  ready: boolean;
  reasons: string[];
};

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const multiplier = 2 / (period + 1);
  let result = values[0];
  for (const value of values.slice(1)) result = (value - result) * multiplier + result;
  return result;
}

function rsi(values: number[], period = 14): number {
  if (values.length < 2) return 50;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  const window = changes.slice(-period);
  const gains = window.filter(value => value > 0).reduce((sum, value) => sum + value, 0) / Math.max(1, window.length);
  const losses = Math.abs(window.filter(value => value < 0).reduce((sum, value) => sum + value, 0)) / Math.max(1, window.length);
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - (100 / (1 + gains / losses));
}

export function analyzeAiTicks(ticks: AiTick[]): AiTickAnalysis {
  const quotes = ticks.map(tick => tick.quote).filter(Number.isFinite);
  const latest = quotes[quotes.length - 1] ?? 0;
  const fallback: AiTickAnalysis = {
    direction: 'WAIT',
    confidence: 40,
    recommendedTicks: 4,
    tickCountSinceLineChange: 0,
    emaFast: latest,
    emaSlow: latest,
    rsi: 50,
    momentumPercent: 0,
    rangePercent: 0,
    consolidation: false,
    ready: false,
    reasons: ['Collect at least 10 ticks before evaluating a signal.'],
  };
  if (quotes.length < 10) return fallback;

  const fast = ema(quotes, 5);
  const slow = ema(quotes, 13);
  const first = quotes[0] || latest;
  const momentumPercent = ((latest - first) / first) * 100;
  const recent = quotes.slice(-20);
  const rangePercent = (((Math.max(...recent) - Math.min(...recent)) / (latest || 1)) * 100);
  const consolidation = rangePercent < 0.12 && Math.abs(momentumPercent) < 0.2;
  const lineDirection = fast >= slow ? 'UP' : 'DOWN';
  let tickCountSinceLineChange = 1;
  for (let index = quotes.length - 1; index > 0; index -= 1) {
    const previousFast = ema(quotes.slice(0, index), 5);
    const previousSlow = ema(quotes.slice(0, index), 13);
    const previousDirection = previousFast >= previousSlow ? 'UP' : 'DOWN';
    if (previousDirection !== lineDirection) break;
    tickCountSinceLineChange += 1;
  }

  const rsiValue = rsi(quotes);
  const separation = Math.abs(fast - slow) / (latest || 1) * 100;
  const trendStrength = clamp(separation * 140 + Math.abs(momentumPercent) * 18, 0, 46);
  const confidence = Math.round(clamp(52 + trendStrength - (consolidation ? 26 : 0), 40, 96));
  const direction: AiDirection = consolidation || confidence < 62 ? 'WAIT' : lineDirection;
  const ready = direction !== 'WAIT' && confidence >= 68 && tickCountSinceLineChange >= 2;
  const recommendedTicks = clamp(Math.round(2 + confidence / 22 + Math.min(3, tickCountSinceLineChange / 10)), 2, 8);
  const reasons: string[] = [];
  if (consolidation) reasons.push('Price action is consolidating; wait for a confirmed breakout.');
  if (fast > slow) reasons.push('Fast EMA is above slow EMA.');
  else reasons.push('Fast EMA is below slow EMA.');
  if (rsiValue > 72) reasons.push('RSI is extended above 72; avoid chasing an overbought move.');
  else if (rsiValue < 28) reasons.push('RSI is extended below 28; wait for confirmation.');
  if (tickCountSinceLineChange < 2) reasons.push('The line has just changed; wait for another tick.');
  if (!ready) reasons.push('Entry is blocked until all scanner conditions are satisfied.');

  return {
    direction,
    confidence,
    recommendedTicks,
    tickCountSinceLineChange,
    emaFast: fast,
    emaSlow: slow,
    rsi: rsiValue,
    momentumPercent,
    rangePercent,
    consolidation,
    ready,
    reasons,
  };
}
