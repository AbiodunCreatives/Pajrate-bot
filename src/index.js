require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const TelegramBot = require("node-telegram-bot-api");
const users = new Set();
const getTotalUsers = () => users.size;
const trackUser = (userId) => users.add(userId);

const { getRate } = require("./rateSource");
const { formatRateMessage } = require("./formatMessage");
const { convert } = require("./convert");
const { addAlert, removeAlert, listAlerts, checkAlerts } = require("./alerts");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID; // e.g. @your_channel or -100xxxxxxxxxx
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/10 * * * *"; // every 10 min
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment. Exiting.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log("PAJ Rate bot starting...");

// ---- On-demand /rate command ----
bot.onText(/\/rate/, async (msg) => {
  const chatId = msg.chat.id;
  try { 
    await trackUser(msg.chat.id, msg.from.username);
    const rateData = await getRate();
    await bot.sendMessage(chatId, formatRateMessage(rateData), {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("Error handling /rate:", err.message);
    await bot.sendMessage(
      chatId,
      "⚠️ Couldn't fetch the live rate right now. Try again in a bit."
    );
  }
});

bot.onText(/\/start/, (msg) => {
  const message = 
    `Hi! 👋 Welcome to PajRate!\n\n` +
    `I'm here to help PAJ rates instantly.\n\n` +
    `<b>What I can do:</b>\n` +
    `/rate - Get live buy/sell rates\n` +
    `/convert <amount> <ngn|usdc> - Quick conversions\n` +
    `<b>Pro tip:</b> Use @PajRate_bot in any chat to get rates without opening me!\n\n` +
    `Try /rate 👇`;
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: "HTML" });
});

// ---- On-demand /convert command ----
bot.onText(/\/convert\s+([\d.,]+)\s*(\S+)?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const amount = parseFloat(match[1].replace(/,/g, ""));
  const unit = match[2];

  if (!Number.isFinite(amount) || amount <= 0) {
    await bot.sendMessage(chatId, "Give me a valid amount, e.g. `/convert 50000`", {
      parse_mode: "Markdown",
    });
    return;
  }

  try {
    await trackUser(msg.chat.id, msg.from.username);
    const rateData = await getRate();
    const result = convert(amount, unit, rateData);

    if (result.error) {
      await bot.sendMessage(chatId, `⚠️ ${result.error}`);
      return;
    }

    await bot.sendMessage(
      chatId,
      `🔄 *Conversion*\n\n${result.input} ≈ *${result.output}*\n\n_${result.rateLine}_`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("Error handling /convert:", err.message);
    await bot.sendMessage(chatId, "⚠️ Couldn't fetch the live rate right now. Try again in a bit.");
  }
});

// ---- Price alert commands ----
bot.onText(/\/alert\s+(above|below)\s+([\d.,]+)(?:\s+(buy|sell))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const direction = match[1].toLowerCase();
  const price = parseFloat(match[2].replace(/,/g, ""));
  const rateType = (match[3] || "buy").toLowerCase();

  if (!Number.isFinite(price) || price <= 0) {
    await bot.sendMessage(chatId, "Give me a valid price, e.g. `/alert above 1600 buy`", {
      parse_mode: "Markdown",
    });
    return;
  }

  const alert = addAlert({ chatId, direction, price, rateType });
  const label = rateType === "buy" ? "Buy (onramp)" : "Sell (offramp)";

  await bot.sendMessage(
    chatId,
    `✅ Alert #${alert.id} set: I'll notify you when the *${label}* rate goes *${direction} ${price.toLocaleString(
      "en-NG"
    )}*.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/alerts$/i, async (msg) => {
  const chatId = msg.chat.id;
  const alerts = listAlerts(chatId);

  if (!alerts.length) {
    await bot.sendMessage(chatId, "You have no active alerts. Set one with `/alert above 1600 buy`.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const lines = alerts.map((a) => {
    const label = a.rateType === "buy" ? "Buy" : "Sell";
    return `#${a.id} — ${label} ${a.direction} ${a.price.toLocaleString("en-NG")}`;
  });

  await bot.sendMessage(chatId, `📋 *Your alerts:*\n\n${lines.join("\n")}`, {
    parse_mode: "Markdown",
  });
});

bot.onText(/\/removealert\s+(\d+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const id = parseInt(match[1], 10);
  const removed = removeAlert(chatId, id);

  await bot.sendMessage(
    chatId,
    removed ? `🗑️ Alert #${id} removed.` : `Couldn't find alert #${id} for you. Check /alerts.`
  );
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

bot.onText(/\/stats/, async (msg) => {
  const totalUsers = getTotalUsers();
  await bot.sendMessage(msg.chat.id, `📊 Total users: ${totalUsers}`);
});

// ---- Scheduled channel broadcast + price alert checks ----
// Both need the live rate, so we fetch it once per tick and reuse it.
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
      await bot.sendMessage(CHANNEL_ID, formatRateMessage(rateData), {
        parse_mode: "Markdown",
      });
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
  console.warn(
    "TELEGRAM_CHANNEL_ID not set — skipping scheduled broadcasts. /rate, /convert and price alerts still work."
  );
}

// ---- Tiny HTTP server so Fly.io health checks pass ----
const app = express();
app.get("/", (_req, res) => res.send("PAJ rate bot is running."));
app.listen(PORT, () => console.log(`Health check server on port ${PORT}`));
