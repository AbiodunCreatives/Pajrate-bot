# PajRate Bot

Live PAJ Cash rates, crypto conversion, price alerts, and USDC onramp — all inside Telegram.

## What it does

- **Live rates** — PAJ Cash's current NGN buy (onramp) and sell (offramp) rates, fetched the moment you ask
- **Convert** — flip between Naira and crypto at the live rate
- **Price alerts** — one-time alerts for token prices (USD) or PAJ rates (NGN)
- **Buy USDC** — turn Naira into USDC via Nigerian bank transfer, delivered straight to your Solana wallet
- **Pajero AI** — natural language assistant powered by Groq (llama-3.3-70b), with conversation memory and live tool access. Falls back to regex-based pattern matching if no API key is set.
- **Scheduled broadcasts** — auto-posts the live rate to a Telegram channel on a cron schedule

## Commands

| Command | Description |
|---|---|
| `/rate` | Live PAJ buy & sell rate |
| `/convert <amount> [unit]` | Convert between NGN and crypto |
| `/buyusdc [amount]` | Buy USDC with Naira via bank transfer |
| `/setwallet [address]` | View or set your Solana wallet for USDC delivery |
| `/alert <token\|buy\|sell> <above\|below> <price>` | Set a one-time price alert |
| `/alerts` | List your active alerts |
| `/removealert <id>` | Cancel an alert by ID |
| `/help` | Full command guide |
| `/stats` | Admin only — total user count |

## /convert examples

```
/convert 50000          → how much USDT ₦50,000 buys (at buy rate)
/convert 25 USDT        → how much NGN 25 USDT is worth (at sell rate)
/convert 5 SOL          → NGN value of 5 SOL
/convert 100 JUP        → NGN value of 100 JUP
/convert 1000000 BONK   → NGN value of 1M BONK
/convert 500 ANSEM      → NGN value of 500 ANSEM
/convert 200 PENGU      → NGN value of 200 PENGU
/convert 1000 SKR       → NGN value of 1,000 SKR
```

Supported units: `NGN`, `USDT`, `USDC`, `USD`, `SOL`, `JUP`, `BONK`, `ANSEM`, `PENGU`, `SKR`

Token prices (SOL, JUP, BONK, ANSEM, PENGU, SKR) come from CoinGecko, cached for 30 seconds.

## /alert examples

**Token alerts (USD price):**
```
/alert SOL above 150          → ping when SOL > $150
/alert BONK below 0.00003     → ping when BONK drops
/alert JUP above 1.50
/alert ANSEM above 0.10
/alert PENGU above 0.05
/alert SKR above 0.10
```

**PAJ rate alerts (NGN):**
```
/alert buy above 1650         → ping when buy rate > ₦1,650
/alert sell below 1500        → ping when sell rate < ₦1,500
```

Alerts fire once and are automatically removed.

## Buying USDC (NGN onramp)

1. Set your Solana wallet once: `/setwallet <address>`
2. Create an order: `/buyusdc` (preset picker) or `/buyusdc 5000` (direct)
3. Transfer Naira to the Nigerian bank account the bot gives you
4. PAJ Cash confirms and sends USDC to your wallet — the bot notifies you when it's done

**Limits: ₦1,000 minimum · ₦20,000 maximum per order**

## Pajero — natural language

You don't need to use commands. Just talk:

```
"what's the rate"
"convert 5 sol"
"convert 50000"
"alert me when SOL hits 150"
"notify me when buy rate above 1650"
"show my alerts"
"remove alert 2"
```

In private chats, Pajero responds to everything. In groups, it only responds when a message matches a known intent or mentions "pajero" by name.

**AI brain (Groq):** When `GROQ_API_KEY` is set, Pajero uses llama-3.3-70b-versatile with tool-calling for live rate/price data and per-user conversation memory (20-message history, 2-hour TTL, 20 req/hour rate limit). Without the key, it falls back to regex pattern matching — no AI needed for core functionality.

## Rate message format

Each rate update shows:
- 📥 Buy rate (onramp) — NGN per $1 USDC
- 📤 Sell rate (offramp) — NGN per $1 USDC
- 🟢▲ / 🔴▼ movement since last check
- Time fetched (WAT)

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from BotFather |
| `GROQ_API_KEY` | optional | Enables Pajero AI brain (Groq) |
| `TELEGRAM_CHANNEL_ID` | optional | Channel to broadcast scheduled rate updates |
| `CRON_SCHEDULE` | optional | Broadcast schedule (default: `*/10 * * * *`) |
| `ADMIN_CHAT_ID` | optional | Chat ID allowed to use `/stats` |
| `PORT` | optional | Health check server port (default: `8080`) |

See `.env.example` for the full list.

## Stack

- Node.js + [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api)
- [Vercel AI SDK](https://sdk.vercel.ai) + [@ai-sdk/groq](https://sdk.vercel.ai/providers/ai-sdk-providers/groq) for the AI brain
- [Zod](https://zod.dev) for tool parameter validation
- [node-cron](https://github.com/node-cron/node-cron) for scheduled broadcasts
- [Express](https://expressjs.com) for the health check server and PajCash webhook
- Deployed on [Fly.io](https://fly.io)

## Running locally

```bash
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN and any optional vars

npm install
node src/index.js
```

## Deploying to Fly.io

```bash
fly launch   # first time
fly deploy   # updates
fly secrets set TELEGRAM_BOT_TOKEN=... GROQ_API_KEY=...
```
