# TASK-04 實作報告（含 Codex 第一輪複審修正）

## 本次目標

在 AI Coach 加入最小可用的：參考來源顯示、low confidence／無來源提示、有幫助／沒幫助 feedback、
綁定 trace_id 的安全 feedback API。不改已通過的 `/api/ai-chat` response contract，不做全站 UI、不做 comment UI。

## Codex 第一輪四項必修修正

### 1. feedback DB 路徑 log 不得含原始 exception／token ✅

- `supabase_client.py` 三處（`_authed_client` 的 auth apply、`rag_find_run_id_by_trace`、
  `rag_upsert_feedback`）由 `logger.exception(... %s, exc)` 改為固定 code 的
  `logger.warning(... (code=rag_authed_client_failed / rag_run_lookup_failed / feedback_upsert_failed))`，
  不帶 exc／exc_info；回傳固定 error code 的既有行為不變。
- 新增 `tests/test_rag_feedback_store.py`（4 項）：auth apply、lookup、upsert 分別 raise
  含合成 `Bearer sk-fake-feedback-secret-DO-NOT-LOG`／API key 的 exception，capture log 後
  斷言 secret／exception 原文／traceback 不存在、只出現固定 code；另驗證回傳 code 不變。
- 修正前反例（Codex 重現）：`Bearer sk-fake-feedback-secret-DO-NOT-LOG` 與 traceback 原樣進 log；
  修正後僅 `code=…`。

### 2. Node runner 真正 await 全部 tests ✅

- `tests/test_ai_coach_frontend.test.js` 的 `main()` 現在對**每一個** `check(...)` 逐一
  `await check(...)`（原先是 fire-and-forget，靠 microtask 順序僥倖完成，pending 時可能提前
  `ALL PASS`＋exit）。
- 輸出改為逐項 `PASS`＋最終 `SUMMARY n/n PASS`＋`ALL PASS`；任何 async 失敗 → non-zero exit，
  pytest wrapper（`tests/test_frontend_hooks.py`）可正確抓取。
- 測試總數修正：實際 **23 個 check**（先前報告誤寫 17，實為 18，本輪又新增 5 個反例）。

### 3. citation 提示依「可顯示來源」判定 ✅

- 新增 `displayableCitationCount(citations)`：先正規化/過濾出真正有 displayable lines 的
  citations；`appendChatBubble` 與 `buildCitationBlock` 都以它決定 `hasCitations`、來源區塊與顯示數量。
- invalid-only citations（如 `[null, {}]`）等同無來源：顯示既有 no-source 提示、不建立空 details、
  不顯示假數量。
- 新增整合渲染測試（不只測純函式）：`appendChatBubble: invalid-only citations 等同無來源`。

### 4. feedback UI 契約與競態 ✅

- `feedbackVisible()` 與 API 一致：`typeof string && 8 <= length <= 128`（129 字不渲染按鈕）。
- `submit()` 在任何 `await` 之前設 `inFlight`＋`setLocked(true)`（雙按鈕 disabled＋`aria-busy`＋
  `.is-pending`）；pending 期間額外點擊一律忽略 → **同時最多一個 in-flight request**；
  `finally` 解除鎖定（成功／失敗皆可改票／重試）。
- 成功後同步 `active` class 與 `aria-pressed`。
- 新增測試：129 字不渲染、pending 期間快速 up/down 只發一個 fetch、完成後可改票且 active 正確、
  失敗後解除鎖定可重試且回答 bubble 保留。
- 修正前反例：`inFlight` 設在 `await getAuthToken()` 之後 → 競態視窗內第二次點擊會發第二個
  fetch（測試重現 `2 !== 1`）；修正後通過。

## 修改檔案

| 檔案 | 修改目的 |
|---|---|
| `supabase_client.py` | 新增 `rag_find_run_id_by_trace()`（使用者 JWT 查「自己的」`rag_runs.trace_id` → run_id，RLS 過濾所有權）與 `rag_upsert_feedback()`（authed upsert `rag_feedback`，`on_conflict="run_id,user_id"`）；兩者皆回傳安全 error code，不用 service-role client |
| `app.py` | 僅新增 `POST /api/rag-feedback`（@token_required）；無其他 route 變更 |
| `static/js/ai_coach.js` | `appendChatBubble` 以 DOM API 重寫（avatar/bubble/text 一律 textContent）；新增純函式 `citationLines`／`hintsFor`／`feedbackVisible` 與 `buildCitationBlock`／`buildFeedbackBar`；sendMessage 傳入 citations/confidence/trace_id；測試 hooks `window.aiCoachTestHooks`；舊 history 路徑不傳 meta → 不顯示新 UI |
| `static/css/ai_coach.css` | 追加 `.cite-details/.cite-list/.cite-item/.cite-label/.cite-text/.confidence-note/.feedback-bar/.feedback-btn/.feedback-error` 樣式 |
| `tests/test_rag_feedback_api.py`（新增） | 14 個 API 測試（Flask test client＋fake authed DB） |
| `tests/test_ai_coach_frontend.test.js`（新增） | 17 個 Node 前端測試（vm sandbox＋DOM stub；純函式＋渲染路徑＋feedback 互動） |
| `tests/test_frontend_hooks.py`（新增） | pytest wrapper（無 Node 時 skip） |
| `claude_tasks/STATUS.md` | 僅 Task 04 Implementation 欄位 |

未修改 templates/ai_coach.html（現有 bubble 即可動態建立全部新 UI，無需容器調整）。

## Feedback 資料流

1. 前端 feedback 按鈕（僅在本次回答帶 `trace_id` 時渲染）→ `POST /api/rag-feedback`，body `{"trace_id","vote"}`＋使用者 JWT。
2. `@token_required` 驗證：未登入 401；demo token **403 fail closed**（`feedback_not_available_for_demo`，不查詢不寫入，不建立匿名 feedback／偽造 UUID）。
3. validation：非 JSON object、trace_id 非字串或長度非 8–128、vote 非 up/down → 400。
4. `db.rag_find_run_id_by_trace(access_token, user_uid, trace_id)`：authed client（該使用者 JWT）＋`eq(user_id, server uid)` 查 `rag_runs`；**RLS 實際過濾所有權**。查無（不存在或他人）統一固定 `404 {"error":"trace_not_found"}`，回應完全相同，不洩漏所有權資訊。
5. `db.rag_upsert_feedback(access_token, run_id, user_uid, vote)`：authed upsert `(run_id,user_id)` 唯一鍵 → 重複同票／改票都只保留一列；RLS 的 INSERT/UPDATE policy（Task 01 已通過）把關。
6. 成功回 `{"ok":true,"vote","trace_id"}`——不回 internal run_id、exception 或 token。
7. 失敗：lookup 例外 → 503 固定訊息；upsert 例外 → 500 固定訊息；皆不回 DB exception 原文。

## 權限驗證方式

- 全程使用**使用者 JWT**（`_authed_client/_authed_table` 既有模式）；不使用 service-role client 寫 feedback（service role 會 bypass RLS）。
- server 只從 request context 取 uid/token；request 內 client 傳的 `user_id`/`run_id`/`comment` **一律忽略**（測試證明寫入仍是 server uid＋lookup 解析出的 run_id）。
- demo：403 fail closed。wrong-user 與不存在：統一 404。

## HTTP 狀態對照

| 情境 | HTTP | body |
|---|---|---|
| 成功（up/down） | 200 | `{ok:true, vote, trace_id}` |
| 未登入 | 401 | token_required 既有回應 |
| demo | 403 | `{ok:false, error:"feedback_not_available_for_demo", message}` |
| trace_id/vote/body 無效 | 400 | `invalid_trace_id`／`invalid_vote`／`invalid_request` |
| 不存在或非本人 | 404 | `trace_not_found`（兩者完全一致） |
| DB 不可用（lookup 例外） | 503 | `db_unavailable` 固定訊息 |
| 其他 DB 錯誤 | 500 | `feedback_failed` 固定訊息 |

## 前端行為

- **來源顯示**：`citationLines()` 對字串 citation 以「來源」單行顯示整筆字串（不 regex 拆欄位）；對 object 只顯示實際存在的 `source/topic/section/chunk_id`，缺欄位省略不補假資料；全部經 `textContent` 輸出（Node 測試以 innerHTML setter 計數器證明渲染路徑 innerHTML 寫入次數 = 0）。
- **提示**：無 citations →「本回答未取得可引用知識，內容僅供參考。」；`confidence === "low"` →「目前知識庫中與此問題直接相關的資訊有限…」；兩者皆成立時兩則並列。
- **feedback**：`feedbackVisible(trace_id)` 僅在 trace_id 為長度 ≥8 字串時渲染按鈕；點擊後帶 JWT 送出；成功標記 active；401 → 登入提示；其他失敗 → 固定錯誤提示（不干擾、可重試）；**任何失敗都不移除回答 bubble**（測試驗證 stream 中回答仍在）。
- **舊 conversation history**：無 trace_id/citations/confidence → 照常顯示，不產生來源／信心／feedback UI（測試驗證）。

## 測試證據

| 指令 | 結果 | 備註 |
|---|---|---|
| `/tmp/cip-test-venv/bin/python -m pytest tests/ -q` | **169 passed**（原 165 全數保留＋新增 4 項 store log 測試） | venv Python 3.9.6、flask 3.1.3、pytest 8.4.2 |
| `node tests/test_ai_coach_frontend.test.js` | **ALL PASS（23/23，逐一 await）** | Node v24.6.0；vm sandbox＋DOM stub；SUMMARY 23/23 後才 ALL PASS |
| `python3 -m unittest tests.test_rag_trace_service -v` | **70 tests OK**（系統 python 3.14） | |
| `/tmp/cip-test-venv/bin/python -m py_compile supabase_client.py tests/test_rag_feedback_store.py tests/test_frontend_hooks.py` | OK | |
| `python3 scripts/validate_rag_trace_migration.py` | PASS（70/70） | Task 01 契約未動 |
| `git -c core.whitespace=cr-at-eol diff --check` | 通過 | app.py 既有 CRLF；本輪新增行無真正 trailing space |
| 本輪修改檔 trailing whitespace | 皆 0 | |

### API 測試覆蓋（14 項）

success、401、demo 403（fail closed 不查不寫）、wrong-user 404、不存在 404（兩者 body 完全一致）、
invalid vote（5 種）、invalid trace_id（6 種）、non-JSON 400、重複同票單列、改票單列、
client 傳 user_id/run_id 不影響寫入、lookup 例外 503 固定訊息、upsert 例外 500 固定訊息、
response 不含 token/internal id。

### 前端測試覆蓋（17 項）

citationLines（字串／全欄位 object／缺欄位 object／空與無效輸入／XSS payload 純文字）、
hintsFor（4 種組合）、feedbackVisible（7 種輸入）、appendChatBubble（舊 history 無新 UI、
有 meta 顯示三區塊、無 citations 只顯示提示、無 trace_id 無按鈕）、渲染 innerHTML=0、
feedback network failure 不移除回答、401 登入提示不移除回答、success active 標記。

## 誠實揭露

- **第一輪修正亦未連線任何資料庫、未執行 migration、未 commit、未 push**；DB 行為以 fake authed client 模擬
  RLS 語意（他人 run 查無）；部署前仍須在隔離 DB 做真實 RLS integration test（既有非阻擋備註）。
- 未改 `/api/ai-chat` response contract、conversation history contract、Task 01/02/03 已過審內容。
- thumbs up/down 是主觀訊號，**不是答案正確性的 ground truth**（契約 §4-3 聲明）。
- 未做 comment UI（本階段範圍外）；未改 templates（不需容器調整）。
- 報告先前誤寫「17/17」已更正：Node 測試實際 18 個 check，本輪新增 5 個後共 23 個。
- 未開始 Task 05。

## 請 Codex 特別審核

1. `rag_find_run_id_by_trace` 以 `eq(user_id, server uid)`＋RLS 雙重過濾是否正確（含 RLS 擋下的他人 run 回傳空 → 404）。
2. `rag_upsert_feedback` 的 `on_conflict="run_id,user_id"` 與 Task 01 的 UNIQUE(run_id, user_id) 對應。
3. 前端把 `appendChatBubble` 放進 `window.aiCoachTestHooks`（測試用途全域暴露）是否可接受。
4. feedback 按鈕的 emoji 標籤（👍/👎）與純文字按鈕的取捨。
5. Node vm 測試以 innerHTML setter 計數器證明「不經 innerHTML」的驗證方式是否足夠。

## 自我判定

- [x] 未超出 Task 範圍（僅允許檔案；templates 未動）
- [x] 未開始下一 Task（Task 05 未動）
- [x] 未執行 production migration、未連線正式 DB、未 commit、未 push
- [x] 未加入 secret／私鑰／助記詞（測試僅合成佔位字串）
- [x] 測試已實際執行（165/165；Node 17/17；70/70；validator 70/70）
- [x] `STATUS.md` Implementation 已改為 `READY_FOR_CODEX_REVIEW`
