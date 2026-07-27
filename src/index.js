require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { getRate } = require("./rateSource");
const { formatRateMessage } = require("./formatMessage");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("Bot started");

bot.onText(/\/rate/, async (msg) => {
  try {
    const data = await getRate();
    await bot.sendMessage(msg.chat.id, formatRateMessage(data), {
      parse_mode: "HTML"
    });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, "Error: " + e.message);
  }
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Welcome to PajRate! Try /rate");
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, "/rate - Get rates\n/start - Welcome\n/help - This");
});

const app = express();
app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Ready"));
