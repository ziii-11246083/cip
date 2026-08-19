/*
 * TASK 04（Codex R1 修正後）— ai_coach.js 前端純函式／DOM 安全渲染測試（Node）。
 * 以 vm sandbox 載入 static/js/ai_coach.js（stub document/window/localStorage）。
 * 所有 check 皆以 await 依序執行；全部 PASS 才輸出 ALL PASS 並 exit 0。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const JS_PATH = path.join(__dirname, "..", "static", "js", "ai_coach.js");
const source = fs.readFileSync(JS_PATH, "utf8");

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS", name);
  } catch (err) {
    failures += 1;
    console.log("FAIL", name, "-", err.message);
  }
}

// ── 最小 DOM stub ────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tag,
    children: [],
    listeners: {},
    textContent: "",
    className: "",
    id: "",
    value: "",
    dataset: {},
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    disabled: false,
    _attrs: {},
    classList: {
      _set: new Set(),
      toggle(cls, force) {
        if (force === undefined) {
          this._set.has(cls) ? this._set.delete(cls) : this._set.add(cls);
        } else if (force) this._set.add(cls);
        else this._set.delete(cls);
      },
      add(cls) { this._set.add(cls); },
      remove(cls) { this._set.delete(cls); },
      contains(cls) { return this._set.has(cls); },
    },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, cb) { this.listeners[type] = cb; },
    setAttribute(name, value) { this._attrs[name] = value; },
    removeAttribute(name) { delete this._attrs[name]; },
    getAttribute(name) { return this._attrs[name]; },
    remove() { this._removed = true; },
    focus() { this._focused = true; },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._innerHTML || ""; },
    set(v) { this._innerHTML = v; sandbox.__innerHTMLSets += 1; },
  });
  return el;
}

const streamStub = makeEl("div");
streamStub.id = "chatStream";
const sandbox = {
  console,
  document: {
    addEventListener() {},
    getElementById(id) { return id === "chatStream" ? streamStub : null; },
    createElement: makeEl,
    querySelectorAll() { return []; },
  },
  localStorage: {
    _store: {},
    getItem(k) { return this._store[k] || null; },
    setItem(k, v) { this._store[k] = String(v); },
    removeItem(k) { delete this._store[k]; },
  },
  fetch: () => Promise.reject(new Error("network down")),
  __innerHTMLSets: 0,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: JS_PATH });

const hooks = sandbox.window.aiCoachTestHooks;

function runInSandbox(fnBody) {
  return vm.runInContext(fnBody, sandbox);
}

function flushStream() {
  streamStub.children.length = 0;
}

function lastBubble() {
  const row = streamStub.children[streamStub.children.length - 1];
  return row.children.find((c) => c.className === "bubble");
}

function renderWithMeta(metaBody) {
  flushStream();
  runInSandbox(`window.aiCoachTestHooks.appendChatBubble("Smart Invest AI 教練", "回答", false, ${metaBody});`);
  return lastBubble();
}

async function main() {
  // ── 純函式測試 ─────────────────────────────────────────────────
  await check("citationLines: 字串 citation", () => {
    const lines = JSON.parse(JSON.stringify(hooks.citationLines("知識庫: investment_rules.md (投資原則)")));
    assert.deepStrictEqual(lines, [{ label: "來源", text: "知識庫: investment_rules.md (投資原則)" }]);
  });

  await check("citationLines: 結構化 citation 全欄位", () => {
    const lines = JSON.parse(JSON.stringify(hooks.citationLines({
      source: "investment_rules.md", topic: "投資原則", section: "DCA", chunk_id: "investment_rules#3",
    })));
    assert.deepStrictEqual(lines, [
      { label: "來源", text: "investment_rules.md" },
      { label: "主題", text: "投資原則" },
      { label: "章節", text: "DCA" },
      { label: "段落", text: "investment_rules#3" },
    ]);
  });

  await check("citationLines: 結構化 citation 缺欄位不補假資料", () => {
    const lines = JSON.parse(JSON.stringify(hooks.citationLines({ source: "coin_profiles.json", chunk_id: "coin_profiles#0" })));
    assert.deepStrictEqual(lines, [
      { label: "來源", text: "coin_profiles.json" },
      { label: "段落", text: "coin_profiles#0" },
    ]);
  });

  await check("citationLines: 空／無效輸入回 null", () => {
    assert.strictEqual(hooks.citationLines(""), null);
    assert.strictEqual(hooks.citationLines(123), null);
    assert.strictEqual(hooks.citationLines([]), null);
    assert.strictEqual(hooks.citationLines(null), null);
  });

  await check("citationLines: XSS payload 只當純文字資料", () => {
    const payload = '<img src=x onerror="alert(1)">';
    const lines = hooks.citationLines(payload);
    assert.strictEqual(lines[0].text, payload);
    const lines2 = hooks.citationLines({ source: payload, section: "<script>bad()</script>" });
    assert.strictEqual(lines2[0].text, payload);
    assert.strictEqual(lines2[1].text, "<script>bad()</script>");
  });

  await check("displayableCitationCount: 只計可顯示來源", () => {
    assert.strictEqual(hooks.displayableCitationCount(["a", null, {}, { source: "x" }]), 2);
    assert.strictEqual(hooks.displayableCitationCount([null, {}]), 0);
    assert.strictEqual(hooks.displayableCitationCount([]), 0);
    assert.strictEqual(hooks.displayableCitationCount(null), 0);
  });

  await check("hintsFor: high confidence 且有來源 → 無提示", () => {
    assert.strictEqual(JSON.stringify(hooks.hintsFor("high", true)), "[]");
  });

  await check("hintsFor: low confidence → 低信心提示", () => {
    const hints = hooks.hintsFor("low", true);
    assert.strictEqual(hints.length, 1);
    assert.ok(hints[0].includes("資訊有限"));
  });

  await check("hintsFor: 無來源 → 未取得可引用知識提示", () => {
    const hints = hooks.hintsFor("high", false);
    assert.strictEqual(hints.length, 1);
    assert.ok(hints[0].includes("未取得可引用知識"));
  });

  await check("hintsFor: low confidence 且無來源 → 兩則提示", () => {
    assert.strictEqual(hooks.hintsFor("low", false).length, 2);
  });

  await check("feedbackVisible: 與 API 契約一致（8–128）", () => {
    assert.strictEqual(hooks.feedbackVisible("a".repeat(32)), true);
    assert.strictEqual(hooks.feedbackVisible("a".repeat(8)), true);
    assert.strictEqual(hooks.feedbackVisible("a".repeat(128)), true);
    assert.strictEqual(hooks.feedbackVisible("a".repeat(129)), false); // 超出 API 上限
    assert.strictEqual(hooks.feedbackVisible("short"), false);
    assert.strictEqual(hooks.feedbackVisible(""), false);
    assert.strictEqual(hooks.feedbackVisible(null), false);
    assert.strictEqual(hooks.feedbackVisible(undefined), false);
    assert.strictEqual(hooks.feedbackVisible(123), false);
  });

  // ── DOM 渲染路徑測試 ───────────────────────────────────────────
  await check("appendChatBubble: 舊 history 無 meta 不產生新 UI", () => {
    flushStream();
    runInSandbox(`window.aiCoachTestHooks.appendChatBubble("Smart Invest AI 教練", "舊回答", false);`);
    const bubble = lastBubble();
    assert.ok(bubble);
    assert.ok(!bubble.children.some((c) => c.className === "cite-details"));
    assert.ok(!bubble.children.some((c) => c.className === "feedback-bar"));
    assert.ok(!bubble.children.some((c) => c.className === "confidence-note"));
  });

  await check("appendChatBubble: 有 citations/confidence/trace_id 顯示新 UI", () => {
    const bubble = renderWithMeta(`{
      citations: ["知識庫: investment_rules.md (投資原則)"],
      confidence: "low",
      trace_id: "a".repeat(32),
    }`);
    const notes = bubble.children.filter((c) => c.className === "confidence-note");
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].textContent.includes("資訊有限"));
    const cite = bubble.children.find((c) => c.className === "cite-details");
    assert.ok(cite);
    const listItems = cite.children.find((c) => c.className === "cite-list").children;
    assert.strictEqual(listItems.length, 1);
    assert.strictEqual(listItems[0].children[1].textContent, "知識庫: investment_rules.md (投資原則)");
    const bar = bubble.children.find((c) => c.className === "feedback-bar");
    assert.ok(bar);
    assert.strictEqual(bar.children.filter((c) => c.className === "feedback-btn").length, 2);
  });

  await check("appendChatBubble: 無 citations → 提示但不顯示來源區塊", () => {
    const bubble = renderWithMeta(`{
      citations: [], confidence: "high", trace_id: "a".repeat(32),
    }`);
    const notes = bubble.children.filter((c) => c.className === "confidence-note");
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].textContent.includes("未取得可引用知識"));
    assert.ok(!bubble.children.some((c) => c.className === "cite-details"));
  });

  await check("appendChatBubble: invalid-only citations 等同無來源", () => {
    // citations=[null, {}]：不可顯示 → 顯示 no-source 提示、不建立空 details、不顯示假數量
    const bubble = renderWithMeta(`{
      citations: [null, {}], confidence: "high", trace_id: "a".repeat(32),
    }`);
    const notes = bubble.children.filter((c) => c.className === "confidence-note");
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].textContent.includes("未取得可引用知識"));
    assert.ok(!bubble.children.some((c) => c.className === "cite-details"));
  });

  await check("appendChatBubble: 無 trace_id → 不建立 feedback 按鈕", () => {
    const bubble = renderWithMeta(`{
      citations: ["知識庫: investment_rules.md (投資原則)"], confidence: "high",
    }`);
    assert.ok(!bubble.children.some((c) => c.className === "feedback-bar"));
  });

  await check("appendChatBubble: 129 字 trace_id 不渲染 feedback 按鈕", () => {
    const bubble = renderWithMeta(`{
      citations: [], confidence: "high", trace_id: "a".repeat(129),
    }`);
    assert.ok(!bubble.children.some((c) => c.className === "feedback-bar"));
  });

  await check("渲染路徑不經 innerHTML（server data 全部 textContent）", () => {
    sandbox.__innerHTMLSets = 0;
    renderWithMeta(`{
      citations: ["<img src=x onerror=alert(1)>"], confidence: "low", trace_id: "a".repeat(32),
    }`);
    assert.strictEqual(sandbox.__innerHTMLSets, 0);
  });

  // ── feedback 互動測試 ──────────────────────────────────────────
  await check("feedback network failure：錯誤提示出現、回答仍存在", async () => {
    sandbox.fetch = () => Promise.reject(new Error("network down"));
    sandbox.authManager = { getToken: async () => "test-token" };
    const bubble = renderWithMeta(`{ citations: [], confidence: "high", trace_id: "a".repeat(32) }`);
    const bar = bubble.children.find((c) => c.className === "feedback-bar");
    const up = bar.children.find((c) => c.className === "feedback-btn");
    await up.listeners.click();
    const errorEl = bar.children.find((c) => c.className === "feedback-error");
    assert.ok(errorEl.textContent.includes("重試"));
    assert.strictEqual(streamStub.children.length, 1); // 回答仍在
  });

  await check("feedback 401：顯示登入提示、不移除回答", async () => {
    sandbox.authManager = { getToken: async () => null };
    const bubble = renderWithMeta(`{ citations: [], confidence: "high", trace_id: "a".repeat(32) }`);
    const bar = bubble.children.find((c) => c.className === "feedback-bar");
    const up = bar.children.find((c) => c.className === "feedback-btn");
    await up.listeners.click();
    const errorEl = bar.children.find((c) => c.className === "feedback-error");
    assert.ok(errorEl.textContent.includes("登入"));
    assert.strictEqual(streamStub.children.length, 1);
  });

  await check("feedback success：按鈕標記 active 與 aria-pressed", async () => {
    sandbox.authManager = { getToken: async () => "test-token" };
    sandbox.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, vote: "up", trace_id: "a".repeat(32) }),
    });
    const bubble = renderWithMeta(`{ citations: [], confidence: "high", trace_id: "a".repeat(32) }`);
    const bar = bubble.children.find((c) => c.className === "feedback-bar");
    const up = bar.children.find((c) => c.className === "feedback-btn");
    await up.listeners.click();
    assert.ok(up.classList.contains("active"));
    assert.strictEqual(up.getAttribute("aria-pressed"), "true");
  });

  await check("pending 期間快速 up/down 只發一個 fetch，完成後可改票", async () => {
    let fetchCalls = 0;
    let resolveFirst;
    const gate = new Promise((resolve) => { resolveFirst = resolve; });
    sandbox.authManager = { getToken: async () => "test-token" };
    sandbox.fetch = async (url, options) => {
      fetchCalls += 1;
      const vote = JSON.parse(options.body).vote;
      if (fetchCalls === 1) {
        await gate; // 第一個請求 pending
        return { ok: true, json: async () => ({ ok: true, vote, trace_id: "a".repeat(32) }) };
      }
      return { ok: true, json: async () => ({ ok: true, vote, trace_id: "a".repeat(32) }) };
    };
    const bubble = renderWithMeta(`{ citations: [], confidence: "high", trace_id: "a".repeat(32) }`);
    const bar = bubble.children.find((c) => c.className === "feedback-bar");
    const [up, down] = bar.children.filter((c) => c.className === "feedback-btn");

    const first = up.listeners.click();   // 送出 up（pending）
    await Promise.resolve();
    await down.listeners.click();         // pending 期間點 down → 必須被忽略
    assert.strictEqual(fetchCalls, 1);
    assert.strictEqual(up.disabled, true);
    assert.strictEqual(down.disabled, true);
    assert.strictEqual(bar.classList.contains("is-pending"), true);

    resolveFirst();
    await first;
    assert.strictEqual(up.disabled, false); // 完成後解除鎖定
    assert.strictEqual(down.disabled, false);

    await down.listeners.click();         // 可改票
    assert.strictEqual(fetchCalls, 2);
    assert.ok(down.classList.contains("active"));
    assert.strictEqual(down.getAttribute("aria-pressed"), "true");
    assert.strictEqual(streamStub.children.length, 1);
  });

  await check("feedback 失敗後解除鎖定可重試，回答保留", async () => {
    let calls = 0;
    sandbox.authManager = { getToken: async () => "test-token" };
    sandbox.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return { ok: true, json: async () => ({ ok: true, vote: "up", trace_id: "a".repeat(32) }) };
    };
    const bubble = renderWithMeta(`{ citations: [], confidence: "high", trace_id: "a".repeat(32) }`);
    const bar = bubble.children.find((c) => c.className === "feedback-bar");
    const up = bar.children.find((c) => c.className === "feedback-btn");

    await up.listeners.click();           // 第一次失敗
    assert.strictEqual(up.disabled, false); // 已解除鎖定
    const errorEl = bar.children.find((c) => c.className === "feedback-error");
    assert.ok(errorEl.textContent.includes("重試"));

    await up.listeners.click();           // 重試成功
    assert.strictEqual(calls, 2);
    assert.ok(up.classList.contains("active"));
    assert.strictEqual(streamStub.children.length, 1);
  });
}

main().then(() => {
  const total = passed + failures;
  console.log(`SUMMARY ${passed}/${total} PASS`);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
