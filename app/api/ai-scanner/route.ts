import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { analyzeAccumulatorMarket, type AccumulatorAiDecision } from '@/lib/ai-accumulator-engine';

export const runtime = 'nodejs';

const responseSchema = {
  type: 'OBJECT',
  properties: {
    entryDecision: { type: 'STRING', enum: ['ENTER', 'WAIT'] },
    confidence: { type: 'NUMBER' },
    barrierSafety: { type: 'STRING', enum: ['SAFE', 'BORDERLINE', 'CRITICAL'] },
    recommendedTicks: { type: 'INTEGER' },
    riskLevel: { type: 'STRING', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    volatilityScore: { type: 'NUMBER' },
    rationale: { type: 'STRING' },
  },
  required: ['entryDecision', 'confidence', 'barrierSafety', 'recommendedTicks', 'riskLevel', 'volatilityScore', 'rationale'],
};

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      symbol?: string;
      spot?: number;
      ticks?: Array<{ epoch: number; quote: number }>;
      highBarrier?: string | number;
      lowBarrier?: string | number;
      barrierPercentage?: string;
      hasCrossedBarrier?: boolean;
      growthRate?: number;
    };

    const symbol = typeof body.symbol === 'string' ? body.symbol : 'R_100';
    const spot = Number(body.spot) || 0;
    const ticks = Array.isArray(body.ticks) ? body.ticks : [];
    const highBarrier = body.highBarrier;
    const lowBarrier = body.lowBarrier;
    const barrierPercentage = body.barrierPercentage;
    const hasCrossedBarrier = Boolean(body.hasCrossedBarrier);
    const growthRate = Number(body.growthRate) || 0.01;

    // Run deterministic accumulator engine
    const localAnalysis: AccumulatorAiDecision = analyzeAccumulatorMarket({
      symbol,
      spot,
      ticks,
      highBarrier,
      lowBarrier,
      barrierPercentage,
      hasCrossedBarrier,
      growthRate,
    });

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      // Return high-fidelity local engine analysis when API key is not configured
      return NextResponse.json({
        ...localAnalysis,
        engineSource: 'local_math_engine',
      });
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const prompt = `You are an elite quantitative AI Trading Assistant specializing in Deriv Accumulator contracts.
In Deriv Accumulators, the trader earns compound growth on each tick (e.g. ${(growthRate * 100).toFixed(0)}%) as long as the price stays STRICTLY BETWEEN the upper barrier and lower barrier. Knockout (total loss) occurs if a tick breaches either barrier.

Market Data:
- Symbol: ${symbol}
- Current Spot: ${spot || localAnalysis.metrics.currentSpot}
- High Barrier: ${highBarrier || 'N/A'}
- Low Barrier: ${lowBarrier || 'N/A'}
- Barrier Band: ${barrierPercentage || 'N/A'}
- Barrier Safety: ${localAnalysis.barrierSafety}
- Spot Offset from Channel Center: ${localAnalysis.metrics.centerOffsetPercent}%
- Tick Volatility Score: ${localAnalysis.volatilityScore}/100
- Recent Ticks: ${JSON.stringify(ticks.slice(-20).map(t => Number(t.quote).toFixed(4)))}
- Has Barrier Crossed: ${hasCrossedBarrier}

Requirements:
1. Recommend entryDecision = "ENTER" ONLY when price is safely centered within the barrier channel and tick volatility is low/stable, making it safe to accumulate ticks.
2. Recommend entryDecision = "WAIT" if spot is skewed close to either barrier, or if tick movement shows volatility spikes.
3. Recommend a realistic duration of 2 to 6 ticks to target safe profit taking.
4. Provide a clear rationale explaining barrier clearance and volatility.
Return JSON matching the schema.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema,
        },
      });

      const responseText = response.text?.trim() || '';
      if (responseText) {
        const parsed = JSON.parse(responseText) as Partial<AccumulatorAiDecision>;
        return NextResponse.json({
          entryDecision: parsed.entryDecision === 'ENTER' && !hasCrossedBarrier ? 'ENTER' : 'WAIT',
          confidence: Math.min(98, Math.max(15, Math.round(Number(parsed.confidence) || localAnalysis.confidence))),
          barrierSafety: parsed.barrierSafety || localAnalysis.barrierSafety,
          recommendedTicks: Math.min(8, Math.max(2, Math.round(Number(parsed.recommendedTicks) || localAnalysis.recommendedTicks))),
          riskLevel: parsed.riskLevel || localAnalysis.riskLevel,
          volatilityScore: Math.min(100, Math.max(0, Math.round(Number(parsed.volatilityScore) || localAnalysis.volatilityScore))),
          rationale: parsed.rationale || localAnalysis.rationale,
          reasons: localAnalysis.reasons,
          metrics: localAnalysis.metrics,
          engineSource: 'gemini_3.8_flash',
        });
      }
    } catch {
      // Fallback to local engine if upstream call fails
    }

    return NextResponse.json({
      ...localAnalysis,
      engineSource: 'local_math_engine',
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Analysis failed' },
      { status: 500 }
    );
  }
}
