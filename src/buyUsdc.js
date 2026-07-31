/**
 * buyUsdc.js
 * ----------
 * Buy-USDC (NGN → USDC) conversation handler for Pajrate-bot.
 *
 * Flow (mirrors HeadlineOdds-Arena wallet:naira flow exactly):
 *   /buyusdc                      → show help + preset amount picker
 *   /buyusdc 5000                 → create order directly
 *   callback: buy:amount:<ngn>    → create order for preset amount
 *   callback: buy:custom          → prompt free-text amount entry
 *   callback: buy:back            → back to amount picker
 *   text message (pending state)  → parse custom amount → create order
 *
 * State is kept in a plain in-process Map (keyed by chatId). This is fine
 * for a single-process bot; swap for Redis if you need multi-instance.
 */

"use strict";

const { createOnramp } = require("./pajcash");
const { listRecentOnramps } = require("./db");

// ─── Limits (match HeadlineOdds-Arena exactly) ────────────────────────────────

const MIN_AMOUNT     = 1_000;
const MAX_AMOUNT     = 20_000;
const PRESET_AMOUNTS = [1_000, 2_000, 5_000, 10_000];

// ─── In-process pending-state store ──────────────────────────────────────────
// Maps chatId (number) → true when we are waiting for a custom amount text

const pendingCustomAmount = new Map();

function setPendingCustom(chatId) { pendingCustomAmount.set(chatId, true); }
function clearPending(chatId)     { pendingCustomAmount.delete(chatId); }
function hasPendingCustom(chatId) { return pendingCustomAmount.has(chatId); }

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtNgn(v) {
  const r = Math.round((v + Number.EPSILON) * 100) / 100;
  return `₦${r.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function fmtUsdc(v) {
  const r = Math.round((v + Number.EPSILON) * 1_000_000) / 1_000_000;
  return `${r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
}

function fmtNgnFull(v) {
  const r = Math.round((v + Number.EPSILON) * 100) / 100;
  return `NGN ${r.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ─── Message builders ─────────────────────────────────────────────────────────

function helpText() {
  return (
    `*FUND WITH NAIRA*\n\n` +
    `Transfer NGN via bank and receive USDC instantly.\n` +
    `Min: \`${fmtNgn(MIN_AMOUNT)}\`  ·  Max: \`${fmtNgn(MAX_AMOUNT)}\`\n\n` +
    `Pick an amount below or type \`/buyusdc <amount>\` e.g. \`/buyusdc 5000\``
  );
}

function amountPickerKeyboard() {
  return {
    inline_keyboard: [
      PRESET_AMOUNTS.slice(0, 3).map((a) => ({ text: fmtNgn(a), callback_data: `buy:amount:${a}` })),
      [
        { text: fmtNgn(PRESET_AMOUNTS[3]), callback_data: `buy:amount:${PRESET_AMOUNTS[3]}` },
        { text: "✏️ Custom", callback_data: "buy:custom" },
      ],
      [{ text: "📋 Recent orders", callback_data: "buy:history" }],
    ],
  };
}

function customAmountText() {
  return (
    `💵 *Custom amount*\n\n` +
    `Type any amount between \`${fmtNgn(MIN_AMOUNT)}\` and \`${fmtNgn(MAX_AMOUNT)}\`.\n` +
    `e.g. \`3500\` or \`₦3,500\``
  );
}

function customAmountKeyboard() {
  return {
    inline_keyboard: [
      PRESET_AMOUNTS.slice(0, 2).map((a) => ({ text: fmtNgn(a), callback_data: `buy:amount:${a}` })),
      PRESET_AMOUNTS.slice(2, 4).map((a) => ({ text: fmtNgn(a), callback_data: `buy:amount:${a}` })),
      [{ text: "← Back", callback_data: "buy:back" }],
    ],
  };
}

function orderText({ orderId, fiatAmount, expectedUsdcAmount, bankName, accountName, accountNumber }) {
  return (
    `💰 *NGN top-up order ready*\n\n` +
    `Send:           \`${fmtNgnFull(fiatAmount)}\`\n` +
    `You'll receive: \`~${fmtUsdc(expectedUsdcAmount)}\`\n\n` +
    `Transfer to:\n` +
    `  ${accountName}\n` +
    `  \`${accountNumber}\`  ·  ${bankName}\n\n` +
    `Reference: \`${orderId}\`\n\n` +
    `_Your balance updates automatically once USDC arrives._`
  );
}

function orderKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "💵 Top up again", callback_data: "buy:back" },
        { text: "📋 My orders",    callback_data: "buy:history" },
      ],
    ],
  };
}

function validationError(msg) {
  return `${msg}\nMin: \`${fmtNgn(MIN_AMOUNT)}\`  ·  Max: \`${fmtNgn(MAX_AMOUNT)}\``;
}

function parseAmount(text) {
  const cleaned = text.trim().replace(/ngn/gi, "").replace(/₦/g, "").replace(/,/g, "").replace(/\s+/g, "");
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function getAmountError(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return validationError("Enter a valid Naira amount.");
  if (amount < MIN_AMOUNT)  return validationError(`Minimum is \`${fmtNgn(MIN_AMOUNT)}\`.`);
  if (amount > MAX_AMOUNT)  return validationError(`Maximum is \`${fmtNgn(MAX_AMOUNT)}\`.`);
  return null;
}

// ─── Core: create order and reply ─────────────────────────────────────────────

/**
 * @param {import("node-telegram-bot-api")} bot
 * @param {number} chatId
 * @param {number} telegramId   user's Telegram ID (may differ from chatId in groups)
 * @param {number} amount       NGN
 * @param {string} recipientAddress  Solana wallet address that will receive USDC
 */
async function placeOrder(bot, chatId, telegramId, amount, recipientAddress) {
  clearPending(chatId);

  const order = await createOnramp(telegramId, amount, recipientAddress);

  await bot.sendMessage(
    chatId,
    orderText({
      orderId:            order.order_id,
      fiatAmount:         order.fiat_amount,
      expectedUsdcAmount: order.expected_usdc_amount,
      bankName:           order.bank_name    ?? "PAJ CASH",
      accountName:        order.account_name ?? "PAJ CASH",
      accountNumber:      order.account_number ?? "—",
    }),
    { parse_mode: "Markdown", reply_markup: orderKeyboard() }
  );
}

// ─── /buyusdc command handler ─────────────────────────────────────────────────

/**
 * Call from index.js:
 *   bot.onText(/^\/buyusdc(@\w+)?(\s+.*)?$/i, (msg) => handleBuyUsdcCommand(bot, msg, getWalletAddress));
 *
 * getWalletAddress(telegramId) must return the user's Solana address (or null).
 * For Pajrate-bot you can derive this from your store or prompt user to set one.
 */
async function handleBuyUsdcCommand(bot, msg, getWalletAddress) {
  const chatId     = msg.chat.id;
  const telegramId = msg.from?.id ?? chatId;
  clearPending(chatId);

  // Parse optional inline amount: /buyusdc 5000
  const parts = (msg.text ?? "").trim().split(/\s+/);
  const raw   = parts[1];

  if (raw) {
    const amount = parseAmount(raw);
    const err    = getAmountError(amount ?? 0);
    if (err || amount === null) {
      await bot.sendMessage(chatId, err ?? validationError("Enter a valid amount."), {
        parse_mode: "Markdown",
        reply_markup: amountPickerKeyboard(),
      });
      return;
    }

    const address = await getWalletAddress(telegramId);
    if (!address) {
      await bot.sendMessage(chatId, "⚠️ No Solana wallet address on file. Please set one first.", {
        parse_mode: "Markdown",
      });
      return;
    }

    try {
      await placeOrder(bot, chatId, telegramId, amount, address);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ ${err.message}`, { reply_markup: amountPickerKeyboard() });
    }
    return;
  }

  // No amount — show picker
  await bot.sendMessage(chatId, helpText(), {
    parse_mode: "Markdown",
    reply_markup: amountPickerKeyboard(),
  });
}

// ─── Callback query handler ───────────────────────────────────────────────────

/**
 * Returns true if the callback was handled (so caller can answer and stop propagation).
 *
 * Handles: buy:amount:<ngn>, buy:custom, buy:back, buy:history
 */
async function handleBuyUsdcCallback(bot, query, getWalletAddress) {
  const data     = query.data ?? "";
  const chatId   = query.message?.chat.id;
  const msgId    = query.message?.message_id;
  const userId   = query.from?.id;

  if (!chatId || !userId) return false;

  // buy:back — show picker again
  if (data === "buy:back") {
    clearPending(chatId);
    await bot.editMessageText(helpText(), {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown", reply_markup: amountPickerKeyboard(),
    }).catch(() =>
      bot.sendMessage(chatId, helpText(), { parse_mode: "Markdown", reply_markup: amountPickerKeyboard() })
    );
    return true;
  }

  // buy:custom — prompt free-text
  if (data === "buy:custom") {
    setPendingCustom(chatId);
    await bot.editMessageText(customAmountText(), {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown", reply_markup: customAmountKeyboard(),
    }).catch(() =>
      bot.sendMessage(chatId, customAmountText(), { parse_mode: "Markdown", reply_markup: customAmountKeyboard() })
    );
    return true;
  }

  // buy:history — show recent orders
  if (data === "buy:history") {
    try {
      const orders = await listRecentOnramps(userId, 4);
      if (!orders.length) {
        await bot.answerCallbackQuery(query.id, { text: "No orders yet." });
      } else {
        const lines = orders.map((o) => {
          const amt  = o.actual_usdc_amount > 0 ? o.actual_usdc_amount : o.expected_usdc_amount;
          const icon = o.status.toUpperCase() === "COMPLETED" ? "✅" : o.status.toUpperCase() === "FAILED" ? "❌" : "⏳";
          return `${icon}  \`₦${Math.round(o.fiat_amount).toLocaleString()}\`  →  \`${fmtUsdc(amt)}\`  [${o.status}]`;
        });
        await bot.sendMessage(chatId, `*Recent orders*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
      }
    } catch {
      await bot.answerCallbackQuery(query.id, { text: "Could not load history." });
    }
    return true;
  }

  // buy:amount:<ngn>
  if (data.startsWith("buy:amount:")) {
    const rawAmt = data.slice("buy:amount:".length);
    const amount = Number(rawAmt);
    const err    = getAmountError(amount);

    if (err) {
      await bot.answerCallbackQuery(query.id, { text: "Invalid amount." });
      return true;
    }

    const address = await getWalletAddress(userId);
    if (!address) {
      await bot.answerCallbackQuery(query.id, { text: "No wallet address on file." });
      await bot.sendMessage(chatId, "⚠️ No Solana wallet address on file. Please set one first.");
      return true;
    }

    await bot.answerCallbackQuery(query.id);
    try {
      await placeOrder(bot, chatId, userId, amount, address);
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ ${err.message}`, { reply_markup: amountPickerKeyboard() });
    }
    return true;
  }

  return false;
}

// ─── Text message handler (custom amount entry) ───────────────────────────────

/**
 * Call this before your other text handlers. Returns true if the message was consumed.
 */
async function handleBuyUsdcText(bot, msg, getWalletAddress) {
  const chatId   = msg.chat.id;
  const userId   = msg.from?.id ?? chatId;
  const text     = msg.text ?? "";

  if (text.startsWith("/") || !hasPendingCustom(chatId)) return false;

  const amount = parseAmount(text);

  if (amount === null) {
    await bot.sendMessage(chatId, customAmountText(), {
      parse_mode: "Markdown",
      reply_markup: customAmountKeyboard(),
    });
    return true;
  }

  const err = getAmountError(amount);
  if (err) {
    await bot.sendMessage(chatId, err, {
      parse_mode: "Markdown",
      reply_markup: customAmountKeyboard(),
    });
    return true;
  }

  const address = await getWalletAddress(userId);
  if (!address) {
    clearPending(chatId);
    await bot.sendMessage(chatId, "⚠️ No Solana wallet address on file. Please set one first.");
    return true;
  }

  try {
    await placeOrder(bot, chatId, userId, amount, address);
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ ${err.message}`, {
      parse_mode: "Markdown",
      reply_markup: customAmountKeyboard(),
    });
  }

  return true;
}

module.exports = {
  handleBuyUsdcCommand,
  handleBuyUsdcCallback,
  handleBuyUsdcText,
  hasPendingCustom,
};
