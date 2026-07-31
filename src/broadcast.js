/**
 * broadcast.js
 * ------------
 * Sends a one-time broadcast message to every known user.
 *
 * scheduleBroadcast(bot) — call once at startup. Fires after 3 hours,
 * sends the new-features announcement to all users in data/users.json,
 * then marks itself as sent in data/meta.json so it will never fire
 * again — even if the bot restarts before the 3 hours are up.
 *
 * A small delay is added between each message to stay within Telegram's
 * rate limit (~30 messages/second for bots).
 */

const { isBroadcastSent, markBroadcastSent } = require("./store");
const { readUsers }                          = require("./db");

// Unique ID for this broadcast — change this to re-send a future broadcast.
const BROADCAST_ID    = "v3-features";
const BROADCAST_DELAY_MS = 3 * 60 * 60 * 1000; // 3 hours
const MSG_INTERVAL_MS    = 50;                   // ~20 msgs/s — safe under Telegram's limit

const MESSAGE =
  `📣 *PajRate just got an upgrade\\!*\n\n` +
  `Here's what's new:\n\n` +
  `🔄 *More tokens to convert*\n` +
  `Convert SOL, JUP, BONK and ANSEM directly to NGN at live prices\\.\n\n` +
  `🔔 *Smarter price alerts*\n` +
  `Set alerts for any token — not just PAJ rates\\.\n` +
  `  • /alert SOL above 150\n` +
  `  • /alert buy above 1650\n\n` +
  `🤖 *Meet Pajero* — just talk naturally, no commands needed\\.\n` +
  `_"convert 5 sol"_, _"what's the rate"_, _"alert me when SOL hits 150"_\n\n` +
  `🪙 *PENGU & SKR now supported* — convert and set alerts for both\\.\n\n` +
  `Type /help to explore\\.`;

/**
 * Sends the broadcast message to a single chat, swallowing errors so one
 * bad chat ID doesn't stop the rest.
 */
async function sendToUser(bot, chatId) {
  try {
    await bot.sendMessage(chatId, MESSAGE, { parse_mode: "MarkdownV2" });
    return true;
  } catch (err) {
    // Common causes: user blocked the bot, chat deleted — log and move on.
    console.warn(`Broadcast: couldn't reach chat ${chatId}: ${err.message}`);
    return false;
  }
}

/**
 * Schedules the one-time broadcast to fire after BROADCAST_DELAY_MS.
 * Skips silently if this broadcast has already been sent (checked via
 * data/meta.json), so bot restarts won't re-send it.
 */
function scheduleBroadcast(bot) {
  // Check immediately — if already sent (from a previous run), don't schedule.
  if (isBroadcastSent(BROADCAST_ID)) {
    console.log(`Broadcast "${BROADCAST_ID}" already sent. Skipping.`);
    return;
  }

  const fireAt = new Date(Date.now() + BROADCAST_DELAY_MS);
  console.log(`Broadcast "${BROADCAST_ID}" scheduled for ${fireAt.toISOString()} (in 3 hours).`);

  setTimeout(async () => {
    // Double-check in case another instance already ran it
    if (isBroadcastSent(BROADCAST_ID)) {
      console.log(`Broadcast "${BROADCAST_ID}" was already sent by another process. Skipping.`);
      return;
    }

    const users = await readUsers();

    if (!users.length) {
      console.log("Broadcast: no users to notify.");
      markBroadcastSent(BROADCAST_ID);
      return;
    }

    console.log(`Broadcast: sending to ${users.length} user(s)...`);
    let sent = 0;
    let failed = 0;

    for (const user of users) {
      const ok = await sendToUser(bot, user.chatId);
      if (ok) sent++; else failed++;
      await new Promise((res) => setTimeout(res, MSG_INTERVAL_MS));
    }

    // Mark as sent AFTER all messages are dispatched
    markBroadcastSent(BROADCAST_ID);
    console.log(`Broadcast "${BROADCAST_ID}" complete. Sent: ${sent}, failed: ${failed}.`);
  }, BROADCAST_DELAY_MS);
}

/**
 * Sends an arbitrary message to every known user immediately.
 * Used by the /announce admin command.
 *
 * @param {TelegramBot} bot
 * @param {string} text   Plain text or MarkdownV2 — caller decides parse_mode
 * @param {object} [opts] Extra sendMessage options (e.g. { parse_mode: "Markdown" })
 * @returns {Promise<{ sent: number, failed: number }>}
 */
async function sendBroadcast(bot, text, opts = {}) {
  const users = await readUsers();

  if (!users.length) {
    console.log("[broadcast] No users to notify.");
    return { sent: 0, failed: 0 };
  }

  console.log(`[broadcast] Sending to ${users.length} user(s)...`);
  let sent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      await bot.sendMessage(user.chatId, text, opts);
      sent++;
    } catch (err) {
      console.warn(`[broadcast] Couldn't reach ${user.chatId}: ${err.message}`);
      failed++;
    }
    // ~20 msgs/s — safe under Telegram's rate limit
    await new Promise((res) => setTimeout(res, MSG_INTERVAL_MS));
  }

  console.log(`[broadcast] Done. Sent: ${sent}, failed: ${failed}.`);
  return { sent, failed };
}

module.exports = { scheduleBroadcast, sendBroadcast };
