require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const TelegramBot = require("node-telegram-bot-api");

const { getRate } = require("./rateSource");
const { formatRateMessage } = require("./formatMessage");

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
  bot.sendMessage(
    msg.chat.id,
    "Welcome to PajRate!\n\n" +
      "I'll get you PAJ's live rate whenever you need it — no logging in.\n\n" +
      "Just send /rate and I'll show you the current buy and sell price, plus whether it's moved since you last checked.\n\n" +
      "That's really it — give /rate a try 👇",
    { parse_mode: "HTML" }
  );
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

// ---- Scheduled channel broadcast ----
if (CHANNEL_ID) {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const rateData = await getRate();
      await bot.sendMessage(CHANNEL_ID, formatRateMessage(rateData), {
        parse_mode: "Markdown",
      });
      console.log(`[${new Date().toISOString()}] Posted rate to channel.`);
    } catch (err) {
      console.error("Scheduled broadcast failed:", err.message);
    }
  });
  console.log(`Scheduled broadcasts to ${CHANNEL_ID} on "${CRON_SCHEDULE}"`);
} else {
  console.warn(
    "TELEGRAM_CHANNEL_ID not set — skipping scheduled broadcasts, /rate command still works."
  );
}

// ---- Tiny HTTP server so Fly.io health checks pass ----
const app = express();
app.get("/", (_req, res) => res.send("PAJ rate bot is running."));
app.listen(PORT, () => console.log(`Health check server on port ${PORT}`));
