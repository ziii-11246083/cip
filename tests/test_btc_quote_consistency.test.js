"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let quoteAvailable = true;
const calls = [];
async function fetch(url) {
  calls.push(url);
  if (url.startsWith("/crypto/quote?")) {
    return { ok: quoteAvailable, async json() { return { current_price: quoteAvailable ? 83210 : null }; } };
  }
  if (url.startsWith("/crypto/popular?")) {
    return { ok: true, async json() { return [{ symbol: "BTC", name: "Bitcoin", current_price: 65000 }]; } };
  }
  if (url.startsWith("/crypto/series?")) {
    assert.ok(!url.includes("ticker=BTC"), "BTC historical close must not replace the shared spot quote");
    return { ok: true, async json() { return { prices: [[1, 120], [2, 123]] }; } };
  }
  throw new Error(`Unexpected request: ${url}`);
}

function sandbox() {
  return {
    fetch, AbortController, setTimeout, clearTimeout, console,
    document: { getElementById() { return null; }, addEventListener() {} },
    window: { addEventListener() {} },
  };
}
const market = sandbox();
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/js/market.js"), "utf8"), market);
const sim = sandbox();
const simSource = fs.readFileSync(path.join(__dirname, "../static/js/sim_trade.js"), "utf8").replace(/\}\)\(\);\s*$/, `
  globalThis.testApi = { loadCoins, refreshBtcQuote, getSelectedCoin };
})();`);
vm.runInNewContext(simSource, sim);

async function main() {
  await market.loadPopularCoins();
  await sim.testApi.loadCoins();
  assert.equal(market.getCoinBySymbol("BTC").current_price, 83210);
  assert.equal(sim.testApi.getSelectedCoin().current_price, 83210);
  console.log("PASS both pages replace the popular-list price with the shared executable quote");

  await market.loadTopCardsFromSeriesFallback();
  assert.equal(market.getCoinBySymbol("BTC").current_price, 83210);
  assert.ok(calls.some(url => url.startsWith("/crypto/series?ticker=ETH")));
  console.log("PASS historical fallback for other coins cannot overwrite the BTC quote");

  quoteAvailable = false;
  await market.loadPopularCoins();
  await sim.testApi.refreshBtcQuote();
  assert.equal(market.getCoinBySymbol("BTC"), undefined);
  assert.equal(sim.testApi.getSelectedCoin().current_price, null);
  await market.loadTopCardsFromSeriesFallback();
  assert.equal(market.getCoinBySymbol("BTC"), undefined);
  console.log("PASS unavailable quotes clear old BTC prices on both pages");

  quoteAvailable = true;
  await market.loadPopularCoins();
  await sim.testApi.refreshBtcQuote();
  assert.equal(market.getCoinBySymbol("BTC").current_price, sim.testApi.getSelectedCoin().current_price);
  console.log("PASS recovered quote restores both pages consistently");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
