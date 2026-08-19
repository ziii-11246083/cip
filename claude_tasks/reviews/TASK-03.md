# TASK 03 — Codex Review

審核結果：`CHANGES_REQUESTED`

審核日期：2026-08-14

> 第二輪複審：第一輪三類 blocker 的主路徑均已修正，但長 snapshot 會被直接切成無效 JSON；最新唯一修正清單見 `claude_tasks/reviews/TASK-03-ROUND-02.md`。Task 03 仍為 `CHANGES_REQUESTED`。

Claude Code 只能修正本文件列出的 Task 03 問題，不得開始 Task 04，不得修改 migration／資料契約、UI 或其他核心流程，不得連正式 DB、執行 migration、commit 或 push。

## 審核結論

Task 03 的整體接線方向正確：`start_run(endpoint, …)` 採 endpoint allowlist fail-closed、四條 route 沒有大量複製 trace 邏輯、既有 response 欄位保留、provider exception 不再直接外洩，而且 Agent 原有 f-string brace 問題是必要且局部的修復。

Codex 亦獨立重跑並確認：pytest `118/118`、service unittest `63/63`、Python compile、Task 01 validator `70/70` 與 CRLF-aware diff check 均通過。

但反例檢查仍確認 3 類 blocking issues：RAG 直接例外沒有固定 fallback code、四條 route 保存的 query／answer 並非實際決策輸入與使用者收到的完整結果、citation 只有 `source` 做路徑清理。這三點會讓後續準確率評測失真，或讓絕對路徑經 API 外洩，因此目前不能 PASS。

## 必須修正（阻擋 PASS）

### 1. `note_rag_error()` 必須留下固定安全代碼

目前 `note_rag_error()` 只把 `_rag_error` 設為 true。若 `augment_*()` 直接 raise，`finish()` 雖會得到 `status=degraded`、`fallback=true`，但 `fallback_reason` 是空字串。Codex 反例已在 route 層重現。

修正要求：

- 在 fallback allowlist 新增一個明確固定代碼，例如 `rag_error`；不要保存 exception text。
- `note_rag_error()` 必須在沒有更具體 metrics reason 時，讓最後紀錄得到 `fallback_reason="rag_error"`。
- 如果已存在更具體且安全的 reason，不可被較泛化的 `rag_error` 覆蓋。
- 四條 route 各加入直接 RAG exception 的回歸測試，至少斷言：HTTP／既有回答不變、`status=degraded`、`fallback=true`、`fallback_reason` 等於固定代碼，而且 exception 中的合成 secret 不出現在 payload、log 或 API response。

### 2. Trace 必須保存「實際影響回答的輸入」與「實際交付的業務回答」

目前 trace snapshot 遺漏大量會改變答案的欄位：

- Agent query 只有 `goal`，沒有 profile／budget；answer 只有 summary 或空字串，但 API 還有 steps／risks／next_action／allocation，錯誤時使用者也會收到 fallback plan。
- Podcast query 只有 market，沒有風險屬性、watchlist、事件及個人資產摘要；answer 在部分分支只有 title。
- Health query 只有 holdings，沒有已計算的風險指標，也沒有實際固定 retrieval query；answer 只有 narrative 或空字串，但 API 還有 risk_health／highlights。
- Scam answer 沒有完整保存 risk_level＋report；錯誤分支 trace answer 為空，但使用者實際收到固定 fallback report。

這會造成相同 goal、不同 profile／budget 得到相同 `query_hash`，也無法從 trace 重建「模型看到什麼、使用者收到什麼」，後續 RAG evaluation 因而不可信。

修正要求：

- 不改 DB schema；在 app 的 Task 03 trace 接線處建立小型、穩定、可預測的 JSON snapshot。
- 使用 deterministic JSON（固定 key、`sort_keys=True` 或等價作法），交由現有 sanitizer 做 PII／secret 遮罩並遵守現有長度上限；不得將 raw provider exception 放入 snapshot。
- query snapshot 至少涵蓋：
  - Agent：goal、實際使用的 profile、budget、實際 retrieval query。
  - Scam：待檢測 text、實際 retrieval query。
  - Podcast：market、實際使用的 risk level、watchlist、events、personal portfolio summary（有使用時）、實際 retrieval query。
  - Health：holdings、實際計算且提供給模型的 risk metrics、實際 retrieval query（目前為固定配置風險查詢字串）。
- answer snapshot 必須對應該分支真正回給使用者的業務欄位，不含 `trace_id`／`citations`／`confidence`：
  - Agent：summary、steps、risks、next_action、allocation。
  - Scam：risk_level、report。
  - Podcast：title、bullets、script、estimated_seconds、lines。
  - Health：risk_health、narrative、highlights。
- success、缺 API key、LLM exception／fallback 等所有會回 HTTP response 的分支，都應先形成實際 business response，再以同一份內容完成 trace；不得再用空 answer 代表使用者實際收到的 fallback。
- 只做局部 helper／接線修正，不重寫 route 或既有 response schema。
- 新增測試：
  - parse trace answer JSON，確認上述業務欄位與實際 API response 相符（排除 trace metadata）。
  - 相同 Agent goal、不同 profile 或 budget 時，query snapshot 與 HMAC query hash 必須不同。
  - Podcast／Health 的額外上下文及實際 retrieval query 確實出現在 sanitized snapshot。
  - 在 profile、事件、資產摘要或 fallback 資料放入合成 JWT／API key／路徑等反例，確認原文不進 store、log、API error。

### 3. Citation 的所有公開欄位都必須防禦性清理

目前 `safe_citations()` 只對 `source` 使用 basename；`chunk_id`、`section`、`topic` 原樣輸出。Codex 直接傳入 synthetic source metadata 後，API citation 仍會包含 `/srv/private/doc#1`、`/srv/private/section`、`/srv/private/topic`。這違反 Task 03「無絕對路徑」的 API 契約。

修正要求：

- 保留只回傳 `actually_injected=true` sources 的規則。
- `source`、`chunk_id`、`section`、`topic` 全部必須是有長度上限、無控制字元、無 secret 的安全公開字串。
- `chunk_id` 若為 `path/to/file#rank`，至少移除目錄、保留可辨識的 basename 與 `#rank`；POSIX 與 Windows path 都要處理。
- `section`／`topic` 不應把任意絕對路徑當公開文案；可取安全 basename 或拒絕／正規化 path-like value，但不可回傳 `/srv/...`、`C:\\...`。
- 不得因清理 citation 而改動 RAG 檢索、prompt 注入或 DB source rows。
- 新增 POSIX path、Windows path、CR/LF、JWT/API key 等反例，確認 citation JSON 不包含目錄、控制字元或 secret，且正常 citation 仍保持既有欄位與順序。

## 必須保留、不准順手改動

- 四個既有 endpoint、canonical／alias handler、Auth UID／匿名 user_id 規則。
- 既有 response 欄位、HTTP status 與 fallback 業務文案；只允許既有增量 trace metadata。
- `start_run()` endpoint allowlist、`start_chat_run()` 委派、trace store failure 不影響主流程。
- `actually_injected` citation 判定與 prompt builder 的注入數量語意。
- Agent f-string brace 局部修復及 provider exception 固定化處理。
- Task 01／02 已 PASS 的資料契約、migration、AI Chat trace 與安全保護。
- 留言、發文、任務、排程、儲值、金流、點數、會員權限等核心流程。

## 允許修改範圍

只能修改：

- `app.py` 內 Task 03 四條 route 的 trace snapshot／finish 局部接線與小型共用 helper
- `services/rag_trace_service.py` 的固定 fallback reason 與 public citation sanitizer
- `tests/test_rag_trace_endpoints.py`
- `tests/test_rag_trace_service.py`（只有共用 trace／citation 反例需要時）
- `claude_tasks/reports/TASK-03.md`
- `claude_tasks/STATUS.md` 的 Task 03 Implementation 欄位

不可修改 Codex review 欄位。若發現必須超出範圍，停止並說明，不得自行擴張。

## 重新送審驗收標準

- 上述 3 類缺口全部修正，並有修正前會失敗、修正後會通過的 regression tests。
- 原有 118 項 pytest 全數保留，新增後全數通過。
- `python3 -m unittest tests.test_rag_trace_service -v` 及 Task 03 endpoint test 通過。
- `python3 -m py_compile` 涵蓋所有本輪修改的 Python 檔。
- Task 01 validator 保持 `70/70`。
- `git -c core.whitespace=cr-at-eol diff --check` 通過；不得為此整檔改寫 `app.py` 行尾。
- 報告列出三類反例、各 route 的 query／answer snapshot 欄位矩陣、測試總數及未連 DB／未執行 migration／未 commit／未 push。
- Task 03 Implementation 更新回 `READY_FOR_CODEX_REVIEW` 後立即停止；不得開始 Task 04。
