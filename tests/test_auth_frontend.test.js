/* 0830 — auth.js Demo 跨頁持久化與 Supabase null event 競態回歸測試。 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const sourcePath = path.join(__dirname, "..", "static", "js", "auth.js");
const moduleSource = fs.readFileSync(sourcePath, "utf8")
  .replace(/^import\s+\{\s*createClient\s*\}[^;]+;\s*/, "const createClient = globalThis.__createClient;\n");

function makeClassList() {
  const values = new Set();
  return {
    toggle(name, force) {
      if (force) values.add(name);
      else values.delete(name);
    },
    contains(name) { return values.has(name); },
  };
}

function makeStorage(initial = {}) {
  const values = { ...initial };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
    setItem(key, value) { values[key] = String(value); },
    removeItem(key) { delete values[key]; },
  };
}

async function main() {
  let authCallback = null;
  let supabaseSession = null;
  const body = { classList: makeClassList() };
  const localStorage = makeStorage({ si_demo_member: "1" });
  const fakeSupabase = {
    auth: {
      getSession: async () => ({ data: { session: supabaseSession }, error: null }),
      onAuthStateChange(callback) { authCallback = callback; return { data: { subscription: {} } }; },
      signOut: async () => ({ error: null }),
    },
  };
  const events = [];
  const listeners = new Map();
  const requests = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise,
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
    localStorage,
    sessionStorage: makeStorage(),
    alert() {},
    document: {
      body,
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
    location: { origin: "http://127.0.0.1:5000", pathname: "/health", search: "", hash: "" },
    history: { replaceState() {} },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatchEvent(event) {
      events.push(event);
      // Bound a broken implementation so a regression fails instead of hanging.
      if (events.length <= 20) {
        for (const callback of listeners.get(event.type) || []) callback(event);
      }
      return true;
    },
    async fetch(url, options) {
      requests.push({ url, options });
      return { ok: true, status: 200, async json() { return { portfolio: {}, trades: [] }; } };
    },
    __SUPABASE_CONFIG__: { url: "https://example.invalid", anonKey: "public-test-key" },
    __createClient() { return fakeSupabase; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(moduleSource, sandbox, { filename: sourcePath });

  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(typeof authCallback, "function", "Supabase auth listener 未註冊");
  assert.strictEqual(sandbox.authManager.isLoggedIn(), true, "跨頁初始化未恢復 Demo session");
  assert.strictEqual(body.classList.contains("is-logged-in"), true);

  authCallback("INITIAL_SESSION", null);
  assert.strictEqual(sandbox.authManager.isLoggedIn(), true, "Supabase null event 不得覆寫 Demo session");
  assert.strictEqual(body.classList.contains("is-member-locked"), false);
  assert.ok(events.some((event) => event.type === "smartinvest:auth-state" && event.detail.isMember));

  // Exercise the real member page listener, not a stand-in for its refresh logic.
  const memberPath = path.join(__dirname, "..", "static", "js", "member.js");
  vm.runInContext(fs.readFileSync(memberPath, "utf8"), sandbox, { filename: memberPath });
  events.length = 0;
  assert.strictEqual(await sandbox.authManager.getToken(), "smartinvest-demo-member-token");
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(events.length, 0, "Demo 讀取 token 不得重發登入事件");
  assert.strictEqual(requests.length, 0, "Demo 讀取 token 不得觸發會員資料刷新");

  const realSession = { access_token: "synthetic-real-token", user: { id: "user-1", email: "member@example.invalid" } };
  supabaseSession = realSession;
  authCallback("SIGNED_IN", realSession);
  assert.strictEqual(sandbox.authManager.isDemoMember(), false, "真實登入應清除 Demo marker");
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(events.length, 1, "正式登入只能發送一次狀態事件，不得循環刷新");
  assert.deepStrictEqual(requests.map((request) => request.url).sort(), [
    "/api/asset-sync/portfolio", "/api/sim-trade/history?limit=50", "/api/sim-trade/portfolio",
  ].sort(), "登入後每個會員 API 應只讀取一次");
  assert.ok(requests.every((request) => request.options.headers.Authorization === "Bearer synthetic-real-token"));

  events.length = 0;
  requests.length = 0;
  supabaseSession = { ...realSession, access_token: "synthetic-refreshed-token" };
  assert.strictEqual(await sandbox.authManager.getToken(), "synthetic-refreshed-token");
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(events.length, 0, "正式會員讀取新 token 不得重發登入事件");
  assert.strictEqual(requests.length, 0, "正式會員讀取 token 不得刷新會員資料");

  // The logout assertion below only needs the auth UI, not a waiting member page.
  listeners.clear();
  supabaseSession = null;
  authCallback("SIGNED_OUT", null);
  assert.strictEqual(sandbox.authManager.isLoggedIn(), false, "真實登出後不應復活舊 Demo session");

  console.log("PASS auth Demo 跨頁恢復");
  console.log("PASS Supabase null event 不覆寫 Demo session");
  console.log("PASS 真實 Supabase session 可取代 Demo session");
  console.log("PASS Demo 讀取 token 不觸發會員循環刷新");
  console.log("PASS 正式登入只載入一次會員資料");
  console.log("PASS 取得更新後的 token 不重發登入事件");
  console.log("ALL PASS 6/6");
}

main().catch((error) => {
  console.error("FAIL", error.message);
  process.exit(1);
});
