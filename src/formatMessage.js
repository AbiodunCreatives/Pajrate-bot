const { ngnPerUsd, formatNgn } = require("./rateUtils");

let lastBuyRate = null;
let lastSellRate = null;

function trendArrow(current, previous) {
  if (previous === null) return "";
  if (current > previous) return " 🟢▲";
  if (current < previous) return " 🔴▼";
  return " ⚪️";
}

function formatRateMessage({ onRamp, offRamp, fetchedAt }) {
  const buyRate = ngnPerUsd(onRamp);
  const sellRate = ngnPerUsd(offRamp);

  const buyTrend = trendArrow(buyRate, lastBuyRate);
  const sellTrend = trendArrow(sellRate, lastSellRate);
  lastBuyRate = buyRate;
  lastSellRate = sellRate;

  const time = fetchedAt.toLocaleTimeString("en-NG", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  });

  return (
    `💱 *PAJ Live Rate*\n\n` +
    `📥 Buy — $1 = *${formatNgn(buyRate)}*${buyTrend}\n` +
    `📤 Sell — $1 = *${formatNgn(sellRate)}*${sellTrend}\n\n` +
    `🕒 ${time} (WAT)`
  );
}

module.exports = { formatRateMessage };
