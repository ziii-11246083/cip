# TASK 04 — Citation UI 與使用者 Feedback

## 依賴

- Task 03 的 Codex review 必須為 `PASS`。

## 本次唯一目標

先在 AI Coach 畫面加入最小可用的來源顯示、低信心提示與 up/down feedback。不要全站重新設計。

## 開始前必讀

- AI Coach template、JS、CSS
- 已通過的 API response contract
- `rag_feedback` data contract/RLS
- `claude_tasks/reviews/TASK-03-ROUND-05.md`

## Codex 啟動澄清（2026-08-15，優先於容易歧義的舊描述）

- 本 Task 只做 AI Coach。不得把 Task 03 其他 endpoint 的結構化 citation UI 一併擴到全站。
- **不得更改已通過的 `/api/ai-chat` response contract**。目前 AI Coach 的 `citations` 是安全字串陣列；前端應將整個來源清單做成可展開區塊，逐筆以純文字顯示，不得用脆弱 regex 拆成不存在的欄位。
- 為向後相容，renderer 可防禦性接受 citation object；若是 object，只顯示實際存在的 `source/topic/section/chunk_id` 安全欄位；缺欄位就省略，不補假資料。字串與 object 都必須以 DOM `textContent` 或等價 escaping 輸出，不得把 server data 直接放進 `innerHTML`。
- conversation history 目前沒有 `trace_id/citations/confidence`。舊 assistant message 必須照常顯示，但不顯示來源、信心或 feedback 控制；不得改寫既有對話表／歷史 API 來追補假 metadata。
- feedback endpoint 接受公開 `trace_id`，在後端解析成內部 `rag_runs.id`；client 不得傳入或決定 `run_id/user_id`。
- 真實登入者的 feedback DB 操作必須使用該 request 的 Supabase access token（既有 `_authed_client/_authed_table` 模式），讓 RLS 驗證 run 所有權。**不得使用 service-role client 寫 feedback 後只相信前端 user_id**，因 service role 會 bypass RLS。
- demo token 沒有真實 Auth UID，且 demo trace 的 `user_id` 是 NULL：demo feedback 必須 fail closed（固定 403 code/message），不得寫匿名資料或偽造 UUID。
- 本 Task 的最小 UI 只有 up/down，不新增自由文字 comment 輸入。API 若防禦性接受 `comment`，必須驗證 string、trim 後最多 2000 字；不需要顯示 comment。

## 實作要求

- 對本次 API response 帶 metadata 的 AI 回答，在回答下方顯示可展開的「參考來源」清單。現行字串 citation 逐筆顯示安全字串；若未來收到結構化 citation，才顯示其中實際存在的 source/topic/section/chunk_id。不得為了滿足欄位名稱而改 Chat RAG/runtime contract。
- 無 citations 時不可顯示假來源；應顯示「本回答未取得可引用知識」或低信心提示。
- 新增有幫助／沒幫助按鈕；feedback 必須綁定 trace_id。
- 重複點擊需 idempotent 或採 upsert；不可產生大量重複紀錄。
- 只有該 run 的使用者可提交/更新 feedback；未登入行為需明確。
- 本階段不做 comment UI；所有 citation／錯誤訊息均需安全輸出，避免 XSS。
- feedback API 失敗不可讓回答消失，UI 要有清楚但不干擾的錯誤提示。

## Feedback API 最小契約

- 建議 route：`POST /api/rag-feedback`，必須套用 `@token_required`。
- request：`{"trace_id":"<8-128 chars>","vote":"up|down"}`；只接受 JSON object，拒絕未知 vote、空/非字串/過長 trace_id。
- server 只從驗證後的 request context 取得 UID/token；以使用者 JWT 查出「自己的」`rag_runs.trace_id`，查無資料一律回固定 `404`，不可透露該 trace 是否屬於別人。
- 以 `(run_id,user_id)` upsert `rag_feedback`；相同 vote 重送、改票都只保留一列。成功 response 只回必要的 `ok/vote/trace_id`，不得回 internal `run_id`、DB exception 或 token。
- 未登入 `401`；demo `403`；DB 不可用 `503`；validation `400`；非本人或不存在統一 `404`；其他 DB error 固定安全 `500`。失敗不得影響既有回答或 conversation history。

## 測試最低要求

- citations 有／無、high／low confidence。
- feedback success、unauthorized、wrong user、duplicate、network failure。
- XSS 內容不被 HTML 執行。
- 舊 conversation history 沒有 trace_id 時仍能正常顯示。
- API 測試需證明：client 無法指定 user_id/run_id、demo fail closed、wrong-user 與不存在均不洩漏、同一 run 重送/改票維持單列、provider/DB exception 不回傳原文。
- 前端測試至少抽出可測的純函式或使用既有可行方式，驗證字串/物件 citation 都以文字呈現、空 citation/low confidence 文案、無 trace history 不產生 feedback 按鈕、feedback network failure 不移除回答。

## 不可做

- 不改其他頁面 UI。
- 不做 dashboard。
- 不把 thumbs up 當成答案正確的 ground truth。
- 不修改 Task 01 migration/RLS、Task 02/03 trace/RAG runtime、AI 回答內容或 conversation schema。
- 不執行 migration、不連正式 DB、不 commit/push、不開始 Task 05。

## 原則上允許修改的檔案

- `static/js/ai_coach.js`
- `static/css/ai_coach.css`
- `app.py`：只新增 feedback route 與必要的小範圍接線
- `supabase_client.py`：只新增使用者 JWT 下的 run lookup／feedback upsert 方法
- Task 04 專用測試檔
- `claude_tasks/reports/TASK-04.md`
- `claude_tasks/STATUS.md` 的 Task 04 Implementation 欄位

若需修改 `templates/ai_coach.html`，只有在無法由現有 bubble 動態建立 UI 時才可做最小容器調整；若需修改其他檔案，先停止並說明理由，不得自行擴張。

## 驗收

AI Coach 可讓使用者看到來源並提供可追溯 feedback；完成後停止。
