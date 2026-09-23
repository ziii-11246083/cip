"use strict";

// Run with: node tests/test_member_rendering.test.js (offline DOM/fetch stubs).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../static/js/member.js"), "utf8");

function element(tag) {
  return {
    tag, children: [], dataset: {}, textContent: "", className: "",
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
    set innerHTML(value) { throw new Error("Capital records must not use an HTML sink"); },
  };
}

async function render({ records = [], equity = [], demo = true } = {}) {
  const capitalList = element("div");
  const listeners = new Map();
  let onReady;
  const sandbox = {
    console,
    document: {
      getElementById(id) { return id === "capitalList" ? capitalList : null; },
      createElement: element,
      addEventListener(type, callback) { if (type === "DOMContentLoaded") onReady = callback; },
    },
    authManager: { getToken: async () => "test-token", isDemoMember: () => demo },
    addEventListener(type, callback) { listeners.set(type, callback); },
    async fetch() {
      return {
        ok: true, status: 200,
        async json() {
          return { portfolio: { capital_records: records, equity_curve: equity }, trades: [] };
        },
      };
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "member.js" });
  onReady();
  await new Promise((resolve) => setImmediate(resolve));
  return {
    capitalList,
    async refresh() {
      listeners.get("smartinvest:sim-trade-updated")();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function main() {
  const note = '<img src=x onerror="throw new Error(1)"> & "備註"';
  const id = 'record-id" onclick="throw new Error(2)';
  const records = [{ id, note, amount_usd: 100, timestamp: "2026-09-23T00:00:00Z" }];
  const demo = await render({ records });
  assert.equal(demo.capitalList.children.length, 1);
  const [info, actions] = demo.capitalList.children[0].children;
  assert.equal(info.children[1].tag, "span");
  assert.equal(info.children[1].textContent, note);
  assert.equal(info.children[1].children.length, 0);
  assert.equal(actions.children[1].tag, "button");
  assert.equal(actions.children[1].type, "button");
  assert.equal(actions.children[1].dataset.capitalId, id);
  assert.equal(actions.children[1].className, "capital-delete-btn");
  console.log("PASS 備註以純文字呈現，Demo 刪除 ID 透過 dataset 保留");

  await demo.refresh();
  assert.equal(demo.capitalList.children.length, 1);
  console.log("PASS 再次刷新會取代舊紀錄，不重複累加");

  const member = await render({ records, demo: false });
  assert.equal(member.capitalList.children[0].children[1].children.length, 1);
  console.log("PASS 正式會員不顯示 Demo 專用刪除按鈕");

  const empty = await render();
  assert.equal(empty.capitalList.children[0].className, "member-record-empty");
  assert.equal(empty.capitalList.children[0].textContent, "尚未產生資產曲線紀錄。");
  console.log("PASS 無紀錄時保留空白狀態提示");

  const equity = await render({ equity: [{ ts: "2026-09-23T00:00:00Z", total_value_usd: 100 }] });
  assert.equal(equity.capitalList.children[0].children[0].children[1].textContent, "資金紀錄");
  console.log("PASS 舊資產曲線仍可作為備用紀錄");
  console.log("ALL PASS 5/5");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
