import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
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

type GeminiResult = {
  direction?: string;
  confidence?: number;
  recommendedTicks?: number;
  rationale?: string;
};

type GeminiError = {
  error?: { message?: string; status?: string };
};

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(text: string): GeminiResult | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned) as GeminiResult;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as GeminiResult;
    } catch {
      return null;
    }
  }
}

function upstreamMessage(status: number, payload: GeminiError): string {
  const message = payload.error?.message?.replace(/AIza[\w-]+/g, '[redacted]')?.slice(0, 240);
  if (status === 401 || status === 403) return 'Gemini rejected the server API key. Verify GEMINI_API_KEY is a valid Gemini API key and redeploy.';
  if (status === 429) return 'Gemini rate limit or quota reached. Try again shortly or check the Gemini project quota.';
  if (status === 404) return 'The configured Gemini model is unavailable for this API key. The server tried its compatible fallback models.';
  return message ? `Gemini API error: ${message}` : `Gemini API request failed with status ${status}.`;
}

async function callGemini(apiKey: string, model: string, prompt: string, structured: boolean) {
  const generationConfig = structured
    ? { temperature: 0.1, responseMimeType: 'application/json', responseSchema }
    : { temperature: 0.1, responseMimeType: 'application/json' };
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });
  const text = await response.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  return { response, payload: payload as GeminiError & { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } };
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
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
      'Return only valid JSON with direction, confidence, recommendedTicks, and rationale.',
      `Market: ${symbol}`,
      `Recent ticks: ${JSON.stringify(ticks)}`,
      `Deterministic context: ${JSON.stringify(body.localAnalysis ?? {})}`,
    ].join('\n');

    let lastFailure = 'Gemini did not return a usable analysis.';
    for (const model of MODELS) {
      for (const structured of [true, false]) {
        const { response, payload } = await callGemini(apiKey, model, prompt, structured);
        if (!response.ok) {
          lastFailure = upstreamMessage(response.status, payload);
          if (response.status === 401 || response.status === 403 || response.status === 429) {
            return NextResponse.json({ error: lastFailure }, { status: response.status === 429 ? 503 : 502 });
          }
          continue;
        }
        const text = payload.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('').trim();
        const result = text ? parseJson(text) : null;
        if (!result) {
          lastFailure = 'Gemini returned an unreadable analysis. Local analysis remains active.';
          continue;
        }
        const direction = result.direction === 'UP' || result.direction === 'DOWN' ? result.direction : 'WAIT';
        const confidence = Math.min(96, Math.max(40, Math.round(safeNumber(result.confidence, 40))));
        const recommendedTicks = Math.min(8, Math.max(2, Math.round(safeNumber(result.recommendedTicks, 4))));
        return NextResponse.json({
          direction: confidence >= 68 ? direction : 'WAIT',
          confidence,
          recommendedTicks,
          rationale: typeof result.rationale === 'string' ? result.rationale.slice(0, 500) : 'Evidence did not support a stronger conclusion.',
        });
      }
    }
    return NextResponse.json({ error: lastFailure }, { status: 502 });
  } catch {
    return NextResponse.json({ error: 'Invalid scanner request. Local analysis remains active.' }, { status: 400 });
  }
}
