/**
 * rateSource.js
 * -------------
 * Talks to PAJ Cash's real, public rate endpoint — the same one their
 * official `paj_ramp` SDK (npmjs.com/package/paj_ramp) uses under the hood.
 * No API key or login required; it's the `/pub/rate` route.
 *
 * Docs reference: https://www.npmjs.com/package/paj_ramp (see getAllRate)
 *
 * CONFIG (optional, set in .env / Fly secrets):
 *   PAJ_ENV - "production" (default) or "staging"
 */

const BASE_URLS = {
  production: "https://api.paj.cash",
  staging: "https://api-staging.paj.cash",
};

async function getRate() {
  const env = process.env.PAJ_ENV === "staging" ? "staging" : "production";
  const baseUrl = BASE_URLS[env];
  const url = `${baseUrl}/pub/rate`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) {
    throw new Error(`Rate request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const onRamp = data?.onRampRate;
  const offRamp = data?.offRampRate;

  if (!onRamp || !offRamp || typeof offRamp.rate !== "number") {
    throw new Error(
      `Unexpected response shape from ${url}: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  return {
    onRamp: {
      rate: onRamp.rate,
      pair: `${onRamp.baseCurrency}/${onRamp.targetCurrency}`,
      isActive: onRamp.isActive,
    },
    offRamp: {
      rate: offRamp.rate,
      pair: `${offRamp.baseCurrency}/${offRamp.targetCurrency}`,
      isActive: offRamp.isActive,
    },
    fetchedAt: new Date(),
  };
}

module.exports = { getRate };
