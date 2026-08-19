# TASK 01 — RAG Trace 資料契約與 Migration

## 依賴

- 無。這是第一個 Task。

## 本次唯一目標

只完成「RAG 回答可追溯資料契約」與可版本化 SQL migration。不得接入任何 runtime endpoint，不得修改 UI。

## 開始前必讀

- `claude_tasks/00_READ_ME_FIRST.md`
- `claude_tasks/STATUS.md`
- `services/rag_metrics_service.py`
- `services/rag_service.py`
- `supabase_client.py`
- `docs/08-資料庫設計.md`
- `docs/17-RAG精準化升級與評估.md`

## 允許修改

- 新增 `docs/RAG_TRACE_DATA_CONTRACT.md`
- 新增 `supabase/migrations/<timestamp>_rag_trace.sql`
- 新增只驗證 schema/migration 的測試或靜態檢查
- 更新 `claude_tasks/STATUS.md`
- 新增 `claude_tasks/reports/TASK-01.md`

除上述檔案外不得修改。

## 資料契約要求

至少設計：

1. `rag_runs`
   - trace_id、user/conversation/message 關聯（允許 nullable）
   - endpoint、sanitized_query、query_hash、answer
   - model、prompt、knowledge base、index/config 版本
   - route、confidence、abstained、fallback、status、error
   - token、latency、created_at
2. `rag_run_sources`
   - run、chunk、source/topic/section、rank、score、content_hash、excerpt、actually_injected
3. `rag_feedback`
   - run、user、up/down、reason、comment、created_at
4. `rag_evaluations`
   - run/case、evaluator type、faithfulness、relevance、citation correctness、completeness、安全性、總分、pass、reviewer/version
5. `rag_eval_runs`
   - dataset/config/code version、overall/per-endpoint metrics、artifact path、created_at

## 安全與資料一致性

- 所有表必須有 PK、FK、必要 index、created_at 與合理 constraint。
- 設計 RLS：使用者只能讀取自己的 runs/feedback；一般使用者不能任意寫 evaluation；管理員存取方式需清楚標示。
- migration 不得假定不存在的 `user_profiles.id`；先依現有 schema 文件確認使用者鍵是 `user_id` 或 auth UID。
- 不保存 API Key、token、私鑰、助記詞。
- 說明 query/answer 的遮罩、保存期限與刪除策略；若 SQL 不實作 retention job，文件要標示 planned。
- migration 需可重複部署或至少對單次 versioned migration 安全，不得包含破壞既有表的 DROP/TRUNCATE。

## 不可做

- 不修改 `app.py`、現有 services、templates、static JS。
- 不執行 migration。
- 不宣稱資料已成功寫入正式 DB。

## 驗收

- SQL 可被靜態解析，table/constraint/index/RLS policy 齊全。
- 文件逐欄說明用途、敏感性、寫入者、讀取者、nullable 原因。
- 清楚說明 feedback 不是 ground truth，LLM judge 也不是唯一真相。
- 完成報告後停止，等待 Codex 審核。
