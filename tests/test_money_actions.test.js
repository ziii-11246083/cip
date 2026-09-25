"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const tick = () => new Promise(resolve => setImmediate(resolve));

async function check(kind) {
  const file = kind === "order" ? "sim_trade.js" : "member.js";
  let ready, submit, resolveRequest, rejectRequest, calls = 0;
  const button = { disabled: false };
  const elements = {
    btnPlaceOrder: button,
    orderQty: {value: "1"}, orderAmt: {value: ""},
    capitalAmount: {value: "3200"}, capitalNote: {value: "test"},
    capitalForm: {querySelector: () => button, addEventListener: (type, fn) => {submit = fn;}},
  };
  const sandbox = {
    console, alert() {},
    document: {getElementById: id => elements[id] || null, addEventListener: (type, fn) => {ready = fn;}},
    window: {addEventListener() {}},
    testRequest: () => {calls++; return new Promise((resolve, reject) => {resolveRequest = resolve; rejectRequest = reject;});},
  };
  const hooks = kind === "order"
    ? "request = testRequest; refreshPortfolio = refreshTrades = async () => {}; globalThis.action = placeOrder;"
    : "request = testRequest; refreshData = async () => {}; requireMember = () => true;";
  const source = fs.readFileSync(path.join(__dirname, "../static/js", file), "utf8").replace(/\}\)\(\);\s*$/, hooks + "})();");
  vm.runInNewContext(source, sandbox);
  if(kind === "deposit") ready();
  const action = kind === "order" ? sandbox.action : () => submit({preventDefault() {}});
  action(); action();
  assert.equal(calls, 1, `${kind} must not send duplicate requests`);
  assert.equal(button.disabled, true);
  resolveRequest({});
  await tick();
  assert.equal(button.disabled, false);
  elements.orderQty.value = "1";
  elements.capitalAmount.value = "3200";
  action();
  assert.equal(calls, 2, `${kind} unlocks after success`);
  rejectRequest(new Error("test rejection"));
  await tick();
  assert.equal(button.disabled, false, `${kind} unlocks after failure`);
  console.log(`PASS ${kind}: concurrent submissions blocked, success/failure unlock controls`);
}
(async () => {await check("order"); await check("deposit");})().catch(error => {console.error(error); process.exitCode = 1;});
