/**
 * convert.js
 * ----------
 * Converts an amount between fiat and crypto using the live onramp
 * (buy) / offramp (sell) rates. Defaults to treating the amount as
 * fiat unless a crypto symbol is given.
 */

function convert(amount, unit, rateData) {
  const { onRamp, offRamp } = rateData;
  const [fiatSymbol, cryptoSymbol] = onRamp.pair.split("/");

  const isFiat = !unit || unit.toUpperCase() === fiatSymbol.toUpperCase();

  if (isFiat) {
    const cryptoAmount = amount / onRamp.rate;
    return {
      input: `${amount.toLocaleString("en-NG")} ${fiatSymbol}`,
      output: `${cryptoAmount.toFixed(6)} ${cryptoSymbol}`,
      rateLine: `Buy rate: 1 ${cryptoSymbol} = ${onRamp.rate.toLocaleString("en-NG")} ${fiatSymbol}`,
    };
  }

  if (unit.toUpperCase() !== cryptoSymbol.toUpperCase()) {
    return { error: `Unknown unit "${unit}". Use ${fiatSymbol} or ${cryptoSymbol}.` };
  }

  const fiatAmount = amount * offRamp.rate;
  return {
    input: `${amount} ${cryptoSymbol}`,
    output: `${fiatAmount.toLocaleString("en-NG")} ${fiatSymbol}`,
    rateLine: `Sell rate: 1 ${cryptoSymbol} = ${offRamp.rate.toLocaleString("en-NG")} ${fiatSymbol}`,
  };
}

module.exports = { convert };
