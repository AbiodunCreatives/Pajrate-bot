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

  const spread = Math.abs(onRamp.rate - offRamp.rate);

  const time = fetchedAt.toLocaleTimeString("en-NG", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  });

  return (
    `✨ <b>PAJ Cash Rate</b>\n` +
    `<i>${onRamp.pair}</i>\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `📥 <b>Buy</b>&#8194;&#8194;<code>${onRamp.rate.toLocaleString("en-NG")}</code>${onTrend}\n` +
    `📤 <b>Sell</b>&#8194;&#8194;<code>${offRamp.rate.toLocaleString("en-NG")}</code>${offTrend}\n\n` +
    `💰 Spread&#8194;<code>${spread.toLocaleString("en-NG")}</code>\n\n` +
    `🕒 ${time} WAT`
  );
}

module.exports = { formatRateMessage };
