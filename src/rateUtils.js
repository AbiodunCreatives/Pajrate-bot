/**
 * rateUtils.js
 * ------------
 * Shared helpers for interpreting PAJ's rate pairs and formatting money.
 *
 * PAJ's API returns a pair like "USD/NGN" meaning: 1 unit of the first
 * currency (USD) is worth `rate` units of the second (NGN). We treat any
 * USD-pegged stablecoin (USDT, USDC, USDG) as equivalent to USD for
 * conversion purposes, since PAJ prices them 1:1 against the dollar.
 */

const USD_ALIASES = new Set(["USD", "USDT", "USDC", "USDG"]);

/** Normalizes user input like "usdc", "USDT", "ngn" into "USD" / "NGN". */
function normalizeUnit(rawUnit) {
  if (!rawUnit) return null;
  const upper = rawUnit.toUpperCase();
  if (USD_ALIASES.has(upper)) return "USD";
  if (upper === "NGN" || upper === "NAIRA") return "NGN";
  return upper;
}

/**
 * Given a rate leg like { rate: 1417.03, pair: "USD/NGN" }, returns how
 * many NGN 1 USD is worth — regardless of which side of the pair the API
 * lists as base vs. target.
 */
function ngnPerUsd({ rate, pair }) {
  const [base, target] = pair.split("/").map((s) => s.toUpperCase());
  if (target === "NGN") return rate;
  if (base === "NGN") return 1 / rate;
  return rate; // unexpected pair shape — fall back to the raw rate
}

function formatNgn(amount) {
  return `₦${amount.toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
}

function formatUsd(amount) {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

module.exports = { USD_ALIASES, normalizeUnit, ngnPerUsd, formatNgn, formatUsd };
