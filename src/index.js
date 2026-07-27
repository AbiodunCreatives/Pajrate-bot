require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const TelegramBot = require("node-telegram-bot-api");

const { getRate } = require("./rateSource");
const { formatRateMessage } = require("./formatMessage");
const {
  addAlert,
  removeAlert,
  getUserAlerts,
  checkAlerts,
} = require("./alerts");

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

// ============================================
// /rate command - Get current rate
// ============================================
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

// ============================================
// /convert command - Convert NGN <-> USDC
// ============================================
bot.onText(/\/convert\s+(\d+(?:\.\d+)?)\s+(\w+)/i, async (msg, match) => {
  try {
    const amount = parseFloat(match[1]);
    const currency = match[2].toUpperCase();

    if (!amount || amount <= 0) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Please provide a valid amount. Usage: /convert 50 ngn or /convert 50 usdc"
      );
      return;
    }

    if (currency !== "NGN" && currency !== "USDC") {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Only NGN and USDC are supported. Usage: /convert 50 ngn or /convert 50 usdc"
      );
      return;
    }

    const rateData = await getRate();
    const onRampRate = rateData.onRamp.rate; // USDC -> NGN rate
    const offRampRate = rateData.offRamp.rate; // NGN -> USDC rate

    let result, fromCurrency, toCurrency;

    if (currency === "NGN") {
      // Converting NGN to USDC
      result = amount / offRampRate;
      fromCurrency = "NGN";
      toCurrency = "USDC";
    } else {
      // Converting USDC to NGN
      result = amount * onRampRate;
      fromCurrency = "USDC";
      toCurrency = "NGN";
    }

    const formattedResult = result.toFixed(2);
    const formattedAmount = amount.toLocaleString("en-NG");

    const message =
      `💱 <b>Amount Converter</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>${formattedAmount} ${fromCurrency}</b>\n` +
      `<code>↓</code>\n` +
      `<b>${formattedResult} ${toCurrency}</b>\n\n` +
      `📥 Buy (USDC→NGN): <code>${onRampRate.toLocaleString("en-NG")}</code>\n` +
      `📤 Sell (NGN→USDC): <code>${offRampRate.toLocaleString("en-NG")}</code>`;

    await bot.sendMessage(msg.chat.id, message, {
      parse_mode: "HTML",
      reply_markup: refreshKeyboard,
    });
  } catch (err) {
    console.error("Error handling /convert:", err.message);
    await bot.sendMessage(
      msg.chat.id,
      "⚠️ Couldn't process conversion. Try again in a bit."
    );
  }
});

// ============================================
// /alert command - Set price alert
// ============================================
bot.onText(/\/alert\s+(\d+(?:\.\d+)?)\s+(\w+)/i, async (msg, match) => {
  try {
    const targetRate = parseFloat(match[1]);
    const alertType = match[2].toUpperCase();

    if (!targetRate || targetRate <= 0) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Please provide a valid target rate. Usage: /alert 450 offRamp or /alert 430 onRamp"
      );
      return;
    }

    if (alertType !== "OFFRAMP" && alertType !== "ONRAMP") {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Alert type must be 'offRamp' or 'onRamp'. Usage: /alert 450 offRamp"
      );
      return;
    }

    const normalizedType = alertType.toLowerCase();
    const alert = addAlert(msg.chat.id, targetRate, normalizedType);

    const typeLabel =
      normalizedType === "offRamp"
        ? "📤 Sell (NGN→USDC)"
        : "📥 Buy (USDC→NGN)";

    const message =
      `✅ <b>Alert Set!</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${typeLabel}\n` +
      `<b>Target Rate:</b> <code>${targetRate.toLocaleString("en-NG")}</code>\n\n` +
      `<i>You'll be notified when the rate reaches or exceeds this value.</i>\n\n` +
      `<b>Manage alerts:</b>\n` +
      `/alerts — list your active alerts\n` +
      `/removealert <id> — remove an alert`;

    await bot.sendMessage(msg.chat.id, message, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Error handling /alert:", err.message);
    await bot.sendMessage(
      msg.chat.id,
      "⚠️ Couldn't set alert. Try again in a bit."
    );
  }
});

// ============================================
// /alerts command - List active alerts
// ============================================
bot.onText(/\/alerts/, async (msg) => {
  try {
    const userAlerts = getUserAlerts(msg.chat.id);

    if (userAlerts.length === 0) {
      await bot.sendMessage(
        msg.chat.id,
        "📋 You have no active alerts.\n\nCreate one with /alert <rate> <offRamp|onRamp>"
      );
      return;
    }

    let message = `📋 <b>Your Active Alerts</b>\n━━━━━━━━━━━━━━━━━━\n\n`;

    userAlerts.forEach((alert) => {
      const typeLabel =
        alert.type === "offRamp"
          ? "📤 Sell (NGN→USDC)"
          : "📥 Buy (USDC→NGN)";
      const createdTime = alert.createdAt.toLocaleTimeString("en-NG", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Africa/Lagos",
      });

      message +=
        `<b>ID:</b> <code>${alert.id}</code>\n` +
        `${typeLabel}\n` +
        `<b>Target:</b> <code>${alert.targetRate.toLocaleString("en-NG")}</code>\n` +
        `<b>Set at:</b> ${createdTime} WAT\n\n`;
    });

    message +=
      `<b>To remove an alert:</b> /removealert <id>\n` +
      `<b>Example:</b> /removealert ${userAlerts[0]?.id || "123456789"}`;

    await bot.sendMessage(msg.chat.id, message, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Error handling /alerts:", err.message);
    await bot.sendMessage(
      msg.chat.id,
      "⚠️ Couldn't fetch alerts. Try again in a bit."
    );
  }
});

// ============================================
// /removealert command - Remove an alert
// ============================================
bot.onText(/\/removealert\s+(\d+)/, async (msg, match) => {
  try {
    const alertId = match[1];
    const removed = removeAlert(msg.chat.id, alertId);

    if (!removed) {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Alert with ID <code>${alertId}</code> not found.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      `✅ Alert <code>${alertId}</code> has been removed.`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("Error handling /removealert:", err.message);
    await bot.sendMessage(
      msg.chat.id,
      "⚠️ Couldn't remove alert. Try again in a bit."
    );
  }
});

// ============================================
// Inline mode - Search rates anywhere
// ============================================
bot.on("inline_query", async (query) => {
  try {
    const searchText = query.query.toLowerCase().trim();

    // If empty or contains "rate", show current rate inline
    if (searchText === "" || searchText.includes("rate")) {
      const rateData = await getRate();
      const onRampRate = rateData.onRamp.rate;
      const offRampRate = rateData.offRamp.rate;

      const inlineResults = [
        {
          type: "article",
          id: "current_rate",
          title: "📊 Current PAJ Rate",
          description: `Buy: ${onRampRate.toLocaleString("en-NG")} | Sell: ${offRampRate.toLocaleString("en-NG")}`,
          input_message_content: {
            message_text:
              `✨ <b>PAJ Cash Rate</b>\n` +
              `<i>USD/NGN</i>\n` +
              `━━━━━━━━━━━━━━━━━━\n\n` +
              `📥 <b>Buy</b>&#8194;&#8194;<code>${onRampRate.toLocaleString("en-NG")}</code>\n` +
              `📤 <b>Sell</b>&#8194;&#8194;<code>${offRampRate.toLocaleString("en-NG")}</code>`,
            parse_mode: "HTML",
          },
        },
      ];

      // If contains a number, also suggest conversion
      const numberMatch = searchText.match(/(\d+(?:\.\d+)?)/);
      if (numberMatch) {
        const amount = parseFloat(numberMatch[1]);

        const convertToUSDC = (amount / offRampRate).toFixed(2);
        const convertToNGN = (amount * onRampRate).toFixed(2);

        inlineResults.push({
          type: "article",
          id: "convert_to_usdc",
          title: `💱 ${amount.toLocaleString("en-NG")} NGN → ${convertToUSDC} USDC`,
          description: `At sell rate ${offRampRate.toLocaleString("en-NG")}`,
          input_message_content: {
            message_text:
              `💱 <b>Conversion</b>\n` +
              `<b>${amount.toLocaleString("en-NG")} NGN</b> = <b>${convertToUSDC} USDC</b>\n\n` +
              `Rate: <code>${offRampRate.toLocaleString("en-NG")}</code>`,
            parse_mode: "HTML",
          },
        });

        inlineResults.push({
          type: "article",
          id: "convert_to_ngn",
          title: `💱 ${amount.toLocaleString("en-NG")} USDC → ${convertToNGN} NGN`,
          description: `At buy rate ${onRampRate.toLocaleString("en-NG")}`,
          input_message_content: {
            message_text:
              `💱 <b>Conversion</b>\n` +
              `<b>${amount.toLocaleString("en-NG")} USDC</b> = <b>${convertToNGN} NGN</b>\n\n` +
              `Rate: <code>${onRampRate.toLocaleString("en-NG")}</code>`,
            parse_mode: "HTML",
          },
        });
      }

      await bot.answerInlineQuery(query.id, inlineResults, { cache_time: 5 });
    } else {
      // No matching inline results
      await bot.answerInlineQuery(query.id, [], { cache_time: 60 });
    }
  } catch (err) {
    console.error("Error handling inline query:", err.message);
    await bot.answerInlineQuery(query.id, [], { cache_time: 60 });
  }
});

// ============================================
// Callback queries - Refresh button
// ============================================
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

// ============================================
// /start command
// ============================================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Hey 👋 welcome to PajRate!\n\n" +
      "I'll get you PAJ's live rate whenever you need it — no logging in.\n\n" +
      "<b>What I can do:</b>\n" +
      "/rate — get the current buy and sell price\n" +
      "/convert <amount> <ngn|usdc> — convert between NGN and USDC\n" +
      "/alert <rate> <onRamp|offRamp> — set a price alert\n" +
      "/alerts — view your active alerts\n" +
      "/removealert <id> — remove an alert\n\n" +
      "You can also use @PajRate_bot in any chat for instant rates!\n\n" +
      "Give /rate a try 👇",
    { parse_mode: "HTML" }
  );
});

// ============================================
// /help command
// ============================================
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "<b>Commands</b>\n" +
      "/rate — get the current PAJ Cash rate\n" +
      "/convert <amount> <ngn|usdc> — convert amounts\n" +
      "  <i>Examples: /convert 50 ngn or /convert 10 usdc</i>\n" +
      "/alert <rate> <onRamp|offRamp> — set price alert\n" +
      "  <i>Example: /alert 450 offRamp</i>\n" +
      "/alerts — list your active alerts\n" +
      "/removealert <id> — remove an alert\n" +
      "/start — intro message\n" +
      "/help — this list",
    { parse_mode: "HTML" }
  );
});

// ============================================
// Error handling
// ============================================
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

// ============================================
// Scheduled rate broadcasts
// ============================================
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

// ============================================
// Alert checker - Runs every 2 minutes
// ============================================
cron.schedule("*/2 * * * *", async () => {
  try {
    const rateData = await getRate();
    const triggeredAlerts = checkAlerts(
      rateData.onRamp.rate,
      rateData.offRamp.rate
    );

    for (const triggered of triggeredAlerts) {
      const typeLabel =
        triggered.alertType === "offRamp"
          ? "📤 Sell Rate (NGN→USDC)"
          : "📥 Buy Rate (USDC→NGN)";

      try {
        await bot.sendMessage(
          triggered.userId,
          `🔔 <b>Alert Triggered!</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `${typeLabel}\n` +
            `<b>Target Rate:</b> <code>${triggered.targetRate.toLocaleString("en-NG")}</code>\n` +
            `<b>Current Rate:</b> <code>${triggered.currentRate.toLocaleString("en-NG")}</code>\n\n` +
            `Your alert has been triggered!`,
          { parse_mode: "HTML" }
        );

        // Remove alert after triggering
        removeAlert(triggered.userId, triggered.alertId);
      } catch (err) {
        console.error(
          `Failed to send alert to user ${triggered.userId}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error("Alert checker error:", err.message);
  }
});

console.log("Alert checker running every 2 minutes");

// ============================================
// Health check server
// ============================================
const app = express();
app.get("/", (_req, res) => res.send("PAJ rate bot is running."));
app.listen(PORT, () => console.log(`Health check server on port ${PORT}`));    await sendRate(msg.chat.id);
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
    "Hey 👋 welcome to PajRate!\n\n" +
      "I'll get you PAJ's live rate whenever you need it — no logging in.\n\n" +
      "Just send /rate and I'll show you the current buy and sell price, plus whether it's moved since you last checked. There's a refresh button too.\n\n" +
      "That's really it — give /rate a try 👇",
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
