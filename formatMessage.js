let lastOnRamp = null;
let lastOffRamp = null;

function trendArrow(current, previous) {
  if (previous === null) return "";
  if (current > previous) return " 🟢▲";
  if (current < previous) return " 🔴▼";
  return " ⚪️";
}

function formatRateMessage({ onRamp, offRamp, fetchedAt }) {
  const onTrend = trendArrow(onRamp.rate, lastOnRamp);
  const offTrend = trendArrow(offRamp.rate, lastOffRamp);
  lastOnRamp = onRamp.rate;
  lastOffRamp = offRamp.rate;

  const time = fetchedAt.toLocaleTimeString("en-NG", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  });

  return (
    `💱 *PAJ Cash Live Rate*\n\n` +
    `📥 Buy (onramp) — ${onRamp.pair}: *${onRamp.rate.toLocaleString("en-NG")}*${onTrend}\n` +
    `📤 Sell (offramp) — ${offRamp.pair}: *${offRamp.rate.toLocaleString("en-NG")}*${offTrend}\n\n` +
    `🕒 ${time} (WAT)`
  );
}

module.exports = { formatRateMessage };
