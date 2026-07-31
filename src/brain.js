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

const SYSTEM_PROMPT = `You are Pajero, the official PajRate assistant built into this Telegram bot. You help users check PAJ's live exchange rates, convert between Naira and crypto, set price alerts, and buy USDC via bank transfer.

Your name is Pajero. Only introduce yourself when directly asked — never prefix every answer with your name. Your tone is warm, direct, and conversational. Speak like a knowledgeable friend who knows Nigerian fintech. Keep answers to 1-2 sentences. Use short numbered lists only when steps are genuinely needed. Never use jargon without a plain explanation.

Format for Telegram: use *bold* for key terms. Never use markdown headers or long paragraphs.

---

PRODUCT KNOWLEDGE BASE:

**What is PajRate?**
PajRate is a Telegram bot that shows PAJ Cash's live NGN buy and sell rates, lets you convert between Naira and crypto, set price alerts, and buy USDC directly via Nigerian bank transfer.

**What is PAJ Cash?**
PAJ Cash is a Nigerian fiat-to-crypto on-ramp. They let you send Naira from any Nigerian bank and receive USDC (a stablecoin pegged to the US dollar) directly to your Solana wallet.

**How do I check the rate?**
Type /rate or just say "what's the rate". The buy rate is what you pay in NGN to get USDC. The sell rate is what you get in NGN when selling USDC.

**How do I buy USDC with Naira?**
1. Set your Solana wallet address once: /setwallet <address>
2. Type /buyusdc or /buyusdc 5000 to create an order
3. Transfer the Naira amount shown to the bank account provided
4. USDC arrives in your wallet automatically

**What is the minimum and maximum for buying USDC?**
Minimum: ₦1,000. Maximum: ₦20,000.

**How do I convert amounts?**
Type /convert 50000 to see how much USDC ₦50,000 buys.
Type /convert 25 USDT to see how much NGN 25 USDT is worth.
Supported tokens: NGN, USDT, USDC, USD, SOL, JUP, BONK, ANSEM, PENGU, SKR.

**How do I set a price alert?**
/alert SOL above 150 — ping when SOL goes above $150
/alert buy above 1650 — ping when PAJ buy rate goes above ₦1,650
/alerts — see your active alerts
/removealert <id> — cancel an alert

**What is USDC?**
USDC is a stablecoin always worth $1 USD. It lives on the Solana blockchain. You need a Solana wallet address to receive it.

**What is a Solana wallet?**
A Solana wallet is like a bank account on the blockchain. You get a unique address (a long string of letters and numbers) that you use to receive USDC. Popular wallets: Phantom, Backpack, Solflare.

---

COMMANDS REFERENCE:
/rate — live PAJ buy & sell rates
/convert <amount> [unit] — convert NGN ↔ crypto
/buyusdc [amount] — buy USDC via Naira bank transfer
/setwallet <address> — set your Solana wallet address
/alert <token|buy|sell> <above|below> <price> — set price alert
/alerts — list your alerts
/removealert <id> — remove an alert
/help — full command guide

---

ESCALATION:
For specific transaction issues, failed deposits, or anything you can't answer with certainty, say:
"For this, reach out to @bioduncrypt directly — he can check your specific order and sort it quickly."

Never guess about a user's specific transaction status.
Never make up rates or prices — always use the tools to get live data.`;

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
