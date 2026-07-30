/**
 * pajero.js
 * ---------
 * Pajero — the conversational agent for PajRate.
 *
 * Handles natural language messages and maps them to bot actions.
 * Users can interact without knowing any command syntax.
 *
 * Supported intents:
 *   greeting     — "hi", "hello pajero", "hey"
 *   rate         — "what's the rate", "show rate", "rate"
 *   convert      — "convert 50000", "convert 5 sol", "500 usdt to ngn"
 *   alert set    — "alert me when sol hits 150", "notify when buy above 1650"
 *   alert list   — "show my alerts", "my alerts"
 *   alert remove — "remove alert 2", "cancel alert 3"
 *   help         — "help", "what can you do"
 */

const { getRate }                          = require("./rateSource");
const { formatRateMessage }                = require("./formatMessage");
const { convert }                          = require("./convert");
const { addPajAlert, addTokenAlert,
        listAlerts, removeAlert,
        formatAlertLine }                  = require("./alerts");
const { formatNgn, formatUsd, normalizeUnit, CRYPTO_TOKENS } = require("./rateUtils");

// ─── Intent patterns ──────────────────────────────────────────────────────────

const INTENTS = [
  // Greeting: "hi", "hello", "hey pajero", etc.
  {
    name: "greeting",
    pattern: /^(hi|hello|hey|hiya|sup|yo)(\s+(pajero|pajrate|bot))?[!.\s]*$/i,
  },
  // Rate: "rate", "what's the rate", "show rate", "current rate"
  {
    name: "rate",
    pattern: /\b(rate|rates|current rate|live rate|what.?s the rate|show rate)\b/i,
  },
  // Convert with amount + optional unit: "convert 500 usdt", "500 sol to ngn", "convert 50000"
  {
    name: "convert",
    pattern: /(?:convert\s+)?([\d,]+(?:\.\d+)?)\s*(sol|jup|bonk|ansem|pengu|skr|usdt|usdc|usd|ngn|naira)?(?:\s+to\s+(ngn|usdt|sol|jup|bonk|ansem|pengu|skr))?/i,
  },
  // Alert set — token: "alert when sol hits 150", "notify me when bonk reaches 0.00003"
  {
    name: "alert_token",
    pattern: /(?:alert|notify|ping)(?:\s+me)?(?:\s+when)?\s+(sol|jup|bonk|ansem|pengu|skr)\s+(?:hits?|reaches?|goes?|is|above|below|crosses?|>|<)\s*(above|below|over|under)?\s*([\d.,]+)/i,
  },
  // Alert set — PAJ rate: "alert when buy rate above 1650", "notify sell below 1500"
  {
    name: "alert_paj",
    pattern: /(?:alert|notify|ping)(?:\s+me)?(?:\s+when)?\s+(buy|sell)(?:\s+rate)?\s*(above|below|over|under|hits?|>|<)\s*([\d.,]+)/i,
  },
  // Alert list: "my alerts", "show alerts", "list alerts"
  {
    name: "alert_list",
    pattern: /\b(my alerts?|show alerts?|list alerts?|active alerts?|see alerts?)\b/i,
  },
  // Alert remove: "remove alert 2", "cancel alert 3", "delete alert 1"
  {
    name: "alert_remove",
    pattern: /(?:remove|cancel|delete)\s+alert\s+#?(\d+)/i,
  },
  // Help: "help", "what can you do", "commands"
  {
    name: "help",
    pattern: /\b(help|what can you do|commands?|menu)\b/i,
  },
];

// Normalise direction words → "above" | "below"
function normalizeDirection(word) {
  if (!word) return "above";
  const w = word.toLowerCase();
  if (["above", "over", ">", "hits", "hit", "reaches", "reach", "crosses", "cross", "is"].includes(w)) return "above";
  if (["below", "under", "<"].includes(w)) return "below";
  return w;
}

// ─── Intent handlers ──────────────────────────────────────────────────────────

async function handleGreeting(bot, msg) {
  const firstName = msg.from?.first_name || "there";
  await bot.sendMessage(
    msg.chat.id,
    `👋 Hey ${firstName}\\! I'm *Pajero*, your PAJ assistant\\.\n\n` +
    `Just talk to me naturally\\. For example:\n\n` +
    `  _"what's the rate"_\n` +
    `  _"convert 500 usdt"_\n` +
    `  _"convert 5 sol"_\n` +
    `  _"alert me when sol hits 150"_\n` +
    `  _"show my alerts"_\n\n` +
    `Or type /help for the full command list\\.`,
    { parse_mode: "MarkdownV2" }
  );
}

async function handleRate(bot, msg) {
  try {
    const rateData = await getRate();
    await bot.sendMessage(msg.chat.id, formatRateMessage(rateData), { parse_mode: "Markdown" });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `⚠️ Couldn't fetch the rate right now. Try again in a moment.`);
  }
}

async function handleConvert(bot, msg, match) {
  const rawAmount = match[1].replace(/,/g, "");
  const amount    = parseFloat(rawAmount);
  const rawUnit   = match[2] || null; // may be undefined if no unit given

  if (!Number.isFinite(amount) || amount <= 0) {
    await bot.sendMessage(msg.chat.id, `⚠️ That doesn't look like a valid amount. Try: _"convert 50000"_ or _"convert 5 SOL"_`, { parse_mode: "Markdown" });
    return;
  }

  try {
    const rateData = await getRate();
    const result   = await convert(amount, rawUnit, rateData);

    if (result.error) {
      await bot.sendMessage(msg.chat.id, `⚠️ ${result.error}`, { parse_mode: "Markdown" });
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      `🔄 *Conversion*\n\n  ${result.input}  →  *${result.output}*\n\n${result.rateLine}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `⚠️ Couldn't fetch the rate right now. Try again in a moment.`);
  }
}

async function handleAlertToken(bot, msg, match) {
  const token     = match[1].toUpperCase();
  const direction = normalizeDirection(match[2] || "above");
  const price     = parseFloat(match[3].replace(/,/g, ""));

  if (!Number.isFinite(price) || price <= 0) {
    await bot.sendMessage(msg.chat.id, `⚠️ Couldn't parse that price. Try: _"alert me when SOL hits 150"_`, { parse_mode: "Markdown" });
    return;
  }

  const alert = addTokenAlert({ chatId: msg.chat.id, token, direction, price });
  await bot.sendMessage(
    msg.chat.id,
    `🔔 *Alert Set!*\n\nI'll ping you when *${token}* goes *${direction} ${formatUsd(price)}*.\n\n_Alert #${alert.id} · Say "show my alerts" to manage_`,
    { parse_mode: "Markdown" }
  );
}

async function handleAlertPaj(bot, msg, match) {
  const rateType  = match[1].toLowerCase();
  const direction = normalizeDirection(match[2]);
  const price     = parseFloat(match[3].replace(/,/g, ""));

  if (!Number.isFinite(price) || price <= 0) {
    await bot.sendMessage(msg.chat.id, `⚠️ Couldn't parse that price. Try: _"alert me when buy rate above 1650"_`, { parse_mode: "Markdown" });
    return;
  }

  const alert     = addPajAlert({ chatId: msg.chat.id, direction, price, rateType });
  const rateLabel = rateType === "buy" ? "Buy" : "Sell";
  await bot.sendMessage(
    msg.chat.id,
    `🔔 *Alert Set!*\n\nI'll ping you when the *${rateLabel}* rate goes *${direction} ${formatNgn(price)}*.\n\n_Alert #${alert.id} · Say "show my alerts" to manage_`,
    { parse_mode: "Markdown" }
  );
}

async function handleAlertList(bot, msg) {
  const alerts = listAlerts(msg.chat.id);

  if (!alerts.length) {
    await bot.sendMessage(
      msg.chat.id,
      `📭 *No active alerts.*\n\nTry saying:\n  _"alert me when SOL hits 150"_\n  _"alert me when buy rate above 1650"_`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const lines = alerts.map((a) => `  ${formatAlertLine(a)}`);
  await bot.sendMessage(
    msg.chat.id,
    `📋 *Your Active Alerts*\n\n${lines.join("\n")}\n\nSay _"remove alert 2"_ to cancel one.`,
    { parse_mode: "Markdown" }
  );
}

async function handleAlertRemove(bot, msg, match) {
  const id      = parseInt(match[1], 10);
  const removed = removeAlert(msg.chat.id, id);
  await bot.sendMessage(
    msg.chat.id,
    removed
      ? `✅ Alert #${id} has been removed.`
      : `⚠️ No alert with ID #${id} found. Say _"show my alerts"_ to see your active ones.`,
    { parse_mode: "Markdown" }
  );
}

async function handleHelp(bot, msg) {
  await bot.sendMessage(
    msg.chat.id,
    `ℹ️ *Here's what I can do:*\n\n` +
    `Just talk to me naturally:\n\n` +
    `  _"what's the rate"_\n` +
    `  _"convert 50000"_ — NGN → USDT\n` +
    `  _"convert 25 usdt"_ — USDT → NGN\n` +
    `  _"convert 5 sol"_ — SOL → NGN\n` +
    `  _"convert 100 jup"_ — JUP → NGN\n` +
    `  _"convert 1000000 bonk"_ — BONK → NGN\n` +
    `  _"convert 500 ansem"_ — ANSEM → NGN\n` +
    `  _"convert 200 pengu"_ — PENGU → NGN\n` +
    `  _"convert 1000 skr"_ — SKR → NGN\n` +
    `  _"alert me when sol hits 150"_\n` +
    `  _"alert me when buy rate above 1650"_\n` +
    `  _"show my alerts"_\n` +
    `  _"remove alert 2"_\n\n` +
    `Or use slash commands — type /help for the full list.`,
    { parse_mode: "Markdown" }
  );
}

async function handleUnknown(bot, msg) {
  await bot.sendMessage(
    msg.chat.id,
    `🤔 I didn't quite get that.\n\nTry saying something like:\n  _"what's the rate"_\n  _"convert 5 sol"_\n  _"alert me when SOL hits 150"_\n\nOr type /help for all commands.`,
    { parse_mode: "Markdown" }
  );
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Processes a plain-text message and dispatches to the right handler.
 * Returns true if an intent was matched, false if the message should be ignored.
 */
async function handleMessage(bot, msg) {
  if (!msg.text || msg.text.startsWith("/")) return false;

  const text = msg.text.trim();

  // Test each intent in order
  for (const intent of INTENTS) {
    const match = text.match(intent.pattern);
    if (!match) continue;

    switch (intent.name) {
      case "greeting":      await handleGreeting(bot, msg);               return true;
      case "rate":          await handleRate(bot, msg);                    return true;
      case "convert":       await handleConvert(bot, msg, match);          return true;
      case "alert_token":   await handleAlertToken(bot, msg, match);       return true;
      case "alert_paj":     await handleAlertPaj(bot, msg, match);         return true;
      case "alert_list":    await handleAlertList(bot, msg);               return true;
      case "alert_remove":  await handleAlertRemove(bot, msg, match);      return true;
      case "help":          await handleHelp(bot, msg);                    return true;
    }
  }

  // No intent matched — only respond if the message mentions "pajero" or is a DM
  const mentionsPajero = /pajero/i.test(text);
  const isPrivateChat  = msg.chat.type === "private";

  if (mentionsPajero || isPrivateChat) {
    await handleUnknown(bot, msg);
    return true;
  }

  return false;
}

module.exports = { handleMessage };
