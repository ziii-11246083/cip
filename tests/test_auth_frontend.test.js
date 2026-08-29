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
  const body = { classList: makeClassList() };
  const localStorage = makeStorage({ si_demo_member: "1" });
  const fakeSupabase = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange(callback) { authCallback = callback; return { data: { subscription: {} } }; },
      signOut: async () => ({ error: null }),
    },
  };
  const events = [];
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
    },
    location: { origin: "http://127.0.0.1:5000", pathname: "/health", search: "", hash: "" },
    history: { replaceState() {} },
    dispatchEvent(event) { events.push(event); return true; },
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

  const realSession = { access_token: "synthetic-real-token", user: { id: "user-1", email: "member@example.invalid" } };
  authCallback("SIGNED_IN", realSession);
  assert.strictEqual(sandbox.authManager.isDemoMember(), false, "真實登入應清除 Demo marker");
  authCallback("SIGNED_OUT", null);
  assert.strictEqual(sandbox.authManager.isLoggedIn(), false, "真實登出後不應復活舊 Demo session");

  console.log("PASS auth Demo 跨頁恢復");
  console.log("PASS Supabase null event 不覆寫 Demo session");
  console.log("PASS 真實 Supabase session 可取代 Demo session");
  console.log("ALL PASS 3/3");
}

main().catch((error) => {
  console.error("FAIL", error.message);
  process.exit(1);
});
