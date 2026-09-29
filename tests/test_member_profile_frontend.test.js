"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function node() {
  return {
    listeners: {},
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    dataset: {},
    children: [],
    classList: { toggle() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    focus() { this.focused = true; },
  };
}

const choices = ["happy", "calm", "focus", "neutral"].map((value) => ({ value, checked: false }));
const nodes = {
  memberEmail: node(),
  memberName: node(),
  memberAvatar: node(),
  profileEditor: {
    ...node(),
    hidden: true,
    querySelector(selector) {
      return choices.find((choice) => selector.includes(`value="${choice.value}"`)) || null;
    },
  },
  profileDisplayName: node(),
  profileStatus: node(),
  profileForm: {
    ...node(),
    querySelector() { return choices.find((choice) => choice.checked) || null; },
  },
  editProfileBtn: node(),
  cancelProfileEdit: node(),
  saveProfileBtn: node(),
  subscriptionClose: node(),
  subscriptionContinueFree: node(),
  subscriptionAccountStatus: node(),
  subscriptionViewPlan: node(),
  memberCurrentTier: node(),
  memberFreeTag: node(),
  memberPremiumTag: node(),
  memberFreePlan: node(),
  memberPremiumPlan: node(),
  memberPremiumAction: node(),
  memberSubscribeLabel: node(),
  memberSubscribeHint: node(),
  realAssetForm: { ...node(), hidden: true },
  realAssetAccess: node(),
  realAssetAccessTitle: node(),
  realAssetAccessText: node(),
  realAssetStatus: node(),
  realAssetAddress: node(),
  realAssetAccounts: {
    ...node(),
    clearCount: 0,
    replaceChildren() { this.clearCount += 1; this.children = []; },
  },
  subscriptionDialog: {
    ...node(),
    showModal() { this.open = true; },
    close() { this.open = false; },
  },
};
const subscribeButton = node();
const accountLink = node();
let profile = { displayName: "原本名稱", avatarKey: "happy", email: "member@example.com" };
let isDemo = false;
let isLegacy = false;
const requests = [];
const events = {};
const sandbox = {
  document: {
    getElementById(id) { return nodes[id] || null; },
    createElement() { return node(); },
    querySelector(selector) { return selector === ".user-menu-profile-link" ? accountLink : null; },
    querySelectorAll(selector) { return selector === "[data-subscribe-open]" ? [subscribeButton] : []; },
    addEventListener(type, callback) { events[`document:${type}`] = callback; },
  },
  location: { hash: "" },
  authManager: {
    isLoggedIn: () => true,
    isDemoMember: () => isDemo,
    getMembershipTier: () => isDemo || isLegacy ? "premium" : "free",
    getProfile: () => profile,
    getToken: async () => "test-token",
    whenReady: async () => {},
    async updateProfile(next) {
      profile = { ...profile, ...next };
      return profile;
    },
  },
  fetch: async (url) => {
    requests.push(url);
    return {
    ok: true,
    status: 200,
    async json() {
      if (url === "/api/sim-trade/portfolio") return { portfolio: {} };
      if (url.startsWith("/api/sim-trade/history")) return { trades: [] };
      return { portfolio: { accounts: [] } };
    },
  }; },
  toast() {},
  addEventListener(type, callback) { events[`window:${type}`] = callback; },
  setTimeout,
  clearTimeout,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "static", "js", "member.js"), "utf8"), sandbox);

async function settleRequests() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function main() {
  events["document:DOMContentLoaded"]();
  await settleRequests();
  assert.strictEqual(nodes.memberName.textContent, "原本名稱");
  assert.strictEqual(nodes.memberEmail.textContent, "member@example.com");
  assert.strictEqual(nodes.memberCurrentTier.textContent, "目前方案：免費會員");
  assert.strictEqual(nodes.memberFreeTag.hidden, false);
  assert.strictEqual(nodes.memberPremiumTag.textContent, "規劃中");
  assert.strictEqual(nodes.realAssetForm.hidden, true, "free account cannot connect");

  nodes.editProfileBtn.listeners.click();
  assert.strictEqual(nodes.profileEditor.hidden, false);
  assert.strictEqual(nodes.profileDisplayName.value, "原本名稱");
  assert.strictEqual(choices[0].checked, true);

  nodes.profileDisplayName.value = "新的名稱";
  choices[0].checked = false;
  choices[2].checked = true;
  await nodes.profileForm.listeners.submit({ preventDefault() {} });
  assert.strictEqual(nodes.memberName.textContent, "新的名稱");
  assert(nodes.memberAvatar.src.endsWith("agent-cat-focus.png"));
  assert.strictEqual(nodes.profileEditor.hidden, true);

  subscribeButton.listeners.click();
  assert.strictEqual(nodes.subscriptionDialog.open, true);
  assert.strictEqual(nodes.subscriptionAccountStatus.textContent, "目前狀態：免費會員（尚無付費訂閱）");
  nodes.subscriptionClose.listeners.click();
  assert.strictEqual(nodes.subscriptionDialog.open, false);
  subscribeButton.listeners.click();
  nodes.subscriptionContinueFree.listeners.click();
  assert.strictEqual(nodes.subscriptionDialog.open, false);

  isLegacy = true;
  events["window:smartinvest:auth-state"]();
  await settleRequests();
  assert.strictEqual(nodes.memberCurrentTier.textContent, "目前方案：進階會員");
  assert.strictEqual(nodes.realAssetForm.hidden, false, "existing member can preview wallet connection");

  isLegacy = false;
  isDemo = true;
  events["window:smartinvest:auth-state"]();
  await settleRequests();
  assert.strictEqual(nodes.memberCurrentTier.textContent, "目前方案：進階會員（TEST）");
  assert.strictEqual(nodes.memberFreeTag.hidden, true);
  assert.strictEqual(nodes.memberPremiumTag.textContent, "目前方案");
  assert(nodes.memberPremiumAction.innerHTML.includes("查看會員狀態"));
  assert.strictEqual(nodes.realAssetForm.hidden, false, "TEST can preview wallet connection");
  nodes.realAssetAddress.value = "invalid";
  nodes.realAssetForm.listeners.submit({ preventDefault() {} });
  assert(nodes.realAssetStatus.textContent.includes("請輸入"));
  nodes.realAssetAddress.value = "0x" + "a".repeat(40);
  nodes.realAssetForm.listeners.submit({ preventDefault() {} });
  assert.strictEqual(nodes.realAssetAccounts.children.length, 1, "preview wallet appears");
  const previewButton = (assetAction) => ({
    disabled: false,
    dataset: { assetAction },
  });
  nodes.realAssetAccounts.listeners.click({ target: { closest: () => previewButton("sync") } });
  assert(nodes.realAssetStatus.textContent.includes("不會讀取"));
  nodes.realAssetAccounts.listeners.click({ target: { closest: () => previewButton("disconnect") } });
  assert.strictEqual(nodes.realAssetAccounts.children.length, 0, "preview wallet disconnects");
  assert(!requests.some((url) => url.includes("/api/asset-sync/")), "preview must not call live asset API");
  subscribeButton.listeners.click();
  assert.strictEqual(nodes.subscriptionAccountStatus.textContent, "目前狀態：進階會員（TEST，無扣款）");
  assert(nodes.realAssetAccounts.clearCount >= 3, "account switches clear old wallet content");

  accountLink.listeners.click();
  assert.strictEqual(nodes.profileEditor.hidden, false, "account link reopens editor on the same page");
  nodes.cancelProfileEdit.listeners.click();
  assert.strictEqual(nodes.profileEditor.hidden, true);
  console.log("ALL PASS: profile editing, avatar update, subscription dialog, account link");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
