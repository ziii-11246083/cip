# 2026-08-20 最終交付前 QA

## 結論

- 結果：PASS（本 repository 可離線、不改變外部狀態的自動化關卡全數通過）
- 測試環境：全新 Python 3.12.13 arm64 virtual environment
- 依賴完整性：`pip check` PASS
- 外部呼叫隔離：OpenAI / Supabase 不使用真實憑證，log 無 quota、connection、embedding 或 Chroma init 錯誤

## 本輪額外發現與修正

1. 兩個 real-retrieval regression tests 可被工作區上層 `.env` 影響，意外呼叫真實 OpenAI embedding。已在測試內注入 fresh sparse-only retrieval，明確關閉 embedding/vector，並斷言 embedding 未初始化。
2. ChromaDB 0.5.23 與 PostHog 6+ `capture()` 介面不相容。已實測界線並在 requirements 限制 `posthog<6`。
3. 舊 `data/vector_store/` 是不相容的 generated cache，會讓 Chroma 以 `'_type'` 錯誤降級。不刪除舊快取，改用版本化預設目錄 `data/vector_store_v2/`，並實作 `RAG_VECTOR_DB_PATH` 覆寫。
4. 新增 vector store clean-store 回歸測試，覆蓋初始化、rebuild、query 與 env path。

## 最終驗證結果

| 關卡 | 結果 |
|---|---|
| pytest | 286 passed + 43 subtests passed |
| unittest discovery | 286 passed |
| AI Coach Node suite | 23/23 PASS |
| Python AST | 39 files PASS |
| JavaScript syntax | 16 files PASS |
| RAG trace migration validator | 70/70 PASS |
| Asset sync migration validator | 108/108 PASS |
| Asset sync MVP validator | 28/28 PASS |
| RAG CLI real local-KB smoke | 15/15 completed, failed=0, MRR=0.7222 |
| Flask pages/static | 14 pages + 32 referenced assets + `/version` PASS |
| Auth fail-closed | 23 protected endpoints PASS |
| Pure API smoke | 3 endpoints PASS |
| Gunicorn config/load | PASS |
| Chroma clean/default store | init/rebuild/query PASS；無 telemetry/init error |
| Dependency integrity | PASS |
| Secret scan | production hits=0；25 個命中皆為 tests/review 合成反例 |
| Large-file gate | PASS（無非忽略檔案 > 5 MiB） |
| Credential ignore | `serviceAccountKey.json` ignored and untracked |
| CRLF-aware diff check | PASS |

## 已知上游警示

- ChromaDB 0.5.23 在 Pydantic 2.11+ 會產生 `model_fields` deprecation warning；功能測試的 init/rebuild/query 均通過。不能為消除此 warning 將 Pydantic 降到 2.11 以下，因 Supabase realtime 2.30.0 明確要求 `pydantic>=2.11.7,<3`。後續升級 Chroma 時再移除這個上游相容警示。

## 自動化無法代替的上線前驗證

- 兩份 Supabase migration 與 RAG trace migration 未實際執行；需先在 test project 驗證 DDL、RLS 與 RPC transaction。
- 未使用真實 Alchemy key，因此需手動驗證 Ethereum Mainnet 公開地址的分頁、partial error、rate-limit 與 last-good UI。
- 未使用真實 OpenAI 驗證 LLM 回答品質；準確性必須以人工審核的 baseline/eval 判定，自動 retrieval metrics 不等於答案已被證明正確。
- 真實瀏覽器的視覺、行動版、快速連點、登入與跨頁狀態仍需人工操作。

## Git 狀態

- branch：`08/20`
- 遠端 checkpoint 仍為 `5b7f52351c92e75406e9d8296bf103b8364423ac`
- TASK 05A 後續修正、TASK 05B–12 與本 QA 修正仍是本機未 commit / 未 push 變更。
