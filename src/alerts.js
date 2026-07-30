/**
 * alerts.js
 * ---------
 * One-time price alerts for two alert types:
 *
 *   type: "paj"   — triggers against PAJ's USD/NGN buy or sell rate
 *                   e.g. "notify me when buy rate goes above ₦1,650"
 *
 *   type: "token" — triggers against a token's USD price from CoinGecko
 *                   e.g. "notify me when SOL goes above $150"
 *
 * Once triggered, the alert is removed (fire-once).
 */

const { readAlerts, writeAlerts } = require("./store");
const { formatNgn, formatUsd, CRYPTO_TOKENS } = require("./rateUtils");
const { getTokenPricesUsd } = require("./tokenPrices");

function nextId(alerts) {
  return alerts.length ? Math.max(...alerts.map((a) => a.id)) + 1 : 1;
}

/**
 * Adds a PAJ rate alert (buy/sell NGN rate).
 * @param {{ chatId, direction, price, rateType }} opts
 */
function addPajAlert({ chatId, direction, price, rateType }) {
  const alerts = readAlerts();
  const alert  = {
    id:        nextId(alerts),
    type:      "paj",
    chatId,
    direction, // "above" | "below"
    price,     // NGN target
    rateType,  // "buy" | "sell"
    createdAt: new Date().toISOString(),
  };
  alerts.push(alert);
  writeAlerts(alerts);
  return alert;
}

/**
 * Adds a token price alert (USD price via CoinGecko).
 * @param {{ chatId, token, direction, price }} opts
 */
function addTokenAlert({ chatId, token, direction, price }) {
  const alerts = readAlerts();
  const alert  = {
    id:        nextId(alerts),
    type:      "token",
    chatId,
    token:     token.toUpperCase(), // "SOL" | "JUP" | "BONK" | "ANSEM"
    direction, // "above" | "below"
    price,     // USD target
    createdAt: new Date().toISOString(),
  };
  alerts.push(alert);
  writeAlerts(alerts);
  return alert;
}

function removeAlert(chatId, id) {
  const alerts = readAlerts();
  const idx    = alerts.findIndex(
    (a) => a.id === id && String(a.chatId) === String(chatId)
  );
  if (idx === -1) return false;
  alerts.splice(idx, 1);
  writeAlerts(alerts);
  return true;
}

function listAlerts(chatId) {
  return readAlerts().filter((a) => String(a.chatId) === String(chatId));
}

/**
 * Formats a single alert for display in /alerts list.
 */
function formatAlertLine(a) {
  if (a.type === "token") {
    return `#${a.id} · ${a.token} ${a.direction} ${formatUsd(a.price)}`;
  }
  const label = a.rateType === "buy" ? "Buy" : "Sell";
  return `#${a.id} · PAJ ${label} rate ${a.direction} ${formatNgn(a.price)}`;
}

/**
 * Checks all stored alerts against current prices and fires any that
 * have been triggered. Triggered alerts are removed (fire-once).
 */
async function checkAlerts(rateData, bot) {
  const alerts = readAlerts();
  if (!alerts.length) return;

  // PAJ NGN rates
  const pajPrices = {
    buy:  rateData.onRamp.rate,
    sell: rateData.offRamp.rate,
  };

  // Token USD prices — only fetch if we have token alerts
  const hasTokenAlerts = alerts.some((a) => a.type === "token");
  let tokenPrices = null;
  if (hasTokenAlerts) {
    try {
      const result = await getTokenPricesUsd();
      tokenPrices  = result.prices;
    } catch (err) {
      console.error("Couldn't fetch token prices for alert check:", err.message);
      // Skip token alerts this tick — don't lose them
    }
  }

  const triggered = [];
  const remaining = [];

  for (const alert of alerts) {
    let currentPrice;

    if (alert.type === "paj") {
      currentPrice = pajPrices[alert.rateType];
    } else if (alert.type === "token") {
      if (!tokenPrices) {
        // Token prices unavailable this tick — keep alert
        remaining.push(alert);
        continue;
      }
      currentPrice = tokenPrices[alert.token];
      if (typeof currentPrice !== "number") {
        remaining.push(alert);
        continue;
      }
    } else {
      remaining.push(alert);
      continue;
    }

    const hit =
      (alert.direction === "above" && currentPrice >= alert.price) ||
      (alert.direction === "below" && currentPrice <= alert.price);

    if (hit) triggered.push({ ...alert, currentPrice });
    else     remaining.push(alert);
  }

  if (!triggered.length) return;

  writeAlerts(remaining);

  for (const alert of triggered) {
    let msg;

    if (alert.type === "token") {
      msg =
        `🔔 *Alert Triggered\\!*\n\n` +
        `*${alert.token}* just hit *${formatUsd(alert.currentPrice)}* — ` +
        `that's ${alert.direction} your target of *${formatUsd(alert.price)}*\\.\n\n` +
        `_Alert \\#${alert.id} has been cleared\\. Set a new one anytime with /alert\\._`;
    } else {
      const rateLabel = alert.rateType === "buy" ? "Buy" : "Sell";
      msg =
        `🔔 *Alert Triggered\\!*\n\n` +
        `The *${rateLabel}* rate just hit *${formatNgn(alert.currentPrice)}* — ` +
        `that's ${alert.direction} your target of *${formatNgn(alert.price)}*\\.\n\n` +
        `_Alert \\#${alert.id} has been cleared\\. Set a new one anytime with /alert\\._`;
    }

    try {
      await bot.sendMessage(alert.chatId, msg, { parse_mode: "MarkdownV2" });
    } catch (err) {
      console.error(`Failed to notify chat ${alert.chatId}:`, err.message);
    }
  }
}

module.exports = {
  addPajAlert,
  addTokenAlert,
  removeAlert,
  listAlerts,
  formatAlertLine,
  checkAlerts,
  CRYPTO_TOKENS,
};
