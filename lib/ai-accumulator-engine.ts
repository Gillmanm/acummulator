export interface AccumulatorAiDecision {
  entryDecision: 'ENTER' | 'WAIT';
  confidence: number; // 0 - 100
  barrierSafety: 'SAFE' | 'BORDERLINE' | 'CRITICAL';
  recommendedTicks: number; // 2 - 10
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  volatilityScore: number; // 0 - 100 (lower = calmer/safer)
  rationale: string;
  reasons: string[];
  metrics: {
    currentSpot: number;
    highBarrier?: number;
    lowBarrier?: number;
    distanceToHigh?: number;
    distanceToLow?: number;
    channelWidth?: number;
    centerOffsetPercent: number; // 0% = centered, 100% = on barrier
    barrierPercentage?: string;
    volatilityStdDev: number;
    maxRecentTickStep: number;
    survivalProbability: number;
  };
}

export interface AccumulatorMarketContext {
  symbol: string;
  spot: number;
  ticks: Array<{ epoch: number; quote: number }>;
  highBarrier?: number | string;
  lowBarrier?: number | string;
  barrierPercentage?: string;
  hasCrossedBarrier?: boolean;
  growthRate?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Deterministic mathematical analysis specifically tailored for Deriv Accumulators.
 * In Accumulator contracts, payout grows per tick as long as price does NOT touch
 * the upper or lower barrier. Knockout occurs instantly upon barrier breach.
 * Thus, optimal entry requires:
 * 1. Price is well-centered inside the high/low barrier channel.
 * 2. Recent tick velocity & volatility are calm (no wild spikes towards barriers).
 * 3. Consistent oscillation without momentum runaway.
 */
export function analyzeAccumulatorMarket(context: AccumulatorMarketContext): AccumulatorAiDecision {
  const { spot, ticks, hasCrossedBarrier = false, barrierPercentage, highBarrier, lowBarrier } = context;
  const quotes = ticks.map(t => Number(t.quote)).filter(q => Number.isFinite(q) && q > 0);
  const currentSpot = spot > 0 ? spot : quotes[quotes.length - 1] || 0;

  const numHigh = highBarrier !== undefined && highBarrier !== '' ? Number(highBarrier) : undefined;
  const numLow = lowBarrier !== undefined && lowBarrier !== '' ? Number(lowBarrier) : undefined;

  let channelWidth: number | undefined;
  let distanceToHigh: number | undefined;
  let distanceToLow: number | undefined;
  let centerOffsetPercent = 50; // default 50%

  if (numHigh !== undefined && numLow !== undefined && numHigh > numLow && currentSpot > 0) {
    channelWidth = numHigh - numLow;
    distanceToHigh = numHigh - currentSpot;
    distanceToLow = currentSpot - numLow;
    const mid = (numHigh + numLow) / 2;
    const halfWidth = channelWidth / 2;
    centerOffsetPercent = clamp(Math.round((Math.abs(currentSpot - mid) / halfWidth) * 100), 0, 100);
  }

  // Calculate tick-to-tick step metrics
  const recentQuotes = quotes.slice(-20);
  const tickSteps: number[] = [];
  for (let i = 1; i < recentQuotes.length; i++) {
    tickSteps.push(Math.abs(recentQuotes[i] - recentQuotes[i - 1]));
  }

  const meanStep = tickSteps.length ? tickSteps.reduce((a, b) => a + b, 0) / tickSteps.length : 0;
  const variance = tickSteps.length
    ? tickSteps.reduce((sum, step) => sum + Math.pow(step - meanStep, 2), 0) / tickSteps.length
    : 0;
  const volatilityStdDev = Math.sqrt(variance);
  const maxRecentTickStep = tickSteps.length ? Math.max(...tickSteps) : 0;

  // Volatility score: compare tick step to channel width
  let volatilityScore = 40;
  if (channelWidth && channelWidth > 0) {
    const stepRatio = (meanStep / channelWidth) * 100;
    const maxRatio = (maxRecentTickStep / channelWidth) * 100;
    volatilityScore = clamp(Math.round(stepRatio * 4 + maxRatio * 2), 10, 95);
  } else if (currentSpot > 0 && meanStep > 0) {
    volatilityScore = clamp(Math.round((meanStep / currentSpot) * 10000), 20, 85);
  }

  const reasons: string[] = [];

  // Barrier safety check
  let barrierSafety: 'SAFE' | 'BORDERLINE' | 'CRITICAL' = 'SAFE';
  if (hasCrossedBarrier) {
    barrierSafety = 'CRITICAL';
    reasons.push('Current spot has crossed accumulator barrier.');
  } else if (centerOffsetPercent > 75) {
    barrierSafety = 'CRITICAL';
    reasons.push(`Spot is dangerously skewed (${centerOffsetPercent}% towards barrier).`);
  } else if (centerOffsetPercent > 50 || volatilityScore > 65) {
    barrierSafety = 'BORDERLINE';
    reasons.push('Moderate proximity to barrier or elevated tick oscillation.');
  } else {
    barrierSafety = 'SAFE';
    reasons.push(`Spot is safely centered (${100 - centerOffsetPercent}% buffer inside channel).`);
  }

  if (volatilityScore <= 40) {
    reasons.push('Tick volatility is calm and controlled.');
  } else if (volatilityScore >= 70) {
    reasons.push('Erratic tick movement detected; increased knockout hazard.');
  }

  // Calculate survival probability and recommended ticks
  // In accumulators, typical target is 3-6 ticks before knockout probability compounds
  const survivalProbability = clamp(
    Math.round(100 - centerOffsetPercent * 0.4 - volatilityScore * 0.45 - (hasCrossedBarrier ? 90 : 0)),
    10,
    95
  );

  let recommendedTicks = 4;
  if (volatilityScore < 35 && centerOffsetPercent < 30) {
    recommendedTicks = 6;
  } else if (volatilityScore < 50 && centerOffsetPercent < 45) {
    recommendedTicks = 4;
  } else {
    recommendedTicks = 2;
  }

  // Final confidence rating
  let confidence = clamp(
    Math.round(survivalProbability * 0.7 + (100 - centerOffsetPercent) * 0.2 + (100 - volatilityScore) * 0.1),
    20,
    96
  );

  if (hasCrossedBarrier) {
    confidence = 15;
  }

  // Entry decision
  const entryDecision: 'ENTER' | 'WAIT' =
    !hasCrossedBarrier &&
    barrierSafety !== 'CRITICAL' &&
    centerOffsetPercent <= 58 &&
    volatilityScore <= 68 &&
    confidence >= 65
      ? 'ENTER'
      : 'WAIT';

  const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
    barrierSafety === 'CRITICAL' || volatilityScore > 70
      ? 'HIGH'
      : barrierSafety === 'BORDERLINE' || volatilityScore > 48
      ? 'MEDIUM'
      : 'LOW';

  let rationale = '';
  if (entryDecision === 'ENTER') {
    rationale = `Optimal Accumulator Entry: Spot is safely positioned with ${100 - centerOffsetPercent}% channel buffer and low tick turbulence (${volatilityScore}/100). Favorable condition for ${recommendedTicks}-tick accumulation.`;
  } else if (hasCrossedBarrier) {
    rationale = 'WAIT: Barrier breach detected. Awaiting contract reset.';
  } else if (barrierSafety === 'CRITICAL') {
    rationale = `WAIT: Spot is too close to the accumulator barrier (${centerOffsetPercent}% offset). Wait for mean-reversion toward channel center.`;
  } else if (volatilityScore > 65) {
    rationale = `WAIT: High tick volatility (${volatilityScore}/100) increases premature barrier knockout risk.`;
  } else {
    rationale = `WAIT: Accumulator market conditions currently marginal (Confidence ${confidence}%). Awaiting clearer safe channel stability.`;
  }

  return {
    entryDecision,
    confidence,
    barrierSafety,
    recommendedTicks,
    riskLevel,
    volatilityScore,
    rationale,
    reasons,
    metrics: {
      currentSpot,
      highBarrier: numHigh,
      lowBarrier: numLow,
      distanceToHigh,
      distanceToLow,
      channelWidth,
      centerOffsetPercent,
      barrierPercentage,
      volatilityStdDev,
      maxRecentTickStep,
      survivalProbability,
    },
  };
}
