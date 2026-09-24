"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
let source = fs.readFileSync(path.join(__dirname, "../static/js/sim_trade.js"), "utf8");
// Expose closure functions only inside this test sandbox.
source = source.replace(/\}\)\(\);\s*$/, `
  globalThis.testApi = {
    runStressTest, refreshPortfolio,
    setPortfolio(value) { currentPortfolio = value; },
    result() { return lastStressResult; },
    mockRequest(fn) { request = fn; },
  };
  updateKpis = renderPositions = drawEquity = drawAlloc = updateQuotePanel = () => {};
})();`);
const elements = {
  stressResults: { children: ["old result"], replaceChildren() { this.children = []; } },
  stressStatus: {},
};
const sandbox = {
  document: { getElementById: id => elements[id] || null, addEventListener() {} },
  window: { addEventListener() {} },
};
vm.runInNewContext(source, sandbox);
const api = sandbox.testApi;
const portfolio = { cash: 100, positions: [{ symbol: "BTC", market_value: 100 }] };
async function main() {
  api.setPortfolio(portfolio);
  let resolveOld;
  api.mockRequest(() => new Promise(resolve => { resolveOld = resolve; }));
  const oldRun = api.runStressTest();
  assert.equal(elements.stressResults.children.length, 0, "new run clears old data");
  api.mockRequest(async () => ({ portfolio }));
  await api.refreshPortfolio();
  resolveOld({ stress_test: { stale: true } });
  await oldRun;
  assert.equal(api.result(), null, "old response cannot restore an obsolete snapshot");
  assert.match(elements.stressStatus.textContent, /組合已更新/);
  elements.stressResults.children = ["old result"];
  api.mockRequest(async () => { throw new Error("test failure"); });
  await api.runStressTest();
  assert.equal(elements.stressResults.children.length, 0);
  assert.equal(api.result(), null);
  assert.equal(elements.stressStatus.textContent, "test failure");
  console.log("PASS stale responses and failed reruns never display previous stress data");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
