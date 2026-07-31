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
const { upsertUser, readUsers, getWalletAddress, setWalletAddress }       = require("./store");
const { scheduleBroadcast }                                               = require("./broadcast");
const { handleMessage: pajeroHandle }                                     = require("./pajero");
const { handleBuyUsdcCommand,
        handleBuyUsdcCallback,
        handleBuyUsdcText }                                               = require("./buyUsdc");
const { reconcileWebhook,
        getWebhookSecret,
        isPajCashCompleted }                                               = require("./pajcash");
const { askPajero }                                                       = require("./brain");

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

// ─── Bot identity (resolved after startup) ────────────────────────────────────
let BOT_USERNAME = ""; // e.g. "PajRate_bot"
bot.getMe().then((me) => {
  BOT_USERNAME = (me.username || "").toLowerCase();
  console.log(`Bot identity resolved: @${me.username}`);
}).catch(() => {});

/**
 * Returns true when the bot should respond to a message in a group/supergroup.
 * Always true in private chats.
 *
 * A group message counts as "addressed" when:
 *   1. The bot is @mentioned in the text or caption
 *   2. The message is a reply to one of the bot's own messages
 */
function isBotAddressed(msg) {
  const chatType = msg.chat?.type ?? "private";
  if (chatType === "private") return true;

  const text = msg.text || msg.caption || "";

  // @mention anywhere in the message
  if (BOT_USERNAME && text.toLowerCase().includes(`@${BOT_USERNAME}`)) return true;

  // Also check Telegram's entities array for mention entities pointing at us
  const entities = msg.entities || msg.caption_entities || [];
  for (const entity of entities) {
    if (entity.type === "mention") {
      const mentioned = text.slice(entity.offset + 1, entity.offset + entity.length).toLowerCase();
      if (mentioned === BOT_USERNAME) return true;
    }
    if (entity.type === "text_mention" && entity.user?.id) {
      // For users without usernames — compare by bot user ID
      // BOT_USERNAME is set from getMe(), which also gives us the id via me.id
      // We'll handle this via the me.id stored in BOT_ID below
    }
  }

  // Reply to one of the bot's own messages
  if (msg.reply_to_message?.from?.is_bot) {
    const replyFrom = msg.reply_to_message.from.username?.toLowerCase() ?? "";
    if (replyFrom === BOT_USERNAME) return true;
  }

  return false;
}

/**
 * Strip leading @botname from text so "  @PajRate_bot what's the rate"
 * becomes "what's the rate" before handing to the AI / intent matcher.
 */
function stripBotMention(text) {
  if (!BOT_USERNAME) return text.trim();
  return text.replace(new RegExp(`^@${BOT_USERNAME}\\s*`, "i"), "").trim();
}

console.log("PAJ Rate bot starting...");

// ─── Register bot commands (Telegram menu button) ─────────────────────────────

bot.setMyCommands([
  { command: "rate",         description: "Get live PAJ buy & sell rates" },
  { command: "convert",      description: "Convert between NGN and crypto" },
  { command: "buyusdc",      description: "Buy USDC with Naira via bank transfer" },
  { command: "setwallet",    description: "Set your Solana wallet address for USDC delivery" },
  { command: "alert",        description: "Set a price alert" },
  { command: "alerts",       description: "View your active alerts" },
  { command: "removealert",  description: "Remove an alert by ID" },
  { command: "help",         description: "Show command guide" },
]).then(() => console.log("Bot commands registered."))
  .catch((err) => console.error("Failed to register bot commands:", err.message));

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/^\/start(@\w+)?$/i, (msg) => {
  trackUser(msg.chat.id, msg.from?.username);
  const message =
    `👋 Welcome to *PajRate\\!*\n\n` +
    `Get PAJ's live buy & sell rates in seconds\\.\n\n` +
    `/rate — check rates now\n` +
    `/help — see all commands`;

  bot.sendMessage(msg.chat.id, message, { parse_mode: "MarkdownV2" });
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.onText(/^\/help(@\w+)?$/i, (msg) => {
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
    `  • /convert 500 ANSEM → how much NGN 500 ANSEM is worth\n` +
    `  • /convert 200 PENGU → how much NGN 200 PENGU is worth\n` +
    `  • /convert 1000 SKR → how much NGN 1,000 SKR is worth\n\n` +
    `_Supported: NGN, USDT, USDC, USD, SOL, JUP, BONK, ANSEM, PENGU, SKR_\n\n` +
    `🔔 /alert <token> <above|below> <price>\n` +
    `🔔 /alert <buy|sell> <above|below> <price>\n` +
    `Get a one\\-time ping when a price crosses your target\\.\n` +
    `  • /alert SOL above 150 → ping when SOL > \\$150\n` +
    `  • /alert BONK below 0\\.00003 → ping when BONK drops\n` +
    `  • /alert buy above 1650 → ping when PAJ buy rate > ₦1,650\n` +
    `  • /alert sell below 1500 → ping when PAJ sell rate < ₦1,500\n\n` +
    `📋 /alerts — List your active price alerts\n\n` +
    `❌ /removealert <id> — Cancel an alert by ID\n\n` +
    `💵 /buyusdc \\[amount\\] — Buy USDC with Naira via bank transfer\n` +
    `  • /buyusdc → pick a preset amount\n` +
    `  • /buyusdc 5000 → create a ₦5,000 order directly\n\n` +
    `💳 /setwallet <address> — Set your Solana wallet for USDC delivery\n\n` +
    `_PAJ rates are fetched live\\. Token prices refresh every 30s via CoinGecko\\._`;

  bot.sendMessage(msg.chat.id, message, { parse_mode: "MarkdownV2" });
});

// ─── /rate ────────────────────────────────────────────────────────────────────

bot.onText(/^\/rate(@\w+)?$/i, async (msg) => {
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
bot.onText(/^\/convert(@\w+)?$/i, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `🔄 *Convert*\n\nUsage: \`/convert <amount> [unit]\`\n\nExamples:\n  • \`/convert 50000\` — NGN → USDT\n  • \`/convert 25 USDT\` — USDT → NGN\n  • \`/convert 5 SOL\` — SOL → NGN\n  • \`/convert 100 JUP\` — JUP → NGN\n  • \`/convert 1000000 BONK\` — BONK → NGN\n  • \`/convert 500 ANSEM\` — ANSEM → NGN\n  • \`/convert 200 PENGU\` — PENGU → NGN\n  • \`/convert 1000 SKR\` — SKR → NGN`,
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
bot.onText(/^\/alert\s+(SOL|JUP|BONK|ANSEM|PENGU|SKR)\s+(above|below)\s+([\d.,]+)$/i, async (msg, match) => {
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
  const validToken = /^\/alert\s+(SOL|JUP|BONK|ANSEM|PENGU|SKR)\s+(above|below)\s+[\d.,]+$/i.test(text);
  const validPaj   = /^\/alert\s+(buy|sell)\s+(above|below)\s+[\d.,]+$/i.test(text);
  if (validToken || validPaj) return;

  await bot.sendMessage(
    msg.chat.id,
    `🔔 *Price Alerts*\n\n` +
    `*Token alerts* \\(USD price\\):\n` +
    `  • \`/alert SOL above 150\`\n` +
    `  • \`/alert BONK below 0\\.00003\`\n` +
    `  • \`/alert JUP above 1\\.50\`\n` +
    `  • \`/alert ANSEM above 0\\.10\`\n` +
    `  • \`/alert PENGU above 0\\.05\`\n` +
    `  • \`/alert SKR above 0\\.10\`\n\n` +
    `*PAJ rate alerts* \\(NGN\\):\n` +
    `  • \`/alert buy above 1650\`\n` +
    `  • \`/alert sell below 1500\``,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /alerts ──────────────────────────────────────────────────────────────────

bot.onText(/^\/alerts(@\w+)?$/i, async (msg) => {
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

bot.onText(/^\/removealert(@\w+)?\s+(\d+)$/i, async (msg, match) => {
  const chatId  = msg.chat.id;
  const id      = parseInt(match[2], 10);
  const removed = removeAlert(chatId, id);

  await bot.sendMessage(
    chatId,
    removed
      ? `✅ Alert #${id} has been removed.`
      : `⚠️ No alert with ID #${id} found.\nUse /alerts to see your active ones.`
  );
});

// ─── /stats (admin only) ──────────────────────────────────────────────────────

bot.onText(/^\/stats(@\w+)?$/i, async (msg) => {
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

// ─── Pajero — natural language agent ─────────────────────────────────────────
// Handles plain-text messages: greetings, rate queries, conversions, alerts.
// In private chats: responds to everything not a command.
// In groups: only responds when message matches a known intent or mentions "pajero".

// ─── /setwallet ───────────────────────────────────────────────────────────────
// Lets users register the Solana address that receives USDC from onramp orders.

bot.onText(/^\/setwallet(@\w+)?(\s+\S+)?$/i, async (msg, match) => {
  const chatId  = msg.chat.id;
  const address = (match[2] ?? "").trim();
  trackUser(chatId, msg.from?.username);

  if (!address) {
    const current = getWalletAddress(chatId);
    await bot.sendMessage(
      chatId,
      `💳 *Your Solana Wallet*\n\n` +
      (current
        ? `Current address:\n\`${current}\`\n\nTo update it:\n\`/setwallet <new address>\``
        : `No address set yet.\n\nUsage:\n\`/setwallet <solana address>\`\n\nExample:\n\`/setwallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU\``),
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Basic Solana base58 length check (32–44 chars)
  if (address.length < 32 || address.length > 44) {
    await bot.sendMessage(chatId,
      `⚠️ That doesn't look like a valid Solana address.\n\nAddresses are 32–44 characters long.\nExample:\n\`/setwallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  setWalletAddress(chatId, address);
  await bot.sendMessage(chatId,
    `✅ *Wallet saved\\!*\n\n\`${address}\`\n\nAll future buy\\-USDC orders will deliver to this address\\.`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /buyusdc ─────────────────────────────────────────────────────────────────

bot.onText(/^\/buyusdc(@\w+)?(\s+.*)?$/i, async (msg) => {
  trackUser(msg.chat.id, msg.from?.username);
  await handleBuyUsdcCommand(bot, msg, (userId) => Promise.resolve(getWalletAddress(userId)));
});

// ─── Callback queries (buy-USDC inline buttons) ───────────────────────────────

bot.on("callback_query", async (query) => {
  const data = query.data ?? "";
  if (!data.startsWith("buy:")) return;

  try {
    const handled = await handleBuyUsdcCallback(
      bot,
      query,
      (userId) => Promise.resolve(getWalletAddress(userId))
    );
    if (handled) await bot.answerCallbackQuery(query.id).catch(() => null);
  } catch (err) {
    console.error("[buyusdc] callback error:", err.message);
    await bot.answerCallbackQuery(query.id, { text: "Something went wrong. Try again." }).catch(() => null);
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  trackUser(msg.chat.id, msg.from?.username);

  // In groups, only respond when the bot is @mentioned or the message replies to the bot
  if (!isBotAddressed(msg)) return;

  // Strip "@BotName" prefix so the AI / intent matcher sees clean input
  const cleanText = stripBotMention(msg.text);

  // Buy-USDC custom amount entry takes priority over everything
  const handled = await handleBuyUsdcText(
    bot,
    msg,
    (userId) => Promise.resolve(getWalletAddress(userId))
  );
  if (handled) return;

  // Try AI brain first — if GROQ_API_KEY is set it answers intelligently
  // with live rate/price tools and conversation memory.
  // Returns null when no API key is configured → fall back to pattern matching.
  const aiReply = await askPajero(cleanText, msg.chat.id).catch(() => null);
  if (aiReply) {
    await bot.sendMessage(msg.chat.id, aiReply, { parse_mode: "Markdown" });
    return;
  }

  // Fallback: regex pattern matching (always works, no API key needed)
  await pajeroHandle(bot, { ...msg, text: cleanText });
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
app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => res.send("PAJ rate bot is running."));

// ─── PajCash webhook ──────────────────────────────────────────────────────────
// PajCash POSTs here when an onramp order changes status (PAID, COMPLETED, etc.).
// Secret in the URL path protects against random callers.

app.post("/webhook/pajcash/:secret", async (req, res) => {
  // Validate path secret
  let expectedSecret;
  try { expectedSecret = getWebhookSecret(); }
  catch { return res.status(500).json({ error: "Webhook not configured." }); }

  if (req.params.secret !== expectedSecret) {
    return res.status(403).json({ error: "Forbidden." });
  }

  // Acknowledge immediately — PajCash expects a fast 2xx
  res.status(200).json({ ok: true });

  try {
    const record = await reconcileWebhook(req.body);
    if (!record) return; // not an onramp we care about

    // Notify the user if the order completed
    if (isPajCashCompleted(record.status) && record.telegram_id) {
      const amt = record.actual_usdc_amount > 0
        ? record.actual_usdc_amount
        : record.expected_usdc_amount;
      const usdcStr = `${(Math.round((amt + Number.EPSILON) * 1_000_000) / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
      await bot.sendMessage(
        record.telegram_id,
        `✅ *Top-up complete\\!*\n\n` +
        `\`${usdcStr}\` has been sent to your wallet\\.\n\n` +
        `Reference: \`${record.order_id}\``,
        { parse_mode: "MarkdownV2" }
      ).catch((err) => console.warn("[pajcash webhook] Failed to notify user:", err.message));
    }
  } catch (err) {
    console.error("[pajcash webhook] reconcile error:", err.message);
  }
});

app.listen(PORT, () => console.log(`Health check server on port ${PORT}`));

// ─── One-time new-features broadcast (fires 3 hours after first deploy) ───────

scheduleBroadcast(bot);
