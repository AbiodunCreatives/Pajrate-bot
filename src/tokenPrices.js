/**
 * tokenPrices.js
 * --------------
 * Fetches live USD prices for Solana-ecosystem tokens from CoinGecko's
 * free public API. No API key required.
 *
 * These prices are chained with PAJ's USD/NGN rate to give
 * token ↔ NGN conversions.
 *
 * Volatility handling:
 *   - Cache TTL is 30 s — short enough to track fast-moving tokens like
 *     BONK and ANSEM, while staying within CoinGecko's free-tier rate limit.
 *   - On fetch failure, we fall back to the last known prices and set
 *     `stale: true` so callers can warn the user.
 *   - Every response includes `priceAge` (ms) so the caller can show
 *     how fresh the price is.
 *
 * CoinGecko free API docs: https://docs.coingecko.com/reference/simple-price
 */

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";

// Maps our canonical token symbols to CoinGecko coin IDs
const TOKEN_IDS = {
  SOL:   "solana",
  JUP:   "jupiter-exchange-solana",
  BONK:  "bonk",
  ANSEM: "the-black-bull",
};

const TIMEOUT_MS   = 10_000;
const CACHE_TTL_MS = 30_000; // 30 s — keeps prices fresh for volatile tokens

let cache = null; // { prices, fetchedAt }

/**
 * Returns { prices: { SOL, JUP, BONK, ANSEM }, fetchedAt, stale }.
 *
 * `stale: true` means CoinGecko was unreachable and we're using the last
 * known prices. Callers should surface a warning to the user in that case.
 *
 * Throws only if CoinGecko has never responded (no cache to fall back to).
 */
async function getTokenPricesUsd() {
  const now = Date.now();

  // Return cache if still fresh
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { prices: cache.prices, fetchedAt: cache.fetchedAt, stale: false };
  }

  // Attempt a fresh fetch
  try {
    const ids = Object.values(TOKEN_IDS).join(",");
    const url = `${COINGECKO_URL}?ids=${ids}&vs_currencies=usd`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`CoinGecko API returned ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    const prices = {};
    for (const [symbol, id] of Object.entries(TOKEN_IDS)) {
      const price = data?.[id]?.usd;
      if (typeof price !== "number") {
        throw new Error(`Missing price for ${symbol} (id: ${id}) in CoinGecko response`);
      }
      prices[symbol] = price;
    }

    cache = { prices, fetchedAt: now };
    return { prices, fetchedAt: now, stale: false };

  } catch (err) {
    // If we have a stale cache, use it and flag it
    if (cache) {
      console.warn(`CoinGecko fetch failed, using stale prices (${Math.round((now - cache.fetchedAt) / 1000)}s old):`, err.message);
      return { prices: cache.prices, fetchedAt: cache.fetchedAt, stale: true };
    }

    // No cache at all — nothing we can do
    throw new Error(`Couldn't fetch token prices and no cache available: ${err.message}`);
  }
}

/** The set of supported token symbols. */
const SUPPORTED_TOKENS = new Set(Object.keys(TOKEN_IDS));

module.exports = { getTokenPricesUsd, SUPPORTED_TOKENS };
