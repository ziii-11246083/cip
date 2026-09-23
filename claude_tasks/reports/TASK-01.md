# TASK-01 實作報告（含 Codex 複審修正）

## 本次目標

建立「RAG 回答可追溯」的資料契約文件與可版本化、可重複執行的 SQL migration（5 張新表 + RLS），並以純靜態驗證腳本證明 schema/migration 齊全；不接 runtime、不改 UI、不執行 migration、不連線 DB。

## 修改檔案

| 檔案 | 修改目的 |
|---|---|
| `supabase/migrations/20260814120000_rag_trace.sql`（新增） | 5 張表 rag_runs / rag_run_sources / rag_feedback / rag_evaluations / rag_eval_runs + index + RLS policies；idempotent；無 DROP/TRUNCATE |
| `docs/RAG_TRACE_DATA_CONTRACT.md`（新增） | 逐欄說明用途、敏感性、寫入者、讀取者、nullable 原因；RLS 矩陣；遮罩/保留/刪除策略；feedback 非 ground truth、LLM judge 非唯一真相 |
| `scripts/validate_rag_trace_migration.py`（新增） | 純 stdlib 靜態驗證：70 項檢查（含複審新增的安全規則） |
| `claude_tasks/STATUS.md` | 僅 Task 01 Implementation 欄位（IN_PROGRESS → READY_FOR_CODEX_REVIEW） |

## Codex 複審修正（六項「必須修正」全數完成）

### 1. 禁止一般登入使用者偽造 RAG run 與 source ✅

- SQL：刪除 `rag_runs_insert_own` 與 `rag_run_sources_insert_via_own_run` 兩個 INSERT policy。
  `authenticated` 對 `rag_runs` / `rag_run_sources` 現在**只有 SELECT policy**（runs 直接 `user_id = auth.uid()`；sources 經 parent run EXISTS），不得 INSERT/UPDATE/DELETE。
- 契約 §5.1/§5.2/§5.3：矩陣改為「—（僅 SR）」；新增原則「一般使用者不得寫入 runs/sources（防偽造稽核紀錄）」；明示 service role bypass RLS、不需另建 policy。
- Validator：`auth_policy_verbs() == ["SELECT"]`，且 `any_policy_verbs(..., INSERT/UPDATE/DELETE) == []`（任何 role 皆不得有寫入 policy）。

### 2. 修正 feedback UPDATE 的跨使用者 run 關聯漏洞 ✅

- SQL：`rag_feedback_update_own` 的 `USING` 與 `WITH CHECK` **同時**驗證
  `user_id = auth.uid()` 且 `EXISTS (SELECT 1 FROM rag_runs r WHERE r.id = rag_feedback.run_id AND r.user_id = auth.uid())`——新舊 parent run 都必須屬於本人。
- 契約 §5.3：說明 UPDATE 同時驗證「目前」與「更新後」的 run 所有權。
- Validator：擷取 UPDATE policy 區塊，驗證 `USING`/`WITH CHECK` 皆含
  `auth.uid()`（≥4 次）與 `rag_feedback.run_id`（≥2 次）、`r.user_id = auth.uid()`（≥2 次）。

### 3. 將每筆 evaluation 明確連到 eval batch ✅

- SQL：`rag_evaluations` 新增 **nullable `eval_run_id`**，FK → `rag_eval_runs(id)` **`ON DELETE CASCADE`**；
  新增約束 `CHECK (case_id IS NULL OR eval_run_id IS NOT NULL)`（離線 dataset case 必能追溯到評測批次）；
  新增 index `idx_rag_evaluations_eval_run`；建表順序調整為 `rag_eval_runs` **先於** `rag_evaluations`（滿足 FK 參照）。
- 契約 §2/§3/§4-4：FK 清單、ER 圖、資料字典同步；約束段落說明 CASCADE 語意（刪除批次同步清除明細）。
- Validator：欄位、FK CASCADE、約束、index、建表順序共 5 項檢查。

### 4. 靜態驗證腳本不可把不安全 policy 判為 PASS ✅

- Validator 改為驗證「僅 SELECT policy」並明確檢查**不存在** authenticated INSERT/UPDATE/DELETE policy（見第 1 項）；
  加入 feedback UPDATE 新舊 ownership、eval_run_id 全套檢查；保留既有 5 表/PK/FK/RLS/無 DROP TABLE/無 TRUNCATE 檢查；
  `DROP POLICY IF EXISTS` 僅限本 migration 自己管理的同名 policy（檢查 drop 數 == create 數）。
- 驗證腳本由 60 項擴充為 **70 項**。

### 5. query hash 定義為 keyed HMAC ✅

- 契約 §4-1/§6.1：`query_hash = HMAC-SHA-256(server_secret, normalized_sanitized_query)`，輸出 64 位小寫 hex；
  server secret 不得寫入 DB/log/repository/前端；明文記載 key rotation 會中斷跨期比對；**不宣稱雜湊等同匿名化**；
  標示 Task 01 不實作 runtime，實際 HMAC 計算屬後續 Task 寫入端責任。
- SQL：`query_hash` 欄位註解改為 keyed HMAC-SHA-256；CHECK `^[0-9a-f]{64}$` 不變（輸出格式相同）。
- Validator：檢查 SQL 註解與契約文件皆提及 `HMAC-SHA-256`。

### 6. 明確處理帳號刪除後的高敏感 trace ✅

- SQL：`rag_runs.user_id` 由 `ON DELETE SET NULL` 改為 **`ON DELETE CASCADE`**——帳號資料列刪除時連帶移除該使用者 runs（含高敏感 query/answer），
  下游 source/feedback/evaluation 經既有 FK cascade 一併清除。
- 契約 §2/§4-1/§6.2：FK 清單、ER 圖、刪除語意同步；保留策略新增「帳號刪除」cascade 語意說明，
  並誠實標示「Supabase Auth 刪除 auth user 是否連動刪除 user_profiles 屬既有帳號刪除流程，不在本契約範圍」。

## 保留事項（依 review，文件已誠實揭露）

- repository 沒有可供本地核對的既有 migration；契約 §7 保留「部署前需比對實際 DB 欄位型別（user_profiles / ai_conversations / ai_messages）」警告，**未宣稱已完成 DB 相容性驗證**。
- 本環境沒有 PostgreSQL parser / Supabase CLI；維持 stdlib 靜態檢查，報告明確揭露**未執行 SQL parser 與 DB migration**。

## 實際完成內容

- 5 張表 + PK/FK/index/CHECK + RLS，與契約文件、驗證腳本三方一致。
- 使用者鍵依 docs/08 §8-2-1 使用 `user_profiles.user_id`（= Auth UID），不假定 `user_profiles.id`。
- 欄位對齊現有 pipeline：`rewrite_*`、hit counts、`empty_context`、`fallback_reason`、latency 對應 `services/rag_metrics_service.py` 的 `build_record()`；`route` 含 `unknown`（rag_service.py L123）；`score` 0–1（reranker clamp，reranker_service.py L97）。
- 遮罩義務、保留期（runs 180 天 / eval_runs 365 天）、刪除策略、retention job 標示 planned。

## 未完成／刻意未做

- 未接線任何 runtime endpoint、未改 `app.py` / services / templates / static JS（Task 02+ 範圍）。
- 未執行 migration、未連線任何資料庫（含正式 Supabase）、未宣稱資料已寫入正式 DB。
- 未實作 retention job（文件標示 planned）；未實作 HMAC runtime 計算與 server secret 管理（Task 01 只定義契約）。
- 未開始 Task 02。

## 資料流與權限影響

- 資料從哪裡進來：本 Task 只定義 schema，無 runtime 資料流；未來（Task 02+）由後端 service role 寫入。
- 寫入哪裡：僅新增的 5 張 rag_* 表；不寫入任何既有表。
- 誰有權讀寫：使用者僅能 SELECT 自己的 runs/sources/feedback；唯一寫入是對自己 run 的 feedback（INSERT/UPDATE/DELETE，UPDATE 驗證新舊 run 所有權）；evaluation 寫入僅 service role；`rag_eval_runs` 僅 service role。
- 失敗時如何處理：本 Task 無 runtime 失敗路徑；migration 層面採 idempotent 設計，重複執行安全。

## 測試證據

| 指令 | 結果 | 備註 |
|---|---|---|
| `python3 scripts/validate_rag_trace_migration.py` | **PASS（70/70）** | 含複審 6 項新規則；輸出顯示 SELECT-only、feedback UPDATE ownership、eval_run_id 檢查確實執行；未連線 DB、未執行 migration、未經 SQL parser |
| `git diff --check` | 通過（無輸出） | 已追蹤檔無空白錯誤 |
| 新檔案 trailing whitespace 檢查（grep） | 3 檔皆 0 行 | 新檔案未追蹤，`git diff` 不涵蓋，另行等價檢查 |
| `git status --short` | 見下節 | 既有修改未被覆蓋/清除 |

## Regression 檢查

- Auth：未變動任何 runtime 程式，無影響（未執行 runtime 測試）。
- AI Chat：同上，無影響。
- 模擬交易：同上，無影響。
- 會員中心：同上，無影響。
- Podcast：同上，無影響。

> 說明：本 Task 只新增/修改文件、SQL 與靜態檢查腳本，未觸碰任何執行期程式碼，故未執行 runtime regression 測試；此為範圍內的正確行為，非以「測試無法執行」充當通過。

## Git 變更摘要

- `git status --short`：
  ```
  ?? CLAUDE.md
  ?? claude_tasks/
  ?? docs/RAG_TRACE_DATA_CONTRACT.md
  ?? scripts/validate_rag_trace_migration.py
  ?? supabase/
  ```
  （CLAUDE.md 與 claude_tasks/ 為任務前已存在之未追蹤檔案；無任何既有修改被覆蓋、還原或清除。未 commit、未 push。）
- `git diff --stat`：無輸出（本次全部為未追蹤新檔，`git diff` 不顯示）。新檔大小：
  - `supabase/migrations/20260814120000_rag_trace.sql`（14,819 bytes，複審後）
  - `docs/RAG_TRACE_DATA_CONTRACT.md`（複審後）
  - `scripts/validate_rag_trace_migration.py`（複審後 70 項檢查）

## 尚未進行的驗證（誠實揭露）

- 未以真實 PostgreSQL parser（如 pglast/sqlparse）解析 SQL——本環境未安裝且不新增依賴；validator 為文字層級靜態檢查。
- 未於任何 Supabase/PostgreSQL 環境執行 migration——FK 目標（user_profiles / ai_conversations / ai_messages）的實際欄位型別未經 DB 核對，部署前需比對實際 schema（契約 §7 已標示此警告）。
- 未驗證 RLS 實際行為（需真實 DB 與 JWT 才可測試）。

## 請 Codex 特別審核

1. `rag_feedback_update_own` 的 USING/WITH CHECK 雙重 ownership 驗證是否符合預期。
2. `eval_run_id` CASCADE 與約束 `case_id IS NULL OR eval_run_id IS NOT NULL` 是否完整滿足「離線批次可追溯」。
3. `rag_runs.user_id` 改 CASCADE 後，與 180 天 retention、評測資料保存的取捨是否可接受。
4. keyed HMAC 契約（secret 管理、rotation 影響）的文字是否足夠，且未宣稱匿名化。
5. RLS 矩陣（契約 §5.2）與 SQL policy 是否完全一致。

## 自我判定

- [x] 未超出 Task 範圍（僅修改 review 允許之檔案）
- [x] 未開始下一 Task
- [x] 未執行 production migration、未連線 DB
- [x] 未加入 secret／私鑰／助記詞
- [x] 測試已實際執行（validator exit 0、git diff --check 通過）
- [x] `STATUS.md` Implementation 已改為 `READY_FOR_CODEX_REVIEW`
