# TASK-02 實作報告（含 Codex 第一、二輪複審修正）

## 本次目標

新增獨立、可注入 store 的 RAG trace service，只接入 `/api/ai-chat`：一次 Chat 產生唯一 trace_id，串起安全化 query、檢索來源（含 actually injected）、answer、版本、token/latency、fallback/error/status 與 conversation_id；trace 失敗不影響回答；DB 寫入 fail closed（明確 service-role 憑證）。

## Codex 第二輪複審修正（唯一 blocker：rewrite exception 誤記 success）

### 問題

deep route 的 query rewrite 發生 exception 時，`_retrieve_for_endpoint` 只寫 warning、未設定 `fallback_reason`；後續 retrieval 成功時 metrics 的 fallback_reason 為空 → trace 被誤記為 `success`（污染成功率樣本）。

### 實際修改（最小改動）

1. `services/rag_service.py`（rewrite exception 分支，2 行）：新增 `fallback_reason = "rewrite_error"`（固定安全代碼）；仍以**原 query** 繼續 retrieval，不變 fatal。
2. `services/rag_trace_service.py`（1 行）：`_ALLOWED_FALLBACK_CODES` 加入 `"rewrite_error"`。

未動 prompt、LLM 回答、引用排序、retrieval 演算法、其他 endpoint、UI、migration；未重構任何 service 或 app.py。

### 新增 regression tests（2 個）

- `tests/test_rag_trace_service.py::RewriteFallbackTraceTests::test_rewrite_exception_with_successful_retrieval_is_degraded`：
  真實 `RAGService._retrieve_for_endpoint()`（real router → rewriter raise（exception text 含合成假 token `sk-fake-secret-token-…`）→ real retrieval 回 2 筆來源）：
  - route == deep；results ≥ 1；metrics `fallback_reason == "rewrite_error"`；
  - trace `status == "degraded"`、`fallback is True`、`fallback_reason == "rewrite_error"`；
  - source/citation 保留；假 token 不出現在 persisted payload（run/sources）與 rag_service/rag_trace_service log。
- `tests/test_ai_chat_trace.py::RewriteFallbackEndpointTests::test_rewrite_exception_endpoint_behavior`：
  以真實 `RAGService` 接上端點（rewriter raise + 合成假 token）：
  - Chat 原回答、HTTP 200、`reply`/`conversation_id`/`trace_id`/`citations` 不變；citation ≥ 1；
  - API response 不含假 token；trace degraded（rewrite_error）且 sources ≥ 1。
  - 註：測試環境無 jieba/dense 時 topic filter 會使 sparse 檢索 0 筆，故測試中僅將 filter 以 topics=None 交由**真實檢索引擎**執行（環境適應，不屬 production 程式變更）。

### rewrite_error 反例結果（修正前重現）

- 以「暫時移除 `fallback_reason = "rewrite_error"`」還原修正前狀態執行新測試：**FAILED**（重現誤記 success 路徑）。
- 復原修正後：新測試與全部 80 項測試**通過**。

## 修改檔案

| 檔案 | 修改目的 |
|---|---|
| `services/rag_trace_service.py`（新增） | Trace service：擴充 PII/secret 遮罩、keyed HMAC-SHA-256（≥32 bytes）、allowlist 代碼、primary/DB store 雙重例外隔離、source 寫入失敗補償 cleanup、無效來源跳過 |
| `services/rag_service.py` | `augment_chat` 永遠回傳安全 metrics（`kb_unavailable`/`retrieval_error` 固定代碼）；`_retrieve_for_endpoint` 的 fallback_reason 代碼化；debug log 移除 raw query/rewrite 原文 |
| `services/rag_metrics_service.py` | legacy metrics `build_record` 的 query 經同一遮罩器後才落 JSONL（封閉旁路） |
| `services/prompt_builder.py` | `build_chat_prompt` 增量回傳 `injected_count` |
| `app.py` | `load_dotenv()` 移至 trace singleton 建立之前；RAG/KB 不可用時 trace 明確 degraded；錯誤 response 固定訊息（不回傳 provider exception）；trace 增量欄位不變 |
| `tests/test_rag_trace_service.py`（新增） | 56 個單元測試：遮罩反例、HMAC 強度、allowlist、store 隔離、補償 cleanup、真實 RAGService 降級、legacy metrics 隱私 |
| `tests/test_ai_chat_trace.py`（新增） | 端點測試：正常/空 context/LLM error/store 失敗/RAG 不可用/使用者隔離/API 相容/secret 不洩漏 |
| `tests/test_trace_init_and_metrics_privacy.py`（新增） | dotenv 載入順序（靜態 + 隔離 subprocess 行為驗證） |
| `claude_tasks/STATUS.md` | 僅 Task 02 Implementation 欄位 |

## Codex 第一輪五項「必須修正」完成狀況

### 1. Trace singleton 必須在 load_dotenv() 之後建立 ✅

- `app.py`：`load_dotenv()` 移至 `_get_trace_service()` 之前（未重排其他初始化；RAG 區塊維持原順序）。
- 測試：
  - `test_load_dotenv_before_trace_singleton_in_source`：靜態檢查 app.py 原始碼順序。
  - `test_dotenv_credentials_visible_after_app_init`：隔離 subprocess（cwd=temp、清空繼承憑證環境變數、僅 temp `.env` 提供合成憑證），驗證 app 初始化後 `HMAC_OK=1`、`DB_DISABLED=None`；測試輸出不包含任何 secret 值。

### 2. 真實 KB unavailable / retrieval fallback 必須記為 degraded ✅

- `rag_service.augment_chat()`：`kb_loaded=False` → metrics `{"empty_context": True, "fallback_reason": "kb_unavailable"}`；外層 retrieval exception → `"retrieval_error"`（不含 `str(exc)`）。成功路徑沿用既有 metrics。
- `_retrieve_for_endpoint`：`fallback_reason` 改為固定代碼（`router_error`/`retrieval_error`，不再附 exception）。
- app 層：`_rag is None` 或 `_rag_available=False` → `trace_run.note_rag_unavailable()`（degraded + `kb_unavailable`），不改變原有回答流程。
- 測試（真實 `RAGService.augment_chat()`，非 FakeRAG raise）：
  - `test_kb_unavailable_is_degraded`、`test_retrieval_exception_is_degraded_with_fixed_code`、`test_empty_context_is_degraded`、`test_normal_retrieval_is_success_with_citations`（success 路徑保持 success、citations 與 actually_injected 正確）。
  - 端點：`test_rag_none_marks_degraded_kb_unavailable`、`test_rag_unavailable_marks_degraded_kb_unavailable`。

### 3. 任何 trace store failure 都不得改變 Chat 結果 ✅

- `RAGTraceService.persist()`：primary store 與 DB store 各自獨立 try/except，只記錄固定代碼。
- `TraceRun.finish()` 外層再包 try/except（`trace_finish_failed`）→ start/record/finish/persist 對呼叫端永不 raise。
- 測試：`test_primary_store_raise_isolated`（service 層）、`test_primary_store_raise_chat_still_succeeds`（端點：仍回原本 reply + conversation_id + trace_id，非「系統錯誤」）。

### 4. 補齊敏感資料防護 ✅

- 遮罩器新增：標示姓名（`姓名:`/`name:`）、台灣身分證（`A123456789`）、護照（`護照號碼…`）、JWT、常見 API key（sk-/AKIA/xox/ghp_）、Bearer token、64-hex 私鑰、PEM private key（多行）、標示的 seed phrase/mnemonic（12/24 字）。高風險 secret 整段替換。
- 已知限制已於 code 註解與報告說明：regex 無法辨識所有自然語言姓名（未標示的中文姓名無法保證）。
- HMAC secret **≥32 bytes**（utf-8），不足時 `trace_hmac_secret_weak` fail closed（不寫 DB，安全 warning）。
- trace `error` 只保存 allowlist 代碼（目前 `ai_chat_error`）；`fallback_reason` 只保存 allowlist 代碼（冒號後的 provider exception 被剝除；未知代碼 → `rag_fallback`）。
- 錯誤 response 固定為「系統錯誤，請稍後再試。」，不回傳 `str(e)`。
- legacy metrics 旁路封閉：`rag_metrics_service.build_record` 的 query 經同一 `sanitize_text` 才落 JSONL；`rag_service` debug log 移除 raw query 與 rewrite 原文（只留 route/similarity 等結構化資訊）。
- 反例測試：`SanitizerSecretPatternTests`（8 項）、`LegacyMetricsPrivacyTests`（build_record + JSONL 落盤）、`test_llm_error_does_not_leak_exception_text`（response/memory 皆無 token）、`test_response_and_logs_contain_no_secret`、`test_logs_contain_no_query_answer_or_secret`。

### 5. Source 寫入失敗不得留下孤立 run ✅

- `SupabaseTraceStore.save_run()`：run insert 成功但 source insert 失敗 → 以本次 `trace_id`（＋剛取得的 `run_id`）對 `rag_runs` 執行補償 delete（FK cascade 清理）；run insert 回應缺 id → 以 `trace_id` 補償 delete。**只刪本次 run，不觸及其他 trace**（delete 條件同時帶 `trace_id` 與 id）。
- cleanup 自己失敗 → 只記 `trace_cleanup_failed`，Chat 仍成功。**此為 compensation，不是跨 HTTP request 的真正 transaction**；真正原子 RPC（單一 DB function 內 insert run+sources）列為後續工作。
- 無效來源（空 source/excerpt、rank<1）在 `to_source_payloads` 跳過/修正，單一髒來源不會製造半套 run。
- 測試：`CompensationTests.test_source_failure_cleans_only_this_run`（驗證僅刪本次 trace、其他 run 保留）、`test_missing_run_id_cleans_by_trace`、`test_cleanup_failure_still_returns_source_code`、`SourcePayloadValidationTests`、端點 `test_db_store_source_failure_chat_still_succeeds`。

## 既有正確方向（保留）

- 只接 `/api/ai-chat`；未動 UI；未重寫 Chat loop、驗證、對話/訊息儲存。
- 成功 response 保留 `reply`、`conversation_id`，僅增量 `trace_id`、`citations`、`confidence`。
- demo `user_id=NULL`；一般會員 Auth UID；不互相污染。
- DB/migration 不可用時 Chat 正常；`confidence` 為字串、DB numeric 欄位 NULL；`prompt_version`/`index_version` NULL planned。
- 未統一 app.py 行尾（保留既有 CRLF）。

## 資料流與權限影響

- 資料從哪裡進來：`/api/ai-chat` request（經遮罩）與 `augment_chat` 增量回傳。
- 寫入哪裡：記憶體 ring buffer＋（service-role＋HMAC secret 齊備時）`rag_runs`/`rag_run_sources`。
- 誰有權讀寫：寫入僅 trace service（service-role client）；API 權限不變。
- 失敗時如何處理：store 失敗/停用 → 固定代碼 warning → Chat 照常；半套 run 以補償 delete 清理。

## 測試證據

| 指令 | 結果 | 備註 |
|---|---|---|
| `/tmp/cip-test-venv/bin/python -m pytest tests/ -q` | **80 passed**（第二輪後；原 78 項全數保留＋新增 2 項 rewrite_error 反例） | venv Python 3.9.6（自 ~/venv 建立於 /tmp）、flask 3.1.3、pytest 8.4.2、supabase 2.30.0 |
| 修正前重現 | 新測試 `RewriteFallbackTraceTests` 在暫時移除修正行時 **FAILED**（重現誤記 success）；復原後通過 | 見「第二輪複審修正」節 |
| `python3 -m unittest tests.test_rag_trace_service -v` | **57 tests OK**（系統 python 3.14） | 核心 service 純 stdlib |
| `python3 -m unittest tests.test_trace_init_and_metrics_privacy -v` | **2 tests OK（1 skipped：無 flask）** | 靜態順序檢查在無依賴環境亦執行 |
| `/tmp/cip-test-venv/bin/python -m py_compile services/rag_service.py services/rag_trace_service.py tests/test_rag_trace_service.py tests/test_ai_chat_trace.py` | OK | 本輪修改 4 檔 |
| `python3 scripts/validate_rag_trace_migration.py` | PASS（70/70） | TASK 01 回歸 |
| `git -c core.whitespace=cr-at-eol diff --check` | 通過（無輸出） | app.py 既有 CRLF 慣例；本輪修改檔無真正 trailing space |
| 本輪修改檔 trailing whitespace | 4 檔皆 0 | |

## CRLF 說明

`app.py` 全檔為 CRLF（既有慣例）。預設 `git diff --check` 會把新增行的行尾 `\r` 標為 trailing whitespace；使用單次 `git -c core.whitespace=cr-at-eol diff --check`（未修改任何 git config）通過，且逐行確認本次新增行沒有 space/tab 結尾。未統一全檔行尾。

## Git 變更摘要

- `git status --short`：
  ```
   M app.py
   M services/prompt_builder.py
   M services/rag_metrics_service.py
   M services/rag_service.py
  ?? CLAUDE.md
  ?? claude_tasks/
  ?? docs/RAG_TRACE_DATA_CONTRACT.md
  ?? scripts/validate_rag_trace_migration.py
  ?? services/rag_trace_service.py
  ?? supabase/
  ?? tests/
  ```
  未 commit、未 push；TASK 01 檔案（migration/契約/validator）未更動。

## 未完成／刻意未做與誠實揭露

- **第二輪亦未連線任何資料庫、未執行 migration、未 commit、未 push**；DB 寫入路徑以 fake supabase module 驗證。
- 第一輪起未連線任何資料庫、未執行 migration；DB 寫入路徑以 fake supabase module 驗證。
- 補償 cleanup 非真正 transaction；原子 RPC 方案未實作（後續工作）。
- HMAC secret 的 key rotation 管理未實作（契約 planned）。
- regex 遮罩無法保證辨識所有自然語言姓名（未標示者），文件與 code 註解已說明。
- 未接 Agent/Scam/Podcast/Health；未改 UI。

## 請 Codex 特別審核

1. 遮罩器規則集（特別是新加的 JWT/API key/64-hex/身分證/姓名/護照）的誤殺/漏殺取捨。
2. 補償 delete 的條件（`trace_id`＋id）是否足夠安全（只刪本次 run）。
3. 錯誤 response 固定訊息是否屬可接受的相容性變更（原「系統錯誤: {str(e)}」已移除 exception text）。
4. HMAC secret 32 bytes 門檻與 `trace_hmac_secret_weak` 的 fail-closed 行為。
5. `rag_metrics_service` 引用了 `rag_trace_service.sanitize_text`（避免重複實作），此耦合是否可接受。

## 自我判定

- [x] 未超出 Task 範圍（第二輪僅 2 個檔案各 1–2 行＋2 個新測試）
- [x] 未開始下一 Task
- [x] 未執行 production migration、未連線正式 DB、未 commit、未 push
- [x] 未加入 secret／私鑰／助記詞（測試僅合成佔位字串）
- [x] 測試已實際執行（80/80；57/57；validator 70/70；修正前重現 FAILED → 修正後通過）
- [x] `STATUS.md` Implementation 維持 `READY_FOR_CODEX_REVIEW`；Codex review 欄位未動
