# TASK 02 — RAG Trace Service 與 AI Chat 接線

## 依賴

- Task 01 的 Codex review 必須為 `PASS`。

## 本次唯一目標

新增可測試的 trace service，只接入 `/api/ai-chat`。不得接其他 endpoint，不得修改前端 UI。

## 開始前必讀

- 共通規則、狀態表、Task 01 審核報告
- Task 01 的 data contract 與 migration
- `app.py` 中 `/api/ai-chat`
- `services/rag_service.py`
- `services/prompt_builder.py`
- `supabase_client.py`

## 實作要求

1. 新增獨立 trace service，使用 dependency injection 或可替換 store，避免測試綁正式 Supabase。
2. 一次 AI Chat 需產生唯一 trace_id，串起：
   - 原始 request 的安全化 query
   - retrieval results 與 actually injected sources
   - 最終 answer
   - model/prompt/kb/index/config version
   - token/latency/fallback/error/status
   - conversation_id；message_id 若現況拿不到可 nullable，文件說明
3. API response 保持既有 `reply`、`conversation_id`，只能增量新增 `trace_id`、`citations`、`confidence`。
4. DB/migration 尚未套用、DB unavailable 或 trace write 失敗時，AI Chat 仍需正常回答；但需有可觀測 warning，且不可包含敏感 query/secret。
5. 不要以 `except: pass` 吞掉所有 trace 錯誤；需記錄安全且可診斷的錯誤代碼。
6. Trace DB writer 必須使用明確的 service-role client 或注入式 store，並 **fail closed**：
   - 不得把 `SupabaseDB.key` 或一般 `_table()` 視為一定具有 service role，因現況會 fallback 到 `SUPABASE_KEY` / anon key。
   - 真正寫入 `rag_runs` / `rag_run_sources` 前，必須明確確認 service-role credential 已設定；缺少時不得嘗試以 anon/authenticated 身分偽裝寫入。
   - service role 缺少時只停用 trace DB 寫入並記錄不含敏感資料的 warning，AI Chat 原回答流程仍需成功。
   - service-role key 不得出現在 response、exception text、log、測試 fixture 或 repository。

## 測試最低要求

- 正常 RAG 回答：一個 run 對應正確 sources 與 answer。
- empty context/fallback：仍有 run 且狀態正確。
- LLM error：run 為 failed，既有 API error 行為不惡化。
- trace store error：Chat 本身仍成功。
- 只有 anon key、缺少 service-role key：不得嘗試 trace DB insert，需安全 warning，Chat 本身仍成功。
- 注入明確 service-role store：run/source 寫入路徑被呼叫，且測試不使用真實 secret 或正式 DB。
- 未登入/demo/一般會員的 user linkage 不互相污染。
- API 舊欄位相容測試。

## 不可做

- 不接 Agent、Scam、Podcast、Health。
- 不改 UI。
- 不重寫整個 AI Chat loop 或對話儲存。
- 不執行 production migration。

## 驗收

只證明 AI Chat trace 端到端成立；完成報告後停止。
