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

const { generateText, tool } = require("ai");
const { createGroq }                       = require("@ai-sdk/groq");
const { z }                                = require("zod");

const { getRate }             = require("./rateSource");
const { getTokenPricesUsd }   = require("./tokenPrices");
const { listRecentOnramps }   = require("./db");
const { getWalletAddress }    = require("./db");

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

const SYSTEM_PROMPT = `You are Pajero — the assistant inside PajRate bot on Telegram. Sharp, warm, straight to the point. Talk like a smart friend who knows Nigerian fintech, not a customer service rep.

Never say "As an AI". Never use headers or bullet walls. 1–2 sentences is the sweet spot. Use *bold* for key numbers. Write like you're texting.

WHAT THIS BOT DOES:
- Live PAJ Cash NGN buy/sell rates for USDC (/rate)
- Convert NGN ↔ USDT/USDC/SOL/JUP/BONK/ANSEM/PENGU/SKR (/convert)
- One-time price alerts for tokens (USD) or PAJ rates (NGN) (/alert)
- Buy USDC via Nigerian bank transfer, delivered to Solana wallet (/buyusdc)
- Set Solana wallet address (/setwallet)

KEY FACTS:
- Buy rate = NGN per $1 USDC (onramp). Sell rate = NGN per $1 USDC (offramp, slightly lower).
- Token prices from CoinGecko, refreshed every 30s.
- Buy USDC limits: min ₦1,000, max ₦20,000. Set wallet first with /setwallet.
- Alerts fire once then are removed. /alerts to list, /removealert <id> to cancel.
- For failed deposits or missing USDC: tell user to ping @bioduncrypt with their order reference.

Always use your tools to get live data. Never guess rates or prices.`;


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
        const address = await getWalletAddress(chatId);
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
      model:           groq("llama-3.1-8b-instant"),
      system:          SYSTEM_PROMPT,
      messages,
      tools:           buildTools(chatId),
      maxSteps:        3,
      maxTokens:       150,
    });

    const reply = text.trim() || FALLBACK;
    await saveHistory(chatId, [...messages, { role: "assistant", content: reply }]);
    return reply;
  } catch (err) {
    console.error("[brain] error:", err.message);
    return null; // signal caller to fall back to pattern matching
  }
}

module.exports = { askPajero };
