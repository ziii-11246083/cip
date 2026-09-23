"use strict";

// Run with: node tests/test_registration_frontend.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const authSource = fs.readFileSync(path.join(__dirname, "../static/js/auth.js"), "utf8")
  .replace(/^import\s+\{\s*createClient\s*\}[^;]+;\s*/, "const createClient = globalThis.__createClient;\n");
const registerSource = fs.readFileSync(path.join(__dirname, "../static/js/register.js"), "utf8");

async function runRegistration({ configured = true, error = null, throws = false } = {}) {
  const elements = {
    displayName: { value: "Test Member" },
    registerEmail: { value: "member@example.invalid" },
    registerPassword: { value: "TestPassword123" },
    confirmPassword: { value: "TestPassword123" },
    agreeTerms: { checked: true },
    btnRegister: { disabled: false, innerHTML: "" },
    messageBox: { className: "", textContent: "" },
  };
  const payloads = [];
  const alerts = [];
  let reloads = 0;
  const storage = { getItem() { return null; }, removeItem() {} };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    localStorage: storage, sessionStorage: storage,
    document: {
      getElementById(id) { return elements[id] || null; },
      querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {},
    },
    location: { origin: "http://localhost", pathname: "/register", search: "", hash: "", reload() { reloads++; } },
    dispatchEvent() {},
    alert(message) { alerts.push(message); },
    __SUPABASE_CONFIG__: configured ? { url: "https://example.invalid", anonKey: "test-public-key" } : {},
    __createClient() {
      return { auth: {
        async getSession() { return { data: { session: null }, error: null }; },
        onAuthStateChange() {},
        async signUp(payload) {
          payloads.push(payload);
          if (throws) throw new Error("Offline test failure");
          return { error };
        },
      } };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(authSource, sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext(registerSource, sandbox);
  await sandbox.registerUser({ preventDefault() {} });
  return { elements, payloads, alerts, reloads };
}

async function main() {
  for (const options of [
    { configured: false },
    { error: { message: "Registration rejected" } },
    { throws: true },
  ]) {
    const result = await runRegistration(options);
    assert.equal(result.elements.messageBox.className, "message-box show error");
    assert.ok(!result.alerts.some((message) => message.includes("註冊成功")));
    assert.equal(result.elements.btnRegister.disabled, false);
    assert.equal(result.reloads, 0);
    console.log("PASS 註冊失敗不顯示成功、不重新載入，並恢復按鈕", JSON.stringify(options));
  }
  const result = await runRegistration();
  assert.equal(result.elements.messageBox.className, "message-box show success");
  assert.equal(result.payloads.length, 1);
  assert.equal(result.payloads[0].options.data.display_name, "Test Member");
  assert.equal(result.reloads, 1);
  assert.equal(result.elements.btnRegister.disabled, false);
  console.log("PASS 真正註冊成功才顯示成功，暱稱仍傳給 Supabase");
  console.log("ALL PASS 4/4");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
