"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const elements = Object.fromEntries(["kVol", "kMdd", "riskMeterText", "riskBadgeMini", "riskBar"].map(id => [id, {textContent: "", style: {}}]));
const sandbox = {
  console, document: {getElementById: id => elements[id] || null, addEventListener() {}},
  window: {authManager: {isLoggedIn: () => true}, addEventListener() {}},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/js/health.js"), "utf8"), sandbox);
vm.runInContext('portfolioAssets = {BTC: {symbol: "BTC", amount: 100}}; saveHealthRecord = () => {}; setAnalyzeLoading = () => {};', sandbox);
async function main() {
  sandbox.fetch = async () => ({ok: true, json: async () => ({risk_health: {top1_weight: 1, top3_weight: 1, annual_vol: null, max_drawdown: null, market_data_available: false}})});
  await sandbox.analyzePortfolio();
  assert.equal(elements.kVol.textContent, "資料不足");
  assert.equal(elements.kMdd.textContent, "資料不足");
  assert.equal(elements.riskMeterText.textContent, "行情不足，無法評分");
  sandbox.fetch = async () => ({ok: false});
  await sandbox.analyzePortfolio();
  assert.equal(elements.kVol.textContent, "尚未取得行情");
  assert.equal(elements.kMdd.textContent, "尚未取得行情");
  sandbox.fetch = async () => ({ok: true, json: async () => ({risk_health: {annual_vol: 0, max_drawdown: 0, market_data_available: true}})});
  await sandbox.analyzePortfolio();
  assert.equal(elements.kVol.textContent, "0.0%");
  console.log("PASS missing data, failed requests, and measured zero remain distinct");
}
main().catch(error => {console.error(error); process.exitCode = 1;});
