# TASK 02 — Codex Review

審核結果：`CHANGES_REQUESTED`

審核日期：2026-08-14

> 第二輪複審：原 5 項修正已通過，但另確認 rewrite exception 仍會被誤記 success；最新唯一修正清單見 `claude_tasks/reviews/TASK-02-ROUND-02.md`。Task 02 仍為 `CHANGES_REQUESTED`。

本文件是 Task 02 第一輪必要修正清單。Claude Code 只能修正 Task 02，不得開始 Task 03，不得連正式 DB、執行 production migration、修改 UI、commit 或 push。

## 審核結論

目前架構方向正確：trace service 可注入、AI Chat 接線幅度小、response 採增量欄位、service-role store 不使用一般 `SupabaseDB.key`，既有 46 項測試也能重現通過。

但 Codex 以現有測試未涵蓋的真實路徑做反例檢查後，確認有 5 個阻擋問題：`.env` credential 載入太晚、真實 RAG fallback 被誤記 success、primary trace store 可破壞 Chat、敏感資料仍會進 trace/legacy metrics，以及 DB source 寫入失敗會留下半套 run。因此 Task 02 暫不 PASS。

## 必須修正（阻擋 PASS）

### 1. Trace singleton 必須在 `load_dotenv()` 之後建立

目前 `app.py` 先呼叫 `get_trace_service()`，之後才 `load_dotenv()`。若部署依賴 `.env`，trace service 初始化時看不到 `RAG_TRACE_HMAC_SECRET`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`，會永久停用 DB store；後續載入環境變數也不會重建 singleton。

修正要求：

- 將既有 `load_dotenv()` 放在 trace singleton 建立之前；避免為此重排其他不相關初始化。
- 或讓 trace singleton 延遲建立，但不得每 request 重建 Supabase client。
- 新增隔離測試：credential 只在 dotenv load 時出現，完成 app 初始化後 trace 必須看到 HMAC secret 且 DB store 不因載入順序被誤判 missing。
- 測試不得輸出或保存真實 secret。

### 2. 真實 KB unavailable / retrieval fallback 必須記為 degraded

`RAGService.augment_chat()` 在 `kb_loaded=False` 或自己捕捉外層 retrieval exception 時，回傳空 `metrics_record`；app 只在 `augment_chat()` 直接往外 raise 時呼叫 `note_rag_error()`。因此真實降級路徑會被 trace 記成 `success`。

修正要求：

- `augment_chat()` 必須永遠回傳足以判定狀態的安全 metrics：至少包含 `empty_context` 與允許清單內的 `fallback_reason` 代碼。
- KB 未載入使用固定代碼，例如 `kb_unavailable`；outer retrieval exception 使用固定代碼，例如 `retrieval_error`，不得包含 `str(exc)`。
- app 在 `_rag` 不存在或 `_rag_available=False` 時也要讓當次 trace 明確 degraded，但不得改變原本 Chat fallback 回答流程。
- 新增使用真實 `RAGService.augment_chat()` 行為的測試，不可只讓 FakeRAG 直接 raise。
- 驗證：KB unavailable、retrieval exception、empty context 都是 `status=degraded`、`fallback=true`，正常有來源仍為 success。

### 3. 任何 trace store failure 都不得改變 Chat 結果

目前 `RAGTraceService.persist()` 只捕捉 `_db_store` 例外，沒有捕捉可注入的 primary `_store.save_run()` 例外。primary store raise 時，`TraceRun.finish()` 會拋錯，原本成功的 AI Chat 會進入外層錯誤 response。

修正要求：

- primary store 與 DB store 都必須被獨立 try/except 隔離。
- `start_chat_run()`、`record_rag()`、`finish()` 與 `persist()` 對呼叫端都不得 raise。
- 只記錄固定安全錯誤代碼，不記 exception text。
- 新增 endpoint 測試：primary store raise 時仍回傳原本 reply、HTTP 行為與既有欄位，trace failure 不能改寫成「系統錯誤」。

### 4. 補齊敏感資料防護，禁止 raw exception/query 進持久化資料

現有 sanitizer 只遮 email、錢包、URL、電話。Codex 反例確認姓名、台灣身分證、JWT、64-hex 私鑰與助記詞會原樣留在 memory/DB payload。`finish(error=str(e))` 與 raw `fallback_reason` 也可能保存 provider exception 內的 token。既有 `RAGMetricsService` 在 debug logging 開啟時仍將 `query[:200]` 寫入 JSONL，形成繞過新 trace 契約的旁路。

修正要求：

- 至少增加：明確標示姓名、台灣身分證、護照、JWT、常見 API key/token、64-hex 私鑰、PEM private key、明確標示的 seed phrase/mnemonic 遮罩。
- 對高風險 secret 寧可整段替換／停止 DB trace，也不可保存原值；文件說明 regex 無法保證辨識所有自然語言姓名。
- HMAC secret 必須具合理最低強度（建議至少 32 bytes）；不足時 fail closed 並回安全代碼。
- trace `error` 只保存固定代碼（如 `ai_chat_error`），不得保存 `str(e)`。
- `fallback_reason` 只允許固定代碼，不保存冒號後的 provider exception。
- AI Chat 的 legacy RAG metrics/query debug 路徑也不得落 raw query；使用同一安全化結果或不保存 query 內容。新的改動不得讓其他 endpoint 接上 Task 02 trace。
- 移除／避免 RAG debug log 中的 raw query、rewrite 原文；只留不含使用者內容的結構化資訊。
- 新增反例測試，逐一確認上述原文不在 memory record、Supabase payload、JSONL/debug log、API error response 出現。

### 5. Source 寫入失敗不得留下看似完整的孤立 run

目前先 insert `rag_runs`，再 insert `rag_run_sources`。第二步失敗時，run 已永久存在且狀態仍可能是 success；相同 trace_id 重試又會撞 UNIQUE，會污染準確率資料。

修正要求：

- 本 Task 不新增大型 RPC/migration 重構；採局部補償策略即可。
- run insert 成功但 source insert 失敗時，以剛建立的 run id（必要時 trace_id）嘗試刪除本次新 run，讓 FK cascade 清理；不得刪除其他 run。
- run insert 回應缺 id 時，也應以本次唯一 trace_id 嘗試補償清除。
- cleanup 自己失敗時只記固定錯誤代碼，Chat 仍成功；報告誠實揭露這是 compensation、不是跨 HTTP request 的真正 transaction。真正原子 RPC 可另列後續工作。
- 新增 fake-client 測試：source insert failure 後確實只對該 run/trace 發出 cleanup；Chat 回答不受影響；不得留下可被當成成功 trace 的測試資料。
- 同時處理空 `source` / `excerpt` 等不符合 schema constraint 的來源：跳過無效 row 或轉成明確合法值，不能讓單一髒來源製造半套 run。

## 既有正確方向，修正時必須保留

- 只接 `/api/ai-chat`，不得接 Agent / Scam / Podcast / Health。
- API 成功 response 保留 `reply`、`conversation_id`，只增量加入 `trace_id`、`citations`、`confidence`。
- demo `user_id=NULL`；一般會員使用 Auth UID；不得互相污染。
- DB/migration 不可用時 Chat 仍正常。
- `confidence` 暫存 response 字串、DB numeric 欄位維持 NULL，可接受；不得自行發明 0–1 分數。
- `prompt_version` / `index_version` 維持 NULL planned，可接受。
- 不要統一整個 `app.py` 行尾；保留既有 CRLF，只檢查新增行無真正 trailing space。

## 允許修改範圍

只能修改：

- `app.py` 的 `/api/ai-chat` trace 接線與 trace 初始化位置
- `services/rag_trace_service.py`
- `services/rag_service.py` 的 `augment_chat()`／安全 metrics 相關局部程式
- `services/rag_metrics_service.py` 的 query/log 安全化局部程式（只為阻止 raw AI Chat query 持久化／寫 log）
- `services/prompt_builder.py`（只有 existing injected_count 修正確有需要時）
- `tests/test_rag_trace_service.py`
- `tests/test_ai_chat_trace.py`
- 可新增一個小型、專門驗證 Task 02 初始化順序／legacy metrics 隱私的測試檔
- `claude_tasks/reports/TASK-02.md`
- `claude_tasks/STATUS.md` 的 Task 02 Implementation 欄位

不可修改 Codex review 欄位，不得修改 migration/data contract，除非先停止並說明不可避免的契約衝突；目前預期不需要修改。

## 重新送審驗收標準

- 上述 5 項全部修正並加入能重現原缺陷的 regression tests。
- 原有 46 項測試保留；新增測試後全數通過。
- `python3 -m unittest tests.test_rag_trace_service -v` 通過。
- `python3 -m py_compile` 涵蓋所有本次修改的 Python 檔案。
- Task 01 validator 70/70 保持通過。
- `git -c core.whitespace=cr-at-eol diff --check` 通過，新檔無 trailing whitespace。
- 報告需列出測試總數、反例覆蓋、CRLF 說明、未連 DB／未執行 migration，以及 compensation 非真正 transaction 的限制。
- Implementation 更新回 `READY_FOR_CODEX_REVIEW` 後立即停止；不得開始 Task 03。
