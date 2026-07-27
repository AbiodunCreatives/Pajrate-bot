require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const TelegramBot = require("node-telegram-bot-api");

const { getRate } = require("./rateSource");
const { formatRateMessage } = require("./formatMessage");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/10 * * * *";
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment. Exiting.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log("PAJ Rate bot starting...");

const refreshKeyboard = {
  inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "refresh_rate" }]],
};

async function sendRate(chatId) {
  const rateData = await getRate();
  return bot.sendMessage(chatId, formatRateMessage(rateData), {
    parse_mode: "HTML",
    reply_markup: refreshKeyboard,
  });
}

bot.onText(/\/rate/, async (msg) => {
  try {
    await sendRate(msg.chat.id);
  } catch (err) {
    console.error("Error handling /rate:", err.message);
    await bot.sendMessage(
      msg.chat.id,
      "⚠️ Couldn't fetch the live rate right now. Try again in a bit."
    );
  }
});

bot.on("callback_query", async (query) => {
  if (query.data !== "refresh_rate") return;

  try {
    const rateData = await getRate();
    await bot.editMessageText(formatRateMessage(rateData), {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      reply_markup: refreshKeyboard,
    });
    await bot.answerCallbackQuery(query.id, { text: "Updated ✅" });
  } catch (err) {
    if (err.message && err.message.includes("message is not modified")) {
      await bot.answerCallbackQuery(query.id, { text: "Still the same rate" });
      return;
    }
    console.error("Refresh failed:", err.message);
    await bot.answerCallbackQuery(query.id, {
      text: "Couldn't refresh, try again",
      show_alert: true,
    });
  }
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "👋 <b>Welcome to PajRate</b>\n\n" +
      "Send /rate anytime for PAJ Cash's current live rate — buy, sell, and how it's moved.\n\n" +
      (CHANNEL_ID ? "It's also auto-posted here every few minutes." : ""),
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "<b>Commands</b>\n" +
      "/rate — get the current PAJ Cash rate\n" +
      "/start — intro message\n" +
      "/help — this list",
    { parse_mode: "HTML" }
  );
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

if (CHANNEL_ID) {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      await sendRate(CHANNEL_ID);
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

const app = express();
app.get("/", (_req, res) => res.send("PAJ rate bot is running."));
app.listen(PORT, () => console.log(`Health check server on port ${PORT}`));
