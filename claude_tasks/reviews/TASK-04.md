# TASK 04 — Codex 第一輪審核

審核結果：`CHANGES_REQUESTED`

審核日期：2026-08-19

## 結論

主要架構可接受：feedback route 使用 server-side UID/token，透過 authed Supabase client 查 own run 並 upsert；demo fail closed、wrong-user/不存在統一 404、request user_id/run_id 被忽略；AI Coach 亦未改 `/api/ai-chat` contract，主要 citation/answer 渲染使用 DOM `textContent`。

但目前有一個可重現的敏感資料 log 漏洞，以及三個會讓測試或 UI 狀態失真的小型 blocker。Task 04 暫不 PASS，Task 05 繼續鎖定。只需局部修正，不得重寫 feedback API、RAG 或其他頁面。

## 已接受、不需重做

- `POST /api/rag-feedback` 的 validation、401、demo 403、404 ownership concealment、固定 503/500 response。
- server 只使用 request context 的 UID/token；client 傳入 user_id/run_id/comment 不影響查詢或寫入。
- `rag_runs` lookup filters 與 `rag_feedback` upsert payload/on_conflict；Codex 直接 fake query-builder 已驗證。
- 字串/object citation 使用 `textContent`，舊 history 無 metadata 時不顯示新 UI。
- Task04 API tests 14/14、完整 pytest 165/165、service unittest 70/70、compile、validator 70/70、diff check 均通過；惟 pytest 中的 Node wrapper 受 blocker 2 影響，不能視為 async 前端測試已完成。

## 必修 1：新 feedback DB 路徑不得把原始 exception／token 寫入 log

`supabase_client.py` 的 `_authed_client()`、`rag_find_run_id_by_trace()`、`rag_upsert_feedback()` 使用 `logger.exception(... %s, exc)`。Codex 令 `_authed_table` raise：

`Bearer sk-fake-feedback-secret-DO-NOT-LOG`

結果該字串與 traceback 原樣進入 server log。API response 固定化不能抵消 log 外洩。

修正要求：

- feedback 會經過的上述三處錯誤 log 只能輸出固定 allowlisted code，不得插入 `exc`、token、query、run_id、trace_id、user_id 或 traceback。
- 建議使用不帶 `exc_info` 的 warning/error，例如 `code=rag_feedback_lookup_failed`；保留回傳固定 error code 的既有行為。
- 新增 store 級測試：讓 auth apply、lookup、upsert 分別 raise 含 synthetic Bearer/API key 的 exception，capture log 後斷言 secret/exception 原文/traceback 不存在，只出現固定 code。
- 不要求順手改寫整份 `supabase_client.py` 的所有舊 logger；只修本 Task feedback 路徑會觸發者。

## 必修 2：Node runner 必須真的 await 全部 18 個 tests

`tests/test_ai_coach_frontend.test.js` 實際有 18 個 `check()`，不是報告中的 17。`check` 是 async，但 `main()` 沒有 `await check(...)`；原指令只輸出前 15 個 PASS 就 `ALL PASS` 並 `process.exit`，最後三個 network/401/success tests 未完成。

修正要求：

- 所有 18 個 checks 必須逐一 await，或收集 promises 後等待全部完成；不得在 pending test 存在時 exit。
- Node 原始指令須清楚輸出 18 個 PASS 後才輸出 `ALL PASS`。
- pytest wrapper 必須在 async test 真正失敗時得到 non-zero exit。
- 報告測試數量改為真實 18，不得再寫 17。

## 必修 3：citation 提示要依「可顯示來源」而非 raw array length

目前 `citations=[null, {}]` 時：沒有 citation block，但 `citations.length > 0` 又阻止「未取得可引用知識」提示，使用者兩邊都看不到。

修正要求：

- 先正規化/過濾出真正有 displayable lines 的 citations，再用該結果同時決定來源區塊、顯示數量與 `hasCitations`。
- invalid-only citations 必須等同無來源，顯示既有 no-source 提示，不建立空 details，不顯示假數量。
- 加入整合渲染測試，不只測 `citationLines()` 純函式。

## 必修 4：feedback UI 契約與競態

兩個反例：

- 129 字 trace_id 仍顯示按鈕，但 API 契約只接受 8–128，該按鈕必定送出 400。
- 快速點 up 再點 down，若 down response 先回、up response 後回，最後 active 會回到 up；目前沒有 submitting guard。

修正要求：

- `feedbackVisible()` 必須與 API 一致：trim/格式不擴張，至少嚴格限制 `8 <= length <= 128`。
- 同一 feedback bar 在 request pending 時要鎖定兩個按鈕並忽略額外提交；完成後解除，讓使用者可再改票。不得同時存在兩個 in-flight feedback requests。
- 成功後同步 active/`aria-pressed`；pending 狀態應有 disabled 或等價可感知狀態。
- 新增測試：129 字不渲染；pending 期間快速 up/down 只發一個 fetch；完成後可改票且 active 正確；失敗後解除鎖定並可重試，回答 bubble 始終保留。

## 允許修改範圍

- `supabase_client.py`：只限上述 feedback/authed log 固定化。
- `static/js/ai_coach.js`：只限 citation normalization、trace 上限、feedback pending/active 狀態。
- `tests/test_ai_coach_frontend.test.js`
- `tests/test_frontend_hooks.py`（只有 runner 驗證需要時）
- Task 04 專用 Python store/API tests；建議新增 store 級測試或在現有 Task04 測試中局部補齊。
- `claude_tasks/reports/TASK-04.md`
- `claude_tasks/STATUS.md` 的 Task 04 Implementation 欄位。

不得修改 `app.py` feedback route 語意、migration/RLS、Task 01–03、其他頁面、conversation/RAG contract；不得開始 Task 05、連正式 DB、執行 migration、commit 或 push。

## 重新送審驗收

- 合成 secret 的 auth/lookup/upsert exception 不進 log，只有固定 code。
- Node 原始指令完成並列出 18/18，pytest wrapper 可抓 async failure。
- invalid-only citations 顯示 no-source；129 字 trace 不顯示 feedback。
- rapid-click 同時最多一個 request，完成後仍可改票，network failure 可重試且回答保留。
- 原 165 pytest、14 API、70 service tests、compile、validator 70/70、diff check 全數保留通過；新增測試後總數如實更新。
- 報告誠實修正原「17/17」錯誤並記錄修正前反例。
