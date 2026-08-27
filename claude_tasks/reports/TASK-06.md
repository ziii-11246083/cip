# TASK-06 實作報告

## 本次目標

保護 RAG rebuild/eval/detailed metrics，將公開 stats 收斂成無敏感 health summary，並為昂貴 rebuild 加入 server-side admin 驗證、併發鎖、完成驗證與安全 audit；不修改 retrieval/rerank 演算法或建立後台 UI。

## 實際完成內容

- `token_required` 在 Supabase `get_user(token)` 驗證成功後，只從可信 `user.app_metadata` 解析 `role=admin`、`roles` 含 admin 或 `is_admin=true`；不使用 email/user_metadata，不硬編名單。
- 新增 `admin_required`：無 token 沿用 401，驗證會員但非 admin（含 demo、偽造 admin email/user_metadata）固定 403 `auth/forbidden`。
- `POST /api/rag/rebuild-index` 改 admin-only；nonblocking process lock 防同一服務程序內併發，第二請求固定 409。
- rebuild 回傳後驗證 count>0、BM25 可用/corpus>0；若 embeddings/vector 設定啟用且 embedding 可用，vector store 也必須可用。例外、0 筆、component 驗證失敗都固定 500，不回 raw exception 或假 success。
- `GET /api/rag/stats` 保持 public，但只回 status、kb_loaded、available_components、total_components；不含 component 名稱、metrics、query/user/path/config/model。
- 新增 `GET /api/rag/stats/details` admin-only；只回 component health、BM25 corpus、aggregate metric allowlist 與遮罩後 config/model，不回 recent records/raw query。
- `POST /api/rag/eval` 改 admin-only；queries 為 1–20 筆、每筆 1–500 字、endpoint allowlist。RAG 不可用 503，result shape/provider error 固定 500。
- eval response 的 query/topic/snippet/method/route 經既有 sanitizer，source 只留 basename，score 僅 finite float；provider path/token/控制字元不外洩。
- admin audit 只記 action/status/fixed code 與 actor UID 的 12-char SHA-256，不記 token、email、query、exception；invalid input、busy、start/success/failure/forbidden 都有紀錄。

## 權限／HTTP 矩陣

| Endpoint | Anonymous | Normal/demo/spoof | Trusted admin |
|---|---:|---:|---:|
| `POST /api/rag/rebuild-index` | 401 | 403 | 200／409／500 |
| `POST /api/rag/eval` | 401 | 403 | 200／400／503／500 |
| `GET /api/rag/stats` | 200 health only | 200 health only | 200 health only |
| `GET /api/rag/stats/details` | 401 | 403 | 200 aggregate details |

## 測試證據

| 指令 | 結果 |
|---|---|
| `/tmp/cip-test-venv/bin/python -m pytest tests/test_rag_admin_security.py -q` | 11 passed |
| `/tmp/cip-test-venv/bin/python -m pytest tests/ -q` | 228 passed，11 個既有第三方 warnings |
| `python3 -m unittest tests.test_rag_trace_service` | 70 tests OK |
| `python3 scripts/validate_rag_trace_migration.py` | 70/70 PASS |
| `py_compile app.py tests/test_rag_admin_security.py scripts/eval_rag.py tests/test_rag_eval.py` | PASS |
| `git -c core.whitespace=cr-at-eol diff --check` | PASS |

### 11 個 Task 06 測試覆蓋

- 三個 protected endpoints 的 anonymous 401、normal 403；demo、admin email/user_metadata spoof 仍 403。
- Public stats exact allowlist；admin details aggregate allowlist，future raw query/records 與合成 token 被過濾。
- Admin rebuild success；lock 已占用時 409 且不呼叫 rebuild；exception/0 verification fixed failure、lock finally 釋放、log/response 無 secret。
- Eval invalid list/empty/endpoint/長度 400；RAG unavailable 503。
- Eval 成功 response 遮罩 query/topic/snippet 並移除 source absolute path；provider exception fixed 500 且 audit 無 secret。
- 完整 228 tests 包含既有 AI Chat/trace/feedback/前端/evaluator 回歸，證明核心 RAG Chat 未受影響。

## 未完成／刻意未做

- 沒有修改 BM25/dense/rerank/router/KB 或 rebuild 底層演算法；endpoint 只做鎖與 post-condition 驗證。
- 現有部署是單一 Flask process/thread 模型；`threading.Lock` 可防目前程序內併發。若未來採多 worker／多機，需另以 Redis/DB advisory lock 升級，不能把本鎖誤稱 distributed lock。
- 底層 rebuild 不是 transaction；本任務確保 partial/failed 狀態不會被 endpoint 回成 success，但不重構索引引擎。
- 未新增後台 UI、未連 DB、未執行 migration、未開始 Task 07。
- 本輪未 commit/push；checkpoint `5b7f523` 已在 `origin/08/20`。

## 自我判定

- [x] Admin 只信任 server-verified app_metadata
- [x] 401/403 一致且 demo fail closed
- [x] Rebuild 有併發鎖、fixed failure 與 post-condition
- [x] Public stats 無敏感詳細資訊
- [x] Audit／response 不含 secret/query/raw exception
- [x] 未動 retrieval 演算法或核心流程
