# AI Scanner Setup

The Accumulator now includes a scanner overlay beneath the live chart. It keeps the latest 50 ticks for the active market, evaluates EMA(5), EMA(13), RSI(14), momentum, range, consolidation, confidence, and the number of ticks since the last EMA direction change. The scanner returns `WAIT` when history is insufficient, the market is consolidating, confidence is below the configured threshold, or the line has just changed.

## Gemini configuration

Add `GEMINI_API_KEY` as a server-side environment variable in the Vercel project. Do not put the key in `NEXT_PUBLIC_*` variables, frontend source files, browser storage, or committed files. The API route is `POST /api/ai-scanner` and uses the environment variable only on the server. If the key is missing, local deterministic analysis continues and the Gemini refresh action reports that the server key is unavailable.

Because the key was pasted into chat, rotate or regenerate it before using it in production. Do not reuse a key that may have been exposed.

## Scanner controls

The floating **AI scanner** control opens the side panel. The history table remains below the chart and shows up to 50 live ticks with timestamps, quotes, and direction changes. The panel includes a default 5% growth target, take-profit ticks, stop-loss ticks, minimum confidence, a Gemini analysis refresh, and a read-only multi-market watchlist.

The scanner starts in **Analysis only** mode. **Paper trade with confirmation** records a review decision without sending a live order. **Live entry after confirmation** invokes the existing Accumulator buy flow only after the user reviews and explicitly confirms the direction, recommended ticks, take-profit, and stop-loss values. It is not an unattended trading bot.

The stop-loss field is a scanner risk parameter and review guard. The existing Accumulator contract controls remain the authoritative place for supported contract parameters and manual closing. A live order may still be rejected by the broker, contract rules, account state, connectivity, or market conditions.

## Validation

Run:

```bash
pnpm install --no-frozen-lockfile
pnpm run build
```

The production build should include the static Accumulator pages and the dynamic `/api/ai-scanner` route.

## Limitations

The scanner is probabilistic and does not guarantee a win rate, profit, or correct market direction. Tick history is not a substitute for backtesting, slippage analysis, contract-specific validation, or a broker’s risk controls. Test with paper trading first and use position sizing that you can afford to lose.
