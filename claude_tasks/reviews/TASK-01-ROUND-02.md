# TASK 01 — Codex 第二輪複審

審核結果：`PASS`

審核日期：2026-08-14

## 結論

第一輪提出的六項必要修正均已落實於 migration、資料契約、validator 與實作報告，Task 01 可關閉，Task 02 閘門解鎖。

本次 PASS 只代表 Task 01 的「資料契約與靜態 migration」符合範圍內驗收；不代表 migration 已在真實 PostgreSQL / Supabase 執行，也不代表 runtime trace 已接線。

## 六項修正複核

1. `rag_runs`、`rag_run_sources` 對 authenticated 只保留 SELECT；沒有 INSERT/UPDATE/DELETE policy。
2. `rag_feedback_update_own` 的 USING 與 WITH CHECK 都驗證 `user_id` 與 parent run ownership。
3. `rag_evaluations` 已有 nullable `eval_run_id` FK、CASCADE、index，以及 `case_id` 存在時必須有 `eval_run_id` 的 constraint。
4. validator 已改為負向檢查不安全 write policies，並補齊 feedback ownership 與 eval batch 關聯檢查。
5. `query_hash` 契約已改為 server-side keyed HMAC-SHA-256，記錄 secret 邊界與 rotation 影響，未宣稱等同匿名化。
6. `rag_runs.user_id` 已改 `ON DELETE CASCADE`，契約同步說明高敏感 trace 的刪除語意。

## Codex 獨立驗證

- `python3 scripts/validate_rag_trace_migration.py`：PASS（70/70）。
- `python3 -m py_compile scripts/validate_rag_trace_migration.py`：PASS。
- validator 反例檢查：額外加入 authenticated INSERT policy 可被偵測；弱化 feedback UPDATE 任一側 parent ownership 會被拒絕。
- `git diff --check`：PASS。
- Task 01 相關檔案 trailing whitespace：0。
- 範圍檢查：未見 runtime 程式變動，未開始 Task 02，未執行 migration，未連 DB。

## 已知但不阻擋 Task 01 的部署前條件

- 尚未以真實 PostgreSQL parser 或 DB 執行 migration；部署前必須比對 `user_profiles.user_id`、`ai_conversations.id`、`ai_messages.id` 的實際型別與 constraint。
- RLS 實際行為仍需在隔離測試 DB 以 authenticated JWT / service role 做整合測試。
- 現有 `SupabaseDB.key` 可能 fallback 到 `SUPABASE_KEY` 或 anon key，不能被當成「一定是 service role」；此風險已加入 Task 02 強制驗收，trace writer 必須明確驗證 service-role credential，缺少時 fail closed 並讓 Chat 正常降級。
