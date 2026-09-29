"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function element(tag = "div") {
  const node = {
    tag,
    children: [],
    listeners: {},
    className: "",
    textContent: "",
    disabled: false,
    hidden: false,
    checked: false,
    classList: { toggle() {} },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    focus() { this.focused = true; },
    setAttribute() {},
  };
  Object.defineProperty(node, "innerHTML", {
    get() { return ""; },
    set(value) {
      assert.strictEqual(value, "", "API data must never be assigned to innerHTML");
      this.children = [];
    },
  });
  return node;
}

const nodes = {
  coachPlanResult: element(),
  coachPlanStatus: element(),
  coachPortfolioContent: element(),
  coachPortfolioStatus: element(),
  coachGoal: element("textarea"),
  coachBudget: element("input"),
  coachChatView: element(),
  coachPlanView: element(),
  coachPortfolioView: element(),
};
const storage = new Map();
const calls = [];
const sandbox = {
  document: {
    getElementById(id) { return nodes[id] || null; },
    createElement: element,
    addEventListener() {},
  },
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  },
  authManager: { async getToken() { return "test-token"; } },
  fetch: async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/agent-auto-order") {
      return { ok: true, async json() { return { trades: [{ symbol: "BTC" }], scaled: false }; } };
    }
    if (url === "/api/sim-trade/portfolio") {
      return { ok: true, async json() {
        return { portfolio: {
          total_value_usd: 1200, cash: 300, unrealized_pnl: 200,
          positions: [{ symbol: "<img onerror=alert(1)>", quantity: 1, market_value: 900 }],
        } };
      } };
    }
    if (url.startsWith("/api/sim-trade/history")) {
      return { ok: true, async json() {
        return { trades: [{ side: "buy", symbol: "BTC", amount_usd: 100 }] };
      } };
    }
    throw new Error("Unexpected request: " + url);
  },
  Event: class { constructor(type) { this.type = type; } },
  dispatchEvent() {},
  addEventListener() {},
  Intl,
  Number,
  String,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "static", "js", "ai_coach.js"), "utf8"), sandbox);
const hooks = sandbox.aiCoachTestHooks;

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

async function main() {
  const template = fs.readFileSync(path.join(__dirname, "..", "templates", "ai_coach.html"), "utf8");
  assert((template.match(/data-plan-example=/g) || []).length >= 3);
  assert(template.includes("你的專屬個人教練"));
  assert(template.includes("> 教我買</button>"));
  hooks.selectPlanExample({ planExample: "規劃 200 USD BTC", planBudget: "200" });
  assert.strictEqual(nodes.coachGoal.value, "規劃 200 USD BTC");
  assert.strictEqual(nodes.coachBudget.value, "200");
  assert.strictEqual(nodes.coachPlanView.hidden, false);
  assert.strictEqual(nodes.coachChatView.hidden, true);
  assert.strictEqual(nodes.coachGoal.focused, true);
  assert.strictEqual(calls.length, 0, "example prompt must not place an order");

  storage.set("smartinvest_ai_agent_conversation_id", "old-agent-chat");
  hooks.migrateAgentConversation();
  assert.strictEqual(storage.get("smartinvest_ai_coach_conversation_id"), "old-agent-chat");
  assert.strictEqual(storage.has("smartinvest_ai_agent_conversation_id"), false);

  hooks.renderPlan({
    summary: "<script>alert(1)</script>",
    steps: ["先查看風險"],
    risks: ["不可保證收益"],
    allocation: [
      { symbol: "BTC", amount_usd: 900 },
      { symbol: "ETH", amount_usd: 900 },
      { symbol: "<img>", amount_usd: 500 },
    ],
  }, 1000);
  const planNodes = descendants(nodes.coachPlanResult);
  assert(planNodes.some((node) => node.textContent === "<script>alert(1)</script>"));
  assert(!planNodes.some((node) => node.tag === "script" || node.tag === "img"));
  const cells = planNodes.filter((node) => node.tag === "td");
  assert.deepStrictEqual([cells[0].textContent, cells[2].textContent], ["BTC", "ETH"]);
  assert(cells[1].textContent.endsWith("500.00"));
  assert(cells[3].textContent.endsWith("500.00"));
  const checkbox = planNodes.find((node) => node.tag === "input" && node.type === "checkbox");
  const button = planNodes.find((node) => node.tag === "button");
  const confirmLabel = planNodes.find((node) => node.tag === "label" && node.className === "coach-confirm-check");
  assert(confirmLabel.children.includes(checkbox));
  assert(confirmLabel.children.some((node) => node.textContent === "我已核對幣種與金額"));
  assert.strictEqual(button.textContent, "確認建立模擬單");
  const css = fs.readFileSync(path.join(__dirname, "..", "static", "css", "ai_coach.css"), "utf8");
  assert.match(css, /\.coach-confirm-check input\[type="checkbox"\]\s*\{[^}]*width:18px;[^}]*height:18px;/);
  assert(button.disabled);
  await button.listeners.click();
  assert.strictEqual(calls.length, 0, "no order before confirmation");
  checkbox.checked = true;
  checkbox.listeners.change();
  assert.strictEqual(button.disabled, false);
  await button.listeners.click();
  assert.strictEqual(calls.filter((call) => call.url === "/api/agent-auto-order").length, 1);
  assert.strictEqual(JSON.parse(calls[0].options.body).allocation.length, 2);
  assert(button.disabled, "successful order requires a new confirmation");

  await hooks.refreshPortfolio();
  const portfolioNodes = descendants(nodes.coachPortfolioContent);
  assert(portfolioNodes.some((node) => node.textContent === "<img onerror=alert(1)>"));
  assert(!portfolioNodes.some((node) => node.tag === "img"));
  assert(portfolioNodes.some((node) => node.textContent.includes("1,200")));
  console.log("ALL PASS: conversation migration, capped plan, confirmed order, portfolio rendering");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
