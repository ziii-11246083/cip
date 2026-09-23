# TASK 04 — Codex 第二輪複審

審核結果：`PASS`

審核日期：2026-08-20

## 結論

第一輪四項 blocker 已全部以局部修正消除，沒有重寫 feedback API、RAG contract、conversation history 或其他頁面。Task 04 通過，下一階段只解鎖 TASK 05A；不得跳做 TASK 05B 或 TASK 06。

## 四項修正驗收

1. **feedback DB 錯誤 log**：auth apply、run lookup、feedback upsert 三條路徑均只記固定 allowlisted code，不帶 exception、`exc_info`、token、trace_id、run_id 或 user_id。Codex 以含合成 Bearer/API key 的 exception 複驗，secret 與 traceback 均未進 log。
2. **Node async runner**：23 個 `check()` 全部逐一 `await`；原始 runner 最後依序輸出 `SUMMARY 23/23 PASS`、`ALL PASS`。Codex 另以記憶體反例故意讓 rapid-click assertion 失敗，runner 正確回 non-zero，確認不再假綠。
3. **invalid-only citations**：`displayableCitationCount()` 同時驅動來源數量、details 與 no-source 判定；`[null, {}]` 等同無來源，不產生空 details 或假數量。
4. **trace 長度與 feedback 競態**：前端只在 8–128 字元 trace_id 顯示 feedback；`inFlight` 在第一個 await 前上鎖兩個按鈕，pending 期間忽略額外提交，成功／失敗後均解除。成功同步 active 與 `aria-pressed`，失敗可重試且回答保留。

## Codex 獨立驗證

| 驗證 | 結果 |
|---|---|
| 完整 pytest | `169 passed` |
| committed Node runner | `SUMMARY 23/23 PASS`、`ALL PASS` |
| 故意破壞 async assertion | runner 顯示 FAIL 並 exit non-zero |
| 合成 secret log capture | secret/traceback 不存在，只有固定 code |
| trace service unittest | `70 tests OK` |
| Python compile | 通過 |
| Task 01 migration validator | `70/70 PASS` |
| CRLF-aware `git diff --check` | 通過 |

## 非阻擋備註

- `claude_tasks/reports/TASK-04.md` 的主要修正摘要與驗證表已正確寫 169/169、23/23，但修改檔表、前端覆蓋標題、自我判定仍殘留 17 與 165/17 舊數字。這是報告內部的文件瑕疵，不影響已獨立重現的程式與測試結果，因此不要求第三輪修正；後續報告不得再保留互相矛盾的測試數。
- `.is-pending` 沒有額外視覺樣式，但原生 `disabled` 與 `aria-busy` 已提供不可操作／輔助技術狀態，不列 blocker。
- 尚未連真實 DB 或執行 migration。部署前仍需在隔離 Supabase 驗證真實 RLS、JWT 與 upsert；本次 fake client 測試不能取代部署驗證。
- feedback 是主觀訊號，不是答案正確性的 ground truth。RAG 準確性仍由 TASK 05A/05B 的固定資料集、離線指標與 regression gate 建立。

## 下一階段邊界

- 只允許開始 `TASK 05A — RAG 評測資料契約與離線 runner`。
- TASK 05A 只保存本地 timestamped artifacts；不得連 Supabase、不得寫 `rag_eval_runs/rag_evaluations`、不得修改 production endpoint、不得啟用 LLM judge。
- TASK 05B 必須等 TASK 05A Codex review 為 `PASS` 才能開始。
