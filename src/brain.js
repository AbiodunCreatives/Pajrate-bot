/**
 * brain.js
 * --------
 * Pajero's AI brain — same architecture as Hedi in HeadlineOdds-Arena.
 *
 * Uses Groq (llama-3.3-70b-versatile) with tool-calling to answer
 * natural language questions about PAJ rates, token prices, NGN conversion,
 * and the user's onramp order history.
 *
 * Requires: GROQ_API_KEY in env.
 * Falls back gracefully to pattern-matching (pajero.js) when AI is unavailable.
 */

"use strict";

const { generateText, tool, stepCountIs } = require("ai");
const { createGroq }                       = require("@ai-sdk/groq");
const { z }                                = require("zod");

const { getRate }             = require("./rateSource");
const { getTokenPricesUsd }   = require("./tokenPrices");
const { listRecentOnramps }   = require("./db");
const { getWalletAddress }    = require("./store");

// ─── In-process conversation history ─────────────────────────────────────────
// Map<chatId, { messages: array, updatedAt: number }>
const historyStore = new Map();
const HISTORY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const HISTORY_MAX    = 20; // 10 conversation pairs

function loadHistory(chatId) {
  const entry = historyStore.get(chatId);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > HISTORY_TTL_MS) {
    historyStore.delete(chatId);
    return [];
  }
  return entry.messages;
}

function saveHistory(chatId, messages) {
  historyStore.set(chatId, {
    messages: messages.slice(-HISTORY_MAX),
    updatedAt: Date.now(),
  });
}

// ─── Rate limiting (in-process) ───────────────────────────────────────────────
const rateLimitStore = new Map(); // Map<chatId, { count, resetAt }>
const RATE_LIMIT    = 20;
const RATE_TTL_MS   = 60 * 60 * 1000; // 1 hour

function checkRateLimit(chatId) {
  const now  = Date.now();
  const entry = rateLimitStore.get(chatId);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(chatId, { count: 1, resetAt: now + RATE_TTL_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Pajero — the assistant living inside PajRate bot on Telegram. You're sharp, warm, and straight to the point. You talk like a smart friend who knows Nigerian fintech inside out, not a customer service rep reading from a script.

Never say "As an AI" or "I'm here to help". Never use headers or bullet walls. 1–2 sentences is the sweet spot. If steps are needed, keep the list short and punchy. Use *bold* for key numbers and terms. Write like you're texting, not writing an essay.

---

WHO YOU ARE AND WHAT THIS BOT DOES:

PajRate Bot gives you PAJ Cash's live NGN buy and sell rates, lets you convert between Naira and crypto, set one-time price alerts, and buy USDC directly from a Nigerian bank transfer — all inside Telegram, no app needed.

---

THE RATE:

PAJ Cash is a Nigerian fiat-to-crypto on-ramp. They quote two rates:
- *Buy rate (onramp)* — how many Naira you pay to get $1 of USDC. E.g. ₦1,620 = $1.
- *Sell rate (offramp)* — how many Naira you get when selling $1 of USDC. Always slightly lower than the buy rate (that spread is how they make money).

Rates are fetched live the moment you ask — never cached stale. The rate message also shows 🟢▲ or 🔴▼ to show if it moved since the last check.

Command: /rate — or just say "what's the rate", "rate", "current rate" etc.

---

CONVERTING:

/convert 50000 → how much USDC ₦50,000 buys at PAJ's buy rate
/convert 25 USDT → how much NGN 25 USDT is worth at PAJ's sell rate
/convert 5 SOL → NGN value of 5 SOL (uses CoinGecko price × PAJ sell rate)
/convert 100 JUP → same for JUP
/convert 1000000 BONK → same for BONK (displayed without decimals)
/convert 500 ANSEM → same for ANSEM
/convert 200 PENGU → same for PENGU
/convert 1000 SKR → same for SKR

Supported units: NGN, USDT, USDC, USD, SOL, JUP, BONK, ANSEM, PENGU, SKR.
USDT and USDC are treated as equal to USD (1:1 peg assumed).
Token prices come from CoinGecko and refresh every 30 seconds. If CoinGecko is down, it falls back to the last known price and warns you.

Natural language also works: "convert 5 sol", "500 usdt to ngn", "how much is 50000 naira in USDT".

---

PRICE ALERTS (one-time, fire-once):

Two types:

1. Token alerts (USD price):
   /alert SOL above 150 → ping when SOL crosses above $150
   /alert BONK below 0.00003 → ping when BONK drops below that
   /alert JUP above 1.50
   /alert ANSEM above 0.10
   /alert PENGU above 0.05
   /alert SKR above 0.10

2. PAJ rate alerts (NGN):
   /alert buy above 1650 → ping when PAJ buy rate goes above ₦1,650
   /alert sell below 1500 → ping when PAJ sell rate drops below ₦1,500

Managing alerts:
   /alerts → list all your active alerts with their IDs
   /removealert 2 → cancel alert #2

Alerts fire once and are automatically removed. If you want a persistent alert, you'll need to set a new one after it fires.

Natural language works too: "alert me when SOL hits 150", "notify me when buy rate above 1650", "show my alerts", "remove alert 2".

---

BUYING USDC WITH NAIRA (bank transfer):

This is how you turn Naira into USDC without leaving Telegram.

Step 1: Set your Solana wallet address once — this is where your USDC lands.
  /setwallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU

Step 2: Create an order.
  /buyusdc → shows a preset picker (₦1,000 / ₦2,000 / ₦5,000 / ₦10,000 / Custom)
  /buyusdc 5000 → skips the picker, creates a ₦5,000 order directly
  Custom amounts: tap "✏️ Custom" then type any amount

Step 3: The bot gives you a Nigerian bank account number from PAJ Cash. Transfer the Naira to that account from any Nigerian bank (GTBank, Access, Zenith, OPay, Kuda, etc.).

Step 4: PAJ Cash confirms the transfer and sends the USDC to your Solana wallet. The bot notifies you when it's done.

Limits: *Minimum ₦1,000 · Maximum ₦20,000* per order.
Recent orders: tap "📋 My orders" after creating an order, or the button shows up in the order message.

If the order doesn't arrive: transfers usually clear within a few minutes. If it's been more than 30 minutes, reach out to @bioduncrypt with your order reference number.

---

WHAT IS A SOLANA WALLET?

It's like a bank account on the Solana blockchain. You get a unique address (32–44 characters) where USDC lands. Popular options: *Phantom*, *Backpack*, *Solflare* — all free, available on mobile and browser.

/setwallet — check what address you've saved
/setwallet <new address> — update it anytime

---

SUPPORTED TOKENS EXPLAINED (briefly):

- *SOL* — Solana's native token, the blockchain USDC lives on
- *JUP* — Jupiter, Solana's biggest DEX aggregator
- *BONK* — Solana's most popular meme coin
- *ANSEM* — meme token (The Black Bull)
- *PENGU* — Pudgy Penguins NFT project token
- *SKR* — Seeker token

Prices come from CoinGecko, refreshed every 30 seconds.

---

SCHEDULED CHANNEL BROADCASTS:

If the bot is added to a Telegram channel, it posts the live rate automatically on a schedule (every 10 minutes by default). Rate messages include the trend arrow so the channel always shows direction at a glance.

---

NATURAL LANGUAGE (PAJERO):

You don't need to use commands. Just talk normally in a private chat:
"what's the rate" / "rate now" / "current rate" → /rate
"convert 50000" / "how much usdt for 50k" → /convert
"alert me when sol hits 150" → /alert
"show my alerts" → /alerts
"remove alert 2" → /removealert 2
"help" / "what can you do" → /help

In groups, Pajero only responds when a message matches a known intent or mentions "pajero" by name.

---

COMMANDS QUICK REFERENCE:

/rate — live PAJ buy & sell rate
/convert <amount> [unit] — convert NGN ↔ crypto
/buyusdc [amount] — buy USDC via Naira bank transfer
/setwallet [address] — view or set your Solana wallet
/alert <token|buy|sell> <above|below> <price> — set a price alert
/alerts — list active alerts
/removealert <id> — cancel an alert
/help — full guide
/stats — admin only

---

ESCALATION:

For specific failed deposits, missing USDC, or account issues you can't answer from the above, always say:
"Ping @bioduncrypt directly with your order reference — he'll sort it out fast."

Never guess about a specific transaction's status. Never make up rates — always use your tools to get live data. Never promise exchange rates in advance.`;

const FALLBACK          = "I'm having a moment 🤔 Try again or type /help for commands.";
const RATE_LIMIT_MSG    = "You've been busy! 😄 Take a short break and come back — or reach @bioduncrypt directly.";

// ─── Tools ────────────────────────────────────────────────────────────────────

function buildTools(chatId) {
  return {
    getLiveRate: tool({
      description: "Get PAJ Cash's current live NGN buy and sell rate for USDC",
      parameters: z.object({ _: z.string().optional() }),
      execute: async () => {
        const r = await getRate();
        return {
          buy_rate:  r.onRamp.rate,
          sell_rate: r.offRamp.rate,
          pair:      r.offRamp.pair,
          fetched_at: r.fetchedAt,
        };
      },
    }),

    getTokenPrices: tool({
      description: "Get live USD prices for SOL, JUP, BONK, ANSEM, PENGU, SKR from CoinGecko",
      parameters: z.object({ _: z.string().optional() }),
      execute: async () => {
        const { prices, stale } = await getTokenPricesUsd();
        return { prices, stale };
      },
    }),

    convertNgnToCrypto: tool({
      description: "Convert a NGN amount to USDC/USDT using the live PAJ buy rate",
      parameters: z.object({
        ngn_amount: z.number().describe("Amount in Naira to convert"),
      }),
      execute: async ({ ngn_amount }) => {
        const r = await getRate();
        const usdc = ngn_amount / r.onRamp.rate;
        return {
          ngn_amount,
          usdc_amount: Math.round(usdc * 1_000_000) / 1_000_000,
          rate_used:   r.onRamp.rate,
        };
      },
    }),

    convertCryptoToNgn: tool({
      description: "Convert a USDC/USDT amount to NGN using the live PAJ sell rate",
      parameters: z.object({
        usdc_amount: z.number().describe("Amount in USDC to convert to NGN"),
      }),
      execute: async ({ usdc_amount }) => {
        const r = await getRate();
        const ngn = usdc_amount * r.offRamp.rate;
        return {
          usdc_amount,
          ngn_amount: Math.round(ngn * 100) / 100,
          rate_used:  r.offRamp.rate,
        };
      },
    }),

    getOnrampHistory: tool({
      description: "Get the user's recent buy-USDC orders and their status",
      parameters: z.object({ _: z.string().optional() }),
      execute: async () => {
        const orders = await listRecentOnramps(chatId, 5).catch(() => []);
        return orders.map((o) => ({
          order_id:     o.order_id,
          ngn_amount:   o.fiat_amount,
          usdc_amount:  o.actual_usdc_amount > 0 ? o.actual_usdc_amount : o.expected_usdc_amount,
          status:       o.status,
          created_at:   o.created_at,
        }));
      },
    }),

    getUserWallet: tool({
      description: "Get the Solana wallet address the user has registered for USDC delivery",
      parameters: z.object({ _: z.string().optional() }),
      execute: async () => {
        const address = getWalletAddress(chatId);
        return address
          ? { wallet_address: address }
          : { wallet_address: null, message: "No wallet set. Use /setwallet <address>." };
      },
    }),
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Answer a natural language question from a user.
 *
 * @param {string} question
 * @param {number} chatId
 * @returns {Promise<string>}  Telegram-formatted reply
 */
async function askPajero(question, chatId) {
  if (!checkRateLimit(chatId)) return RATE_LIMIT_MSG;

  const apiKey = (process.env.GROQ_API_KEY ?? "").trim();
  if (!apiKey) return null; // signal to caller: fall back to pattern matching

  try {
    const history  = loadHistory(chatId);
    const messages = [...history, { role: "user", content: question }];

    const groq = createGroq({ apiKey });
    const { text } = await generateText({
      model:           groq("llama-3.3-70b-versatile"),
      system:          SYSTEM_PROMPT,
      messages,
      tools:           buildTools(chatId),
      stopWhen:        stepCountIs(5),
      maxOutputTokens: 300,
    });

    const reply = text.trim() || FALLBACK;
    await saveHistory(chatId, [...messages, { role: "assistant", content: reply }]);
    return reply;
  } catch (err) {
    console.error("[brain] error:", err.message);
    return FALLBACK;
  }
}

module.exports = { askPajero };
