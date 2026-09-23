"use strict";

// Run with: node tests/test_sim_trade_auth.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../static/js/sim_trade.js"), "utf8");

async function page(token) {
  let onReady;
  let reloads = 0;
  const listeners = new Map();
  const buttons = new Map();
  const classes = new Set();
  const app = { classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } } };
  const button = { addEventListener(type, callback) { buttons.set(type, callback); } };
  const sandbox = {
    console: { log() {}, warn() {} },
    document: {
      getElementById(id) { return id === "simApp" ? app : id === "btnPlaceOrder" ? button : null; },
      querySelectorAll() { return []; },
      addEventListener(type, callback) { if (type === "DOMContentLoaded") onReady = callback; },
    },
    authManager: { whenReady: async () => {}, getToken: async () => token },
    location: { reload() { reloads++; } },
    setTimeout(callback) { return setTimeout(callback, 0); },
    clearTimeout,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    async fetch() { return { ok: true, status: 200, async json() { return {}; } }; },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  const notify = (isMember) => {
    for (const listener of listeners.get("smartinvest:auth-state") || []) {
      listener({ detail: { isMember } });
    }
  };
  notify(false);
  assert.equal(reloads, 0, "初始化之前的事件不得造成重新載入循環");
  await onReady();
  return { notify, classes, buttons, reloadCount: () => reloads };
}

async function main() {
  const guest = await page(null);
  assert.equal(guest.classes.has("sim-locked"), true);
  guest.notify(false);
  assert.equal(guest.reloadCount(), 0);
  guest.notify(true);
  guest.notify(true);
  assert.equal(guest.reloadCount(), 1, "訪客登入後只重新載入一次");
  console.log("PASS 訪客頁登入後重新初始化一次，相同事件不重複重載");

  const member = await page("smartinvest-demo-member-token");
  assert.equal(member.classes.has("sim-locked"), false);
  assert.equal(typeof member.buttons.get("click"), "function");
  member.notify(true);
  assert.equal(member.reloadCount(), 0);
  member.notify(false);
  member.notify(false);
  assert.equal(member.reloadCount(), 1);
  console.log("PASS 登入後的頁面解除鎖定、綁定下單按鈕，登出時重載一次");
  console.log("ALL PASS 2/2");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
