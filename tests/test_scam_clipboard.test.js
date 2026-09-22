// Run with: node --test tests/test_scam_clipboard.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../static/js/scam_detect.js"), "utf8");

async function clickCopy(clipboard, report = "  測試報告  ") {
  const alerts = [];
  let click;
  const elements = {
    btnCopyReport: { addEventListener: (event, handler) => { click = handler; } },
    reportContent: { textContent: report },
  };
  const context = vm.createContext({
    navigator: { clipboard },
    alert: message => alerts.push(message),
    document: {
      getElementById: id => elements[id] || null,
      addEventListener: () => {},
    },
  });
  vm.runInContext(source, context);
  context.initReportButtons();
  click();
  await new Promise(resolve => setImmediate(resolve));
  return alerts;
}

test("missing or incomplete clipboard API explains manual copying", async () => {
  for (const clipboard of [undefined, {}]) {
    assert.deepEqual(await clickCopy(clipboard), [
      "此瀏覽器目前無法使用剪貼簿，請選取報告內容後手動複製。",
    ]);
  }
});

test("empty report does not attempt copying", async () => {
  let copied = false;
  const alerts = await clickCopy({ writeText: async () => { copied = true; } }, "  ");
  assert.equal(copied, false);
  assert.deepEqual(alerts, ["目前沒有可複製的報告內容。"]);
});

test("successful copy uses trimmed report text", async () => {
  let copied;
  const alerts = await clickCopy({ writeText: async text => { copied = text; } });
  assert.equal(copied, "測試報告");
  assert.deepEqual(alerts, ["分析報告已複製。"]);
});

test("clipboard permission rejection reports failure", async () => {
  const alerts = await clickCopy({ writeText: async () => { throw new Error("Denied"); } });
  assert.deepEqual(alerts, ["複製失敗，請稍後再試。"]);
});
