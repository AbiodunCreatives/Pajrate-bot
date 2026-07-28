/**
 * alerts.js
 * ---------
 * One-time price alerts. A user sets a target price and direction;
 * once the live rate crosses it, we DM them and remove the alert.
 */

const { readAlerts, writeAlerts } = require("./store");

function nextId(alerts) {
  return alerts.length ? Math.max(...alerts.map((a) => a.id)) + 1 : 1;
}

function addAlert({ chatId, direction, price, rateType }) {
  const alerts = readAlerts();
  const alert = {
    id: nextId(alerts),
    chatId,
    direction, // "above" | "below"
    price,
    rateType, // "buy" | "sell"
    createdAt: new Date().toISOString(),
  };
  alerts.push(alert);
  writeAlerts(alerts);
  return alert;
}

function removeAlert(chatId, id) {
  const alerts = readAlerts();
  const idx = alerts.findIndex((a) => a.id === id && String(a.chatId) === String(chatId));
  if (idx === -1) return false;
  alerts.splice(idx, 1);
  writeAlerts(alerts);
  return true;
}

function listAlerts(chatId) {
  return readAlerts().filter((a) => String(a.chatId) === String(chatId));
}

/**
 * Compares current rates against all stored alerts, notifies chats whose
 * alerts have been triggered, and removes those alerts (fire-once).
 */
async function checkAlerts(rateData, bot) {
  const alerts = readAlerts();
  if (!alerts.length) return;

  const currentPrice = {
    buy: rateData.onRamp.rate,
    sell: rateData.offRamp.rate,
  };

  const triggered = [];
  const remaining = [];

  for (const alert of alerts) {
    const price = currentPrice[alert.rateType];
    const hit =
      (alert.direction === "above" && price >= alert.price) ||
      (alert.direction === "below" && price <= alert.price);

    if (hit) {
      triggered.push({ ...alert, currentPrice: price });
    } else {
      remaining.push(alert);
    }
  }

  if (!triggered.length) return;

  writeAlerts(remaining);

  for (const alert of triggered) {
    const label = alert.rateType === "buy" ? "Buy (onramp)" : "Sell (offramp)";
    const msg =
      `🔔 *Price Alert Triggered*\n\n` +
      `${label} rate is now *${alert.currentPrice.toLocaleString("en-NG")}*, ` +
      `${alert.direction} your target of *${alert.price.toLocaleString("en-NG")}*.\n\n` +
      `This alert has been cleared — set a new one anytime with /alert.`;
    try {
      await bot.sendMessage(alert.chatId, msg, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(`Failed to notify chat ${alert.chatId}:`, err.message);
    }
  }
}

module.exports = { addAlert, removeAlert, listAlerts, checkAlerts };
