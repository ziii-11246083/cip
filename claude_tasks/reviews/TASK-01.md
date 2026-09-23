# TASK 01 — Codex Review

第一輪審核結果：`CHANGES_REQUESTED`（六項已修正）

最新結果：第二輪已 `PASS`，證據見 `claude_tasks/reviews/TASK-01-ROUND-02.md`。本文件保留作為第一輪問題與修正依據。

本文件是 Task 01 的必要修正清單。Claude Code 只能修正 Task 01，不得開始 Task 02，也不得接 runtime、修改 UI、執行 migration、連線正式 DB、commit 或 push。

## 審核結論

目前新增檔案與 Task 01 的範圍控制良好，靜態檢查也可重複執行；但資料授權、評測批次關聯與敏感資料策略仍有缺口，會直接削弱「RAG 可追溯、可驗證」的可信度，因此尚未通過。

## 必須修正（阻擋 PASS）

### 1. 禁止一般登入使用者偽造 RAG run 與 source

目前 migration 對 `authenticated` 建立了 `rag_runs` 與 `rag_run_sources` 的 INSERT policy，與契約「runs/sources 只能由 service role 寫入」互相矛盾。登入使用者可自行寫入看似正式的稽核紀錄與來源，污染後續準確率、feedback 與評測資料。

修正要求：

- `authenticated` 對 `rag_runs`：只能 SELECT 自己的資料，不得 INSERT/UPDATE/DELETE。
- `authenticated` 對 `rag_run_sources`：只能透過 parent run SELECT 自己的來源，不得 INSERT/UPDATE/DELETE。
- backend service role 不需要另建 RLS policy；Supabase service role 依既有設計 bypass RLS。
- 同步修正資料契約的 RLS 矩陣與文字，所有段落必須一致。

### 2. 修正 feedback UPDATE 的跨使用者 run 關聯漏洞

目前 `rag_feedback_update_own` 的 `WITH CHECK` 只確認 `feedback.user_id = auth.uid()`，沒有確認更新後的 `run_id` 仍屬於本人。知道其他 run UUID 的使用者可能把自己的 feedback 改掛到別人的 run。

修正要求：

- UPDATE 的 `WITH CHECK` 必須同時驗證 `user_id = auth.uid()`，且新 `run_id` 對應的 `rag_runs.user_id = auth.uid()`。
- 建議 `USING` 也驗證目前 parent run 的所有權，使讀寫條件一致。
- 保留 INSERT 對 parent run 所有權的驗證。

### 3. 將每筆 evaluation 明確連到 eval batch

目前 `rag_evaluations` 無法關聯 `rag_eval_runs`，因此無法回答「這筆 case 結果屬於哪一次 baseline/regression 執行」，同一 dataset/model/config 重跑時尤其無法可靠追溯。

修正要求：

- `rag_evaluations` 新增 nullable `eval_run_id`，FK 至 `rag_eval_runs(id)`；線上單一 run 的即時／人工評估可不屬於離線批次。
- 增加 constraint：只要 `case_id` 非 NULL，`eval_run_id` 就必須非 NULL，確保離線 dataset case 一定能追溯到評測批次。
- 建議 `ON DELETE CASCADE`，讓刪除評測批次時同步清除該批次明細；若採其他策略，需在契約寫清楚原因。
- 新增 `eval_run_id` index。
- 調整建表順序或以安全、可重複執行的方式新增 FK。
- 資料契約與驗證腳本需一併檢查這個欄位、FK 與 index。

### 4. 靜態驗證腳本不可把不安全 policy 判為 PASS

目前驗證腳本明確要求 `rag_runs`、`rag_run_sources` 存在 authenticated INSERT policy，正好把第 1 項漏洞當成成功條件。因此 60/60 不能證明授權方向正確。

修正要求：

- 改為驗證兩表只有符合需求的 authenticated SELECT policy。
- 明確驗證不存在 authenticated INSERT/UPDATE/DELETE policy。
- 驗證 feedback UPDATE 的新舊 parent ownership 條件。
- 加入第 3 項 `eval_run_id`、FK、index 的靜態檢查。
- 保留「不得 `DROP TABLE` / `TRUNCATE` 既有表」、5 張表、PK/FK/RLS 等既有檢查；`DROP POLICY IF EXISTS` 僅限本 migration 自己管理的同名 policy，可用於重跑安全。

### 5. 將 query hash 定義為 keyed HMAC，不可宣稱裸 SHA-256 已匿名化

財務查詢即使經遮罩仍可能具低熵或可被字典猜測；裸 SHA-256 也可跨紀錄關聯。契約目前將其描述成不可逆匿名值，風險說明不足。

修正要求：

- 契約指定 `query_hash = HMAC-SHA-256(server_secret, normalized_sanitized_query)`，輸出仍為 64 位小寫 hex。
- server secret 不得寫入 DB、log、repository 或前端。
- 記錄 key rotation 對跨期比對的影響；Task 01 不實作 runtime。
- 文案避免宣稱 hash 等同匿名化。

### 6. 明確處理帳號刪除後的高敏感 trace

目前 `rag_runs.user_id ON DELETE SET NULL` 會在帳號刪除後保留 query/answer，卻失去可定位資料主體的 FK。這與契約的刪除權、180 天保留策略有衝突。

修正要求：

- 本階段優先改為 `ON DELETE CASCADE`，帳號刪除時移除該使用者的 run，並由下游 FK cascade 清除 source/feedback/evaluation 關聯資料。
- 若確有法規或研究目的必須留存，不能只把 user_id 設 NULL；需另設不可回推個人的聚合資料流程。該替代方案超出 Task 01，先不要實作。
- 同步修正契約的刪除與保留策略。

## 保留事項（本次不阻擋，但文件要誠實）

- repository 只有 `user_profiles`、`ai_conversations`、`ai_messages` 的文件化 schema，沒有可供本地核對的既有 migration；請保留「部署前需比對實際 DB 欄位型別」警告，不得宣稱已完成 DB 相容性驗證。
- 目前環境沒有 PostgreSQL parser / Supabase CLI；可維持 stdlib 靜態檢查，但報告必須明確說明未執行 SQL parser 與 DB migration。

## 允許修改範圍

只能修改：

- `supabase/migrations/20260814120000_rag_trace.sql`
- `docs/RAG_TRACE_DATA_CONTRACT.md`
- `scripts/validate_rag_trace_migration.py`
- `claude_tasks/reports/TASK-01.md`
- `claude_tasks/STATUS.md` 的 Task 01 Implementation 欄位

不可修改 `claude_tasks/STATUS.md` 的 Codex review 欄位。

## 重新送審驗收標準

- 上述 6 項全部修正，SQL、契約、驗證腳本互相一致。
- 驗證腳本 exit code 0，且輸出需顯示新的安全規則與 `eval_run_id` 檢查確實執行。
- `git diff --check` 通過。
- 報告列出實際修改檔案、執行指令與完整結果，並揭露未連 DB、未執行 migration。
- Implementation 更新回 `READY_FOR_CODEX_REVIEW` 後立即停止，等待 Codex 複審；不得開始 Task 02。
