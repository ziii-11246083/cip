"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function element() {
  return {
    listeners: {},
    textContent: "",
    innerHTML: "",
    classList: { toggle() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
  };
}

const nodes = {
  membershipAccountStatus: element(),
  membershipFreePlan: element(),
  membershipPremiumPlan: element(),
  membershipFreeAction: element(),
  joinPremiumBtn: element(),
  membershipDialogClose: element(),
  membershipDialog: {
    ...element(),
    showModal() { this.open = true; },
    close() { this.open = false; },
  },
};
const listeners = {};
let loggedIn = false;
let tier = "guest";
let loginCount = 0;
let assignedUrl = "";
const sandbox = {
  document: {
    getElementById(id) { return nodes[id] || null; },
    addEventListener(type, callback) { listeners[`document:${type}`] = callback; },
  },
  authManager: {
    isLoggedIn: () => loggedIn,
    getMembershipTier: () => tier,
    ensureReady: async () => {},
    whenReady: async () => {},
    openLogin() { loginCount += 1; },
  },
  location: { assign(url) { assignedUrl = url; } },
  scrollTo() {},
  addEventListener(type, callback) { listeners[`window:${type}`] = callback; },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "static/js/membership.js"), "utf8"), sandbox);

async function main() {
  listeners["document:DOMContentLoaded"]();
  await new Promise((resolve) => setImmediate(resolve));
  assert(nodes.membershipAccountStatus.textContent.includes("尚未登入"));
  assert.strictEqual(nodes.membershipFreeAction.href, "/register");
  await nodes.joinPremiumBtn.listeners.click();
  assert.strictEqual(loginCount, 1, "visitor must log in first");
  assert.strictEqual(nodes.membershipDialog.open, undefined);

  loggedIn = true;
  tier = "free";
  listeners["window:smartinvest:auth-state"]();
  assert.strictEqual(nodes.membershipFreeAction.href, "/member");
  assert(nodes.joinPremiumBtn.innerHTML.includes("加入進階會員"));
  await nodes.joinPremiumBtn.listeners.click();
  assert.strictEqual(nodes.membershipDialog.open, true, "free member sees subscription status");
  assert.strictEqual(tier, "free", "clicking cannot grant paid status");
  nodes.membershipDialogClose.listeners.click();
  assert.strictEqual(nodes.membershipDialog.open, false);

  tier = "premium";
  listeners["window:smartinvest:auth-state"]();
  assert(nodes.membershipAccountStatus.textContent.includes("進階會員"));
  await nodes.joinPremiumBtn.listeners.click();
  assert.strictEqual(assignedUrl, "/member");
  console.log("ALL PASS: visitor login gate, unpaid free-member flow, premium navigation");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
