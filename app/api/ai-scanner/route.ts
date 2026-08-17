import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const responseSchema = {
  type: 'OBJECT',
  properties: {
    direction: { type: 'STRING', enum: ['UP', 'DOWN', 'WAIT'] },
    confidence: { type: 'NUMBER' },
    recommendedTicks: { type: 'INTEGER' },
    rationale: { type: 'STRING' },
  },
  required: ['direction', 'confidence', 'recommendedTicks', 'rationale'],
};

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY is not configured on the server.' }, { status: 503 });

  try {
    const body = await request.json() as {
      symbol?: unknown;
      ticks?: unknown;
      localAnalysis?: Record<string, unknown>;
    };
    const symbol = typeof body.symbol === 'string' ? body.symbol.slice(0, 40) : '';
    const ticks = Array.isArray(body.ticks)
      ? body.ticks.slice(-50).map(tick => ({ epoch: safeNumber((tick as Record<string, unknown>)?.epoch), quote: safeNumber((tick as Record<string, unknown>)?.quote) })).filter(tick => tick.quote > 0)
      : [];
    if (!symbol || ticks.length < 10) return NextResponse.json({ error: 'At least 10 valid ticks and a market symbol are required.' }, { status: 400 });

    const prompt = [
      'You are a cautious market-analysis assistant for an accumulator trading interface.',
      'Use the deterministic scanner context and recent ticks as evidence, but do not claim certainty, profitability, or a guaranteed win rate.',
      'Return WAIT whenever the evidence is mixed, the market is consolidating, momentum conflicts with the EMA direction, or confidence is below 68.',
      'Recommend a bounded duration of 2 to 8 ticks only when a directional entry is supported.',
      `Market: ${symbol}`,
      `Recent ticks: ${JSON.stringify(ticks)}`,
      `Deterministic context: ${JSON.stringify(body.localAnalysis ?? {})}`,
    ].join('\n');

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema,
        },
      }),
    });
    if (!response.ok) return NextResponse.json({ error: 'Gemini analysis request failed.' }, { status: 502 });

    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return NextResponse.json({ error: 'Gemini returned no structured analysis.' }, { status: 502 });
    const result = JSON.parse(text) as { direction?: string; confidence?: number; recommendedTicks?: number; rationale?: string };
    const direction = result.direction === 'UP' || result.direction === 'DOWN' ? result.direction : 'WAIT';
    const confidence = Math.min(96, Math.max(40, Math.round(safeNumber(result.confidence, 40))));
    const recommendedTicks = Math.min(8, Math.max(2, Math.round(safeNumber(result.recommendedTicks, 4))));
    return NextResponse.json({
      direction: confidence >= 68 ? direction : 'WAIT',
      confidence,
      recommendedTicks,
      rationale: typeof result.rationale === 'string' ? result.rationale.slice(0, 500) : 'Evidence did not support a stronger conclusion.',
    });
  } catch {
    return NextResponse.json({ error: 'Invalid scanner request or malformed Gemini response.' }, { status: 400 });
  }
}
