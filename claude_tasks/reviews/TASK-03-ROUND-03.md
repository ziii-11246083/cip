# TASK 03 — Codex 第三輪複審

審核結果：`CHANGES_REQUESTED`

審核日期：2026-08-15

> 第四輪複審：leaf-first sanitize 與巨大 nested dict 已通過，但 `#N` final key 可與原始 key 碰撞並覆蓋 value；最新唯一修正清單見 `claude_tasks/reviews/TASK-03-ROUND-04.md`。Task 03 仍為 `CHANGES_REQUESTED`。

## 結論

第二輪指出的「serialized JSON 直接截斷」已修正：長 leaf／list 會以固定標記縮減，Claude 新增的 8 個長度測試均通過，小型正常 snapshot 也保持 byte stability。

Codex 獨立重跑確認 pytest `145/145`、service unittest `70/70`、Python compile、Task 01 validator `70/70` 與 CRLF-aware diff check 全部通過。

但「任何輸入都產生合法 JSON」仍未成立。現在的 `_serialize()` 仍先 `json.dumps()`，再對整段 JSON 語法執行 regex sanitizer；URL pattern 會吞掉 closing quote／comma／brace。Codex 已在真實 Agent route 重現 stored query 無法解析。因此 Task 03 暫不 PASS，Task 04 繼續鎖定。

## 唯一必修 blocker：sanitizer 必須作用於 JSON value，不可作用於 serialized JSON 語法

### 已重現證據

使用合成、非真實網址：

```text
goal = "請分析 https://example.invalid/path?x=1"
```

結果：

- POST `/api/agent-plan` 回 HTTP 200，原主流程不受影響。
- store 中 `sanitized_query` 長度只有 69，並未碰到 4000 上限。
- `json.loads(sanitized_query)` 仍失敗：`Unterminated string`。
- 實際內容結尾類似：`"retrieval_query":"請分析 <URL>`，缺少 closing quote／brace。

根因位於 `app._trace_snapshot()` 內 `_serialize()`：

1. 先 `json.dumps(obj)`；
2. 再 `_trace_sanitize(text)`。

既有 URL regex 適合處理單一文字 value，不能安全地作用於包含 JSON 語法的整段字串。

### 修正要求

- 在遞迴 helper 中先對每個 string value 呼叫既有 `_trace_sanitize()`，再做 leaf/list/dict 縮減，最後才 `json.dumps()`。
- `_trace_sanitize()` 不得再對完成的 serialized JSON 字串執行。
- 必須處理巢狀 list／dict 中的 string values；nested dict 的不可信 string key 也不得洩漏 secret。若清理 key 可能碰撞，採 deterministic、collision-safe 的固定替代方式，不能覆蓋另一筆資料。
- 保持 `sort_keys=True`、固定 separators、固定截斷標記與長度上限。
- 一般、未含敏感內容且未超長的既有 snapshot 必須 byte-for-byte 不變；含 URL／PII 的 snapshot 可以因修正而變為合法 JSON，但同一輸入仍須 deterministic。
- 不得改動 `services/rag_trace_service.py` 的全域 regex，只需修正 app snapshot 的使用順序；不得影響 Task 01／02 的其他呼叫者。

### 過大 nested dict 必須保留必要外層欄位

Codex 另以合法的 3000-entry `portfolio_summary` 重現目前終極 fallback：snapshot 只剩 `error`／`marker`，`market`、`risk_level`、`retrieval_query` 等必要 top-level keys 全部消失。

修正要求：

- `_trace_shrink()` 必須能 deterministic 地限制 nested dict entry count／過長 key，或將過大的 nested value 替換成固定 truncated object／marker。
- 最外層既有必要 business keys必須保留；不可因單一 `portfolio_summary` 太大而把整筆 query snapshot 換成只有 error 的 envelope。
- 終極 fallback 可保留作不可序列化型別的安全保護，但對正常 JSON request payload 的長 string/list/dict 不應走到全域 envelope。

## 必加回歸測試

- Agent goal 含合成 `https://example.invalid/path?x=1`：
  - HTTP／business response 不變；
  - stored query 可 `json.loads()`；
  - URL 原文不在 snapshot，value 為安全 placeholder；
  - goal／profile／budget／retrieval_query keys仍存在。
- Scam text、Podcast events／portfolio_summary 至少各加入一個 URL 或會被 sanitizer 命中的 PII pattern，確認巢狀 value 清理後仍是合法 JSON。
- URL／PII 放在 nested dict key 時不得洩漏，且清理後不能因 key collision 靜默覆蓋資料。
- 3000-entry nested dict：結果 `<=4000`、可 parse、有截斷標記，並保留 market／risk_level／watchlist／events／portfolio_summary／retrieval_query 外層 keys。
- 原 8 個長度邊界測試與 small byte-stability test 全部保留。
- 修正前先讓新增 URL route test 重現 `JSONDecodeError`，修正後通過。

## 已接受、不可重做

- `rag_error`、specific reason precedence、四 route query／answer 欄位矩陣。
- citation sanitizer 與 actually_injected-only。
- 現有 leaf/list budgets、`…[truncated]` 標記與 API response 不受 trace 截斷影響的做法。
- endpoint/Auth/alias/response/fallback、Agent brace 修復及 provider exception 固定化。
- Task 01／02 已 PASS 的內容。

## 允許修改範圍

只能修改：

- `app.py` 的 `_trace_shrink()`／`_trace_snapshot()`
- `tests/test_rag_endpoints_trace.py` 的上述 regression tests
- `claude_tasks/reports/TASK-03.md`
- `claude_tasks/STATUS.md` 的 Task 03 Implementation 欄位

不得修改 Codex review 欄位、service sanitizer、route business logic、DB、migration、UI 或其他功能。若無法在此範圍完成，停止並說明。

## 重新送審驗收

- URL route 反例與 nested dict 外層 key 保留反例通過。
- 原 145 項 pytest 全數保留，新增後全部通過。
- service unittest、Python compile、Task 01 validator、CRLF-aware diff check 全部通過。
- 報告列出修正前 URL `JSONDecodeError`、leaf-first sanitize 流程、nested dict 縮減規則、測試總數及未連 DB／未 migration／未 commit／未 push。
- Task 03 Implementation 設回 `READY_FOR_CODEX_REVIEW` 後立即停止；不得開始 Task 04。
