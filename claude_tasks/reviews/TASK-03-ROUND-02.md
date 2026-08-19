# TASK 03 — Codex 第二輪複審

審核結果：`CHANGES_REQUESTED`

審核日期：2026-08-15

> 第三輪複審：直接截斷已排除，但 sanitizer 仍作用於 serialized JSON，普通 URL 會破壞 JSON 語法；最新唯一修正清單見 `claude_tasks/reviews/TASK-03-ROUND-03.md`。Task 03 仍為 `CHANGES_REQUESTED`。

## 結論

第一輪列出的三類 blocker 主路徑均已正確修復：

1. direct RAG exception 會得到固定 `rag_error`，且不覆蓋更具體的 reason。
2. 四條 route 的一般 query／answer snapshot 已包含指定輸入與實際 business response。
3. citation 四個公開欄位均已加入路徑、控制字元與 secret 清理。

Codex 獨立重跑也確認 pytest `137/137`、service unittest `70/70`、Python compile、Task 01 validator `70/70`、CRLF-aware diff check 全部通過。

但第二輪邊界反例確認尚有一個資料品質 blocker：snapshot 達長度上限時會被從 JSON 字串中間直接截斷，造成資料不再是合法 JSON。因此 Task 03 暫不 PASS，Task 04 繼續鎖定。

## 唯一必修 blocker：截斷後必須仍為合法、可評測的 JSON

目前 `app._trace_snapshot()` 的流程是：

1. `json.dumps(payload)`；
2. 對整段 JSON 字串呼叫 sanitizer；
3. 直接回傳 `text[:max_len]`。

當輸入或回答超過上限時，通常會切在 JSON string 中間。Codex 已獨立重現：

- 5000 字 Agent query 經 4000 上限後，長度為 4000，但 `json.loads()` 失敗：`Unterminated string`。
- 9000 字 answer 經 8000 上限後，長度為 8000，`json.loads()` 同樣失敗。
- 再走真實 `RAGTraceService.start_run()`／`finish()`，store 中的 `sanitized_query` 與 `answer` 仍然不可解析。

Agent goal、Scam text、Podcast events／portfolio_summary 目前都可能實際到達此邊界。這會讓 Task 05 的 evaluator 無法讀取 trace，與本 Task 建立 deterministic JSON snapshot 的目的衝突。

### 修正要求

- `_trace_snapshot()` 在任何輸入下都必須回傳合法 JSON，且總長度不得超過呼叫端指定的 `max_len`。
- 不得再對已序列化 JSON 使用單純的字串切片作為截斷策略。
- 採小型、deterministic、JSON-aware 的縮減方式：先安全化／縮短 leaf values，再重新 `json.dumps(sort_keys=True, separators=(",", ":"))`。
- 達上限時仍應盡量保留既有必要 top-level business keys；被縮短的字串或集合必須有固定、可辨識的截斷標記，不能讓 evaluator 誤以為內容完整。
- 序列化失敗時的 fallback 也必須是合法 JSON、固定安全代碼且符合上限，不得包含 exception text。
- 不得為此改變四條 API 的原始 business response、HTTP status、trace metadata 或 RAG 行為。
- 不得把輸入長度限制硬加到既有 API 來規避問題，除非原 schema 本來已有該限制。
- 不得修改 DB schema／migration、Task 01／02 行為、UI 或其他 route。

### 必加回歸測試

- 長 Agent goal、長 Scam text、Podcast 長 events／portfolio_summary：
  - API 行為不變；
  - stored `sanitized_query` 長度 `<=4000`；
  - `json.loads(sanitized_query)` 成功；
  - 必要 top-level keys 仍存在；
  - 相同輸入產生 deterministic snapshot／query hash；
  - 合成 JWT／API key／私鑰不出現在 snapshot、store、log 或 API error。
- 長 Agent 或 Podcast 模型輸出／fallback business response：
  - API 回傳內容不因 trace 截斷而改變；
  - stored answer 不超過既定上限且 `json.loads(answer)` 成功；
  - 必要 top-level business keys仍存在；
  - 被縮短內容帶固定截斷標記。
- 小於上限的既有 snapshot 必須 byte-for-byte 維持目前 deterministic JSON 結果，避免不必要地改變既有 query hash。
- 先證明新測試在目前實作會因 JSON parse 失敗，再修正並全數通過。

## 已接受、不可重做的部分

- `rag_error` allowlist、specific reason precedence 與四 route exception 測試。
- 四 route 現有 query／answer 欄位矩陣及「business dict 與 response 同源」做法。
- citation 的 `clean_public_field`／`clean_chunk_id`／`clean_public_label` 與 actually_injected-only。
- endpoint／Auth UID／匿名 user_id、canonical／alias、response 欄位及 fallback 文案。
- Agent brace 修復、provider exception 固定化、Task 01／02 已過審內容。

## 允許修改範圍

只能修改：

- `app.py` 的 `_trace_snapshot()` 及為合法 bounded JSON 必要的一個小型 helper
- `tests/test_rag_endpoints_trace.py` 的長度邊界回歸測試
- `tests/test_rag_trace_service.py`（只有 service store 後 parse 驗證確有需要時）
- `claude_tasks/reports/TASK-03.md`
- `claude_tasks/STATUS.md` 的 Task 03 Implementation 欄位

不得修改 Codex review 欄位。若無法在此範圍完成，立即停止並說明，不得自行擴張。

## 重新送審驗收

- 唯一 blocker 及上述長度反例全部通過。
- 原 137 項 pytest 全數保留，新增後全數通過。
- service unittest、Python compile、Task 01 validator、CRLF-aware diff check 全部通過。
- 報告列出修正前的 `JSONDecodeError` 反例、縮減規則、截斷標記、測試總數及未連 DB／未執行 migration／未 commit／未 push。
- Task 03 Implementation 更新回 `READY_FOR_CODEX_REVIEW` 後立即停止；不得開始 Task 04。
