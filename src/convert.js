/**
 * convert.js
 * ----------
 * Converts between Naira, USD-pegged stablecoins, and Solana-ecosystem
 * tokens (SOL, JUP, BONK, ANSEM) using PAJ's live USD/NGN rate chained
 * with CoinGecko token prices.
 *
 * Conversion chains:
 *   NGN  → USDT/USD        :  NGN ÷ buyRate
 *   USDT → NGN             :  USDT × sellRate
 *   token → NGN            :  tokenAmount × tokenUsdPrice × sellRate
 *
 * No unit given → amount is assumed to be NGN.
 */

const { normalizeUnit, CRYPTO_TOKENS, ngnPerUsd, formatNgn, formatUsd, formatToken } = require("./rateUtils");
const { getTokenPricesUsd } = require("./tokenPrices");

async function convert(amount, rawUnit, rateData) {
  const { onRamp, offRamp } = rateData;
  const unit = normalizeUnit(rawUnit) || "NGN";

  const buyRate  = ngnPerUsd(onRamp);
  const sellRate = ngnPerUsd(offRamp);

  // ── NGN → USDT ──────────────────────────────────────────────────────────────
  if (unit === "NGN") {
    const usdAmount = amount / buyRate;
    return {
      input:    formatNgn(amount),
      output:   `${formatUsd(usdAmount)} USDT`,
      rateLine: `📥 Buy rate: $1 = ${formatNgn(buyRate)}`,
    };
  }

  // ── USDT/USD → NGN ──────────────────────────────────────────────────────────
  if (unit === "USD") {
    const ngnAmount = amount * sellRate;
    return {
      input:    `${amount} ${(rawUnit || "USDT").toUpperCase()}`,
      output:   formatNgn(ngnAmount),
      rateLine: `📤 Sell rate: $1 = ${formatNgn(sellRate)}`,
    };
  }

  // ── Crypto tokens (SOL, JUP, BONK, ANSEM) ───────────────────────────────────
  if (CRYPTO_TOKENS.has(unit)) {
    let priceData;
    try {
      priceData = await getTokenPricesUsd();
    } catch (err) {
      return { error: `Couldn't fetch ${unit} price right now. Please try again in a moment.` };
    }

    const { prices, stale, fetchedAt } = priceData;
    const tokenUsdPrice = prices[unit];
    const ngnAmount     = amount * tokenUsdPrice * sellRate;

    const ageSeconds = Math.round((Date.now() - fetchedAt) / 1000);
    const rateLine   = stale
      ? `📤 ${unit} ≈ ${formatUsd(tokenUsdPrice)} · Sell rate: $1 = ${formatNgn(sellRate)}\n⚠️ _Price data is ~${ageSeconds}s old — CoinGecko may be down_`
      : `📤 ${unit} = ${formatUsd(tokenUsdPrice)} · Sell rate: $1 = ${formatNgn(sellRate)}`;

    return {
      input:    formatToken(amount, unit),
      output:   formatNgn(ngnAmount),
      rateLine,
    };
  }

  // ── Unknown unit ─────────────────────────────────────────────────────────────
  return {
    error:
      `I don't recognise the unit *${rawUnit}*.\n\n` +
      `Supported: NGN, USDT, USDC, USD, SOL, JUP, BONK, ANSEM\n` +
      `Example: \`/convert 25 USDT\` or \`/convert 5 SOL\``,
  };
}

module.exports = { convert };
