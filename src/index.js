require("dotenv").config();
const express     = require("express");
const cron        = require("node-cron");
const TelegramBot = require("node-telegram-bot-api");

const { getRate }                                                         = require("./rateSource");
const { formatRateMessage }                                               = require("./formatMessage");
const { convert }                                                         = require("./convert");
const { addPajAlert, addTokenAlert, removeAlert, listAlerts,
        formatAlertLine, checkAlerts }                                    = require("./alerts");
const { formatNgn, formatUsd }                                            = require("./rateUtils");
const { upsertUser, readUsers }                                           = require("./store");
const { scheduleBroadcast }                                               = require("./broadcast");

const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID    = process.env.TELEGRAM_CHANNEL_ID;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/10 * * * *";
const PORT          = process.env.PORT || 8080;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment. Exiting.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Persistent user tracking
const trackUser     = (chatId, username) => upsertUser({ chatId, username });
const getTotalUsers = () => readUsers().length;

console.log("PAJ Rate bot starting...");

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/^\/start$/i, (msg) => {
  trackUser(msg.chat.id, msg.from?.username);
  const message =
    `👋 Welcome to *PajRate\\!*\n\n` +
    `Get PAJ's live buy & sell rates in seconds\\.\n\n` +
    `/rate — check rates now\n` +
    `/help — see all commands`;

  bot.sendMessage(msg.chat.id, message, { parse_mode: "MarkdownV2" });
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.onText(/^\/help$/i, (msg) => {
  const message =
    `ℹ️ *PajRate — Command Guide*\n\n` +
    `💱 /rate\n` +
    `Get the live PAJ buy & sell rate right now\\.\n\n` +
    `🔄 /convert <amount> \\[unit\\]\n` +
    `Convert between Naira and crypto at the live rate\\.\n` +
    `  • /convert 50000 → how much USDT ₦50,000 buys\n` +
    `  • /convert 25 USDT → how much NGN 25 USDT sells for\n` +
    `  • /convert 5 SOL → how much NGN 5 SOL is worth\n` +
    `  • /convert 100 JUP → how much NGN 100 JUP is worth\n` +
    `  • /convert 1000000 BONK → how much NGN 1M BONK is worth\n` +
    `  • /convert 500 ANSEM → how much NGN 500 ANSEM is worth\n\n` +
    `_Supported: NGN, USDT, USDC, USD, SOL, JUP, BONK, ANSEM_\n\n` +
    `🔔 /alert <token> <above|below> <price>\n` +
    `🔔 /alert <buy|sell> <above|below> <price>\n` +
    `Get a one\\-time ping when a price crosses your target\\.\n` +
    `  • /alert SOL above 150 → ping when SOL > \\$150\n` +
    `  • /alert BONK below 0\\.00003 → ping when BONK drops\n` +
    `  • /alert buy above 1650 → ping when PAJ buy rate > ₦1,650\n` +
    `  • /alert sell below 1500 → ping when PAJ sell rate < ₦1,500\n\n` +
    `📋 /alerts — List your active price alerts\n\n` +
    `❌ /removealert <id> — Cancel an alert by ID\n\n` +
    `_PAJ rates are fetched live\\. Token prices refresh every 30s via CoinGecko\\._`;

  bot.sendMessage(msg.chat.id, message, { parse_mode: "MarkdownV2" });
});

// ─── /rate ────────────────────────────────────────────────────────────────────

bot.onText(/^\/rate$/i, async (msg) => {
  const chatId = msg.chat.id;
  trackUser(chatId, msg.from?.username);
  try {
    const rateData = await getRate();
    await bot.sendMessage(chatId, formatRateMessage(rateData), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error handling /rate:", err.message);
    await bot.sendMessage(
      chatId,
      `⚠️ Couldn't fetch the live rate right now.\nPlease try again in a moment — PAJ's servers may be temporarily unavailable.`
    );
  }
});

// ─── /convert ─────────────────────────────────────────────────────────────────

// No amount provided — show usage hint
bot.onText(/^\/convert$/i, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `🔄 *Convert*\n\nUsage: \`/convert <amount> [unit]\`\n\nExamples:\n  • \`/convert 50000\` — NGN → USDT\n  • \`/convert 25 USDT\` — USDT → NGN\n  • \`/convert 5 SOL\` — SOL → NGN\n  • \`/convert 100 JUP\` — JUP → NGN\n  • \`/convert 1000000 BONK\` — BONK → NGN\n  • \`/convert 500 ANSEM\` — ANSEM → NGN`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/convert\s+([\d.,]+)\s*(\S+)?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const amount = parseFloat(match[1].replace(/,/g, ""));
  const unit   = match[2];

  if (!Number.isFinite(amount) || amount <= 0) {
    await bot.sendMessage(
      chatId,
      `⚠️ That doesn't look like a valid amount.\n\nTry:\n  • \`/convert 50000\` — NGN to USDT\n  • \`/convert 25 USDT\` — USDT to NGN`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  try {
    trackUser(chatId, msg.from?.username);
    const rateData = await getRate();
    const result   = await convert(amount, unit, rateData);

    if (result.error) {
      await bot.sendMessage(chatId, `⚠️ ${result.error}`, { parse_mode: "Markdown" });
      return;
    }

    await bot.sendMessage(
      chatId,
      `🔄 *Conversion*\n\n  ${result.input}  →  *${result.output}*\n\n${result.rateLine}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("Error handling /convert:", err.message);
    await bot.sendMessage(chatId, `⚠️ Couldn't fetch the live rate right now.\nPlease try again in a moment.`);
  }
});

// ─── /alert ───────────────────────────────────────────────────────────────────
// Two forms:
//   Token : /alert SOL above 150
//   PAJ   : /alert buy above 1650  |  /alert sell below 1500

// Token alert: /alert <TOKEN> <above|below> <price>
bot.onText(/^\/alert\s+(SOL|JUP|BONK|ANSEM)\s+(above|below)\s+([\d.,]+)$/i, async (msg, match) => {
  const chatId    = msg.chat.id;
  const token     = match[1].toUpperCase();
  const direction = match[2].toLowerCase();
  const price     = parseFloat(match[3].replace(/,/g, ""));

  if (!Number.isFinite(price) || price <= 0) {
    await bot.sendMessage(
      chatId,
      `⚠️ That doesn't look like a valid price.\n\nTry:\n  • \`/alert SOL above 150\`\n  • \`/alert BONK below 0.00003\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const alert = addTokenAlert({ chatId, token, direction, price });
  await bot.sendMessage(
    chatId,
    `🔔 *Alert Set!*\n\nI'll ping you when *${token}* goes *${direction} ${formatUsd(price)}*.\n\n_Alert #${alert.id} · /alerts to manage_`,
    { parse_mode: "Markdown" }
  );
});

// PAJ rate alert: /alert <buy|sell> <above|below> <price>
bot.onText(/^\/alert\s+(buy|sell)\s+(above|below)\s+([\d.,]+)$/i, async (msg, match) => {
  const chatId    = msg.chat.id;
  const rateType  = match[1].toLowerCase();
  const direction = match[2].toLowerCase();
  const price     = parseFloat(match[3].replace(/,/g, ""));

  if (!Number.isFinite(price) || price <= 0) {
    await bot.sendMessage(
      chatId,
      `⚠️ That doesn't look like a valid price.\n\nTry:\n  • \`/alert buy above 1650\`\n  • \`/alert sell below 1500\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const alert     = addPajAlert({ chatId, direction, price, rateType });
  const rateLabel = rateType === "buy" ? "Buy" : "Sell";
  await bot.sendMessage(
    chatId,
    `🔔 *Alert Set!*\n\nI'll ping you when the *${rateLabel}* rate goes *${direction} ${formatNgn(price)}*.\n\n_Alert #${alert.id} · /alerts to manage_`,
    { parse_mode: "Markdown" }
  );
});

// Catch bare /alert or malformed syntax — show usage guide
bot.onText(/^\/alert(\s.*)?$/i, async (msg) => {
  const text       = msg.text || "";
  const validToken = /^\/alert\s+(SOL|JUP|BONK|ANSEM)\s+(above|below)\s+[\d.,]+$/i.test(text);
  const validPaj   = /^\/alert\s+(buy|sell)\s+(above|below)\s+[\d.,]+$/i.test(text);
  if (validToken || validPaj) return;

  await bot.sendMessage(
    msg.chat.id,
    `🔔 *Price Alerts*\n\n` +
    `*Token alerts* \\(USD price\\):\n` +
    `  • \`/alert SOL above 150\`\n` +
    `  • \`/alert BONK below 0\\.00003\`\n` +
    `  • \`/alert JUP above 1\\.50\`\n` +
    `  • \`/alert ANSEM above 0\\.10\`\n\n` +
    `*PAJ rate alerts* \\(NGN\\):\n` +
    `  • \`/alert buy above 1650\`\n` +
    `  • \`/alert sell below 1500\``,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /alerts ──────────────────────────────────────────────────────────────────

bot.onText(/^\/alerts$/i, async (msg) => {
  const chatId = msg.chat.id;
  const alerts = listAlerts(chatId);

  if (!alerts.length) {
    await bot.sendMessage(
      chatId,
      `📭 *No active alerts.*\n\nSet one:\n  • \`/alert SOL above 150\` — ping when SOL > $150\n  • \`/alert buy above 1650\` — ping when buy rate > ₦1,650`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const lines = alerts.map((a) => `  ${formatAlertLine(a)}`);
  await bot.sendMessage(
    chatId,
    `📋 *Your Active Alerts*\n\n${lines.join("\n")}\n\nRemove one: \`/removealert <id>\``,
    { parse_mode: "Markdown" }
  );
});

// ─── /removealert ─────────────────────────────────────────────────────────────

bot.onText(/^\/removealert\s+(\d+)$/i, async (msg, match) => {
  const chatId  = msg.chat.id;
  const id      = parseInt(match[1], 10);
  const removed = removeAlert(chatId, id);

  await bot.sendMessage(
    chatId,
    removed
      ? `✅ Alert #${id} has been removed.`
      : `⚠️ No alert with ID #${id} found.\nUse /alerts to see your active ones.`
  );
});

// ─── /stats (admin only) ──────────────────────────────────────────────────────

bot.onText(/^\/stats$/i, async (msg) => {
  const chatId = String(msg.chat.id);

  if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
    await bot.sendMessage(msg.chat.id, `⚠️ This command is restricted.`);
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `📊 *Bot Stats*\n\n👤 Total users: ${getTotalUsers()}`,
    { parse_mode: "Markdown" }
  );
});

// ─── Polling error handler ────────────────────────────────────────────────────

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

// ─── Scheduled channel broadcast + alert checks ──────────────────────────────

cron.schedule(CRON_SCHEDULE, async () => {
  let rateData;
  try {
    rateData = await getRate();
  } catch (err) {
    console.error("Scheduled rate fetch failed:", err.message);
    return;
  }

  if (CHANNEL_ID) {
    try {
      await bot.sendMessage(CHANNEL_ID, formatRateMessage(rateData), { parse_mode: "Markdown" });
      console.log(`[${new Date().toISOString()}] Posted rate to channel.`);
    } catch (err) {
      console.error("Scheduled broadcast failed:", err.message);
    }
  }

  try {
    await checkAlerts(rateData, bot);
  } catch (err) {
    console.error("Alert check failed:", err.message);
  }
});

if (CHANNEL_ID) {
  console.log(`Scheduled broadcasts to ${CHANNEL_ID} on "${CRON_SCHEDULE}"`);
} else {
  console.warn("TELEGRAM_CHANNEL_ID not set — skipping scheduled broadcasts. /rate, /convert and alerts still work.");
}

// ─── Health check server (for Fly.io) ────────────────────────────────────────

const app = express();
app.get("/", (_req, res) => res.send("PAJ rate bot is running."));
app.listen(PORT, () => console.log(`Health check server on port ${PORT}`));

// ─── One-time new-features broadcast (fires 3 hours after first deploy) ───────

scheduleBroadcast(bot);
