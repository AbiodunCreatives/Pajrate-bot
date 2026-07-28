/**
 * convert.js
 * ----------
 * Converts between Naira and USD-pegged assets (USD, USDT, USDC, USDG —
 * all treated as equivalent) using the live buy/sell rates.
 * No unit given → amount is assumed to be Naira.
 */

const { normalizeUnit, ngnPerUsd, formatNgn, formatUsd } = require("./rateUtils");

function convert(amount, rawUnit, rateData) {
  const { onRamp, offRamp } = rateData;
  const unit = normalizeUnit(rawUnit) || "NGN";

  if (unit !== "NGN" && unit !== "USD") {
    return { error: `Unknown unit "${rawUnit}". Try NGN, USD, USDT, USDC, or USDG.` };
  }

  if (unit === "NGN") {
    // Naira -> USD-equivalent, at the buy (onramp) rate.
    const rate = ngnPerUsd(onRamp);
    const usdAmount = amount / rate;
    return {
      input: formatNgn(amount),
      output: formatUsd(usdAmount),
      rateLine: `Buy rate: $1 = ${formatNgn(rate)}`,
    };
  }

  // USD-equivalent -> Naira, at the sell (offramp) rate.
  const rate = ngnPerUsd(offRamp);
  const ngnAmount = amount * rate;
  return {
    input: `${amount} ${(rawUnit || "USD").toUpperCase()}`,
    output: formatNgn(ngnAmount),
    rateLine: `Sell rate: $1 = ${formatNgn(rate)}`,
  };
}

module.exports = { convert };
