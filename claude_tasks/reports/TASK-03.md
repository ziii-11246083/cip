# TASK-03 實作報告（含 Codex 第一、二、三、四輪複審修正）

## 本次目標

沿用 Task 02 已過審的 trace service，把其餘四條真正使用 RAG 的後端路徑
（`/api/agent-plan`、`/api/scam-scan`、`/podcast/generate`（含 `/api/podcast/generate` alias）、
`/portfolio/analyze-llm`）接入同一 trace 契約；response 只增量加入
`trace_id`／`citations`／`confidence`；未接前端、未接非 RAG 路徑。

## Codex 第四輪唯一 blocker 修正：final cleaned key 必須對整個輸出 dict 唯一

### 問題

舊配置只計算「相同 base cleaned key」出現次數（`used.get(ck)+1 → ck#N`），未檢查
加上 `#N` 後的 final candidate 是否已被其他原始 key 占用。Codex 重現：nested dict
同時含 JWT A、JWT B（皆遮罩成 `<JWT>`）與原始 key `<JWT>#2` 時，JWT B 寫入的
`<JWT>#2` 覆蓋原始 `<JWT>#2` 的 value，3 筆只剩 2 筆。

修正前重現（新增測試）：`AssertionError: 3 != 5`（value-c 靜默遺失）。

### 修正（app.py `_trace_shrink()` dict key candidate 局部數行）

- 取得 base cleaned key 後，以 `while candidate in cleaned` 對 **final candidate** 檢查
  唯一性，依序嘗試 `base`、`base#2`、`base#3`…直到未使用（deterministic：
  迭代順序仍為 sorted 原始 key，後綴配置順序固定）。
- 移除舊的 base-count `used` 計數器；marker entry 配置、leaf-first sanitize、
  dict caps、list caps、排序與長度上限均未動。

### 唯一新增回歸測試（`TraceSnapshotKeyCollisionAllocatorTests`，1 項）

nested `portfolio_summary` 同時含：兩個不同 synthetic JWT keys（皆遮罩成 `<JWT>`）、
原始 key `<JWT>`、`<JWT>#2`、`<JWT>#3`。斷言：

- `json.loads` 成功、無 JWT 原文；
- **5 筆 input values 全數保留、數量一致**（修正前 3 != 5）；
- 輸出 keys 全部唯一；
- 相同輸入重跑 `sanitized_query` 與 `query_hash` byte-for-byte 相同。

## Codex 第三輪唯一 blocker 修正：sanitizer 只作用於 JSON value、大 nested dict 保留外層 keys

### 問題一：URL regex 吞掉 serialized JSON 語法

`_serialize()` 原先「先 `json.dumps` → 再對整段 JSON 執行 `_trace_sanitize`」；
URL regex `https?://[^\s一-鿿]+` 會吞掉 closing quote/comma/brace。
修正前重現（真實 Agent route、合成網址）：

```text
goal = "請分析 https://example.invalid/path?x=1"
→ HTTP 200，但 stored sanitized_query（長度 69，未達上限）
  json.loads() 失敗：Unterminated string（結尾 `"retrieval_query":"請分析 <URL>`）
```

### 問題二：3000-entry portfolio_summary 退化成 error envelope

修正前 dict 無 entry-count 縮減，大 nested dict 走到終極 fallback：
snapshot 只剩 `{"error":"snapshot_too_large","marker":…}`，`market`/`risk_level`/
`watchlist`/`events`/`portfolio_summary`/`retrieval_query` 全部消失（測試已重現）。

### 修正（僅 app.py 的 `_trace_shrink()`／`_trace_snapshot()`＋key helper）

- **leaf-first sanitize**：`_trace_shrink` 對每個 string value **先**執行 `_trace_sanitize`（巢狀 list/dict 遞迴處理），再做 leaf/list/dict 縮減；`json.dumps(sort_keys=True, separators=(",",":"))` 是最後一步——**不再對 serialized JSON 執行 sanitizer**。
- **nested dict key 清理**：新增 `_trace_clean_key()`（sanitize＋80 字截斷標記）；dict 以「sorted 原始 key」決定性迭代；清理後 key 碰撞時以固定後綴 `#2/#3` 區隔（collision-safe，不靜默覆蓋）。
- **dict entry-count 縮減**：新增 `_TRACE_DICT_CAPS=[200,50,10,2]` 收斂迴圈；被截斷 dict 附加固定 `…[truncated]` marker entry（marker key 碰撞時以 `#` 後綴避開）。
- 終極 fallback 僅保留給不可序列化型別等病態輸入；正常 JSON request 的長 string/list/dict 不會走到 envelope。
- 未超長且未含敏感內容的小 snapshot **byte-for-byte 不變**（`test_small_snapshot_byte_stable` 持續通過）；含 URL/PII 的 snapshot 修正後為合法、deterministic JSON。
- 未動 `services/rag_trace_service.py` 的全域 regex（review 明示不可動）；route business logic、API response、Task 01/02 均未變。

### 新增回歸測試（`TraceSnapshotSanitizeOrderTests`，4 項）

1. Agent goal 含 `https://example.invalid/path?x=1`：HTTP/response 不變、stored query `json.loads` 成功、URL 遮罩為 `<URL>`、goal/profile/budget/retrieval_query 保留（修正前 `JSONDecodeError: Unterminated string`）。
2. Scam text 與 Podcast events/portfolio_summary 的巢狀 value 含 URL/email：清理後合法 JSON、原文不出現。
3. 兩個相異 JWT 放在 nested dict key（遮罩後相同）：原文不洩漏、3 筆 value 全數保留（修正前 value-a 被靜默覆蓋）。
4. 3000-entry nested dict：`≤4000`、可 parse、含截斷標記、六個必要外層 keys 全保留（修正前為 error envelope）。

## Codex 第二輪唯一 blocker 修正：截斷後必須仍為合法 JSON

### 問題

`_trace_snapshot()` 原先以 `text[:max_len]` 直接切 serialized JSON，超過上限時 stored
`sanitized_query`／`answer` 不再是合法 JSON。修正前重現（新測試在舊實作下執行）：

- `test_long_agent_goal_query_valid_json`：`JSONDecodeError: Unterminated string starting at: line 1 column 24`。
- `test_long_answer_truncated_valid_json`：`JSONDecodeError: Unterminated string starting at: line 1 column 278`。
- `test_long_scam_text_query_valid_json`、`test_podcast_long_events_and_portfolio_summary`、
  `test_secrets_not_in_truncated_snapshot` 亦同型失敗（共 5 項 FAILED）。

### 修正（僅 app.py 的 `_trace_snapshot()`＋一個小 helper）

- 新增單一 JSON-aware 縮減 helper `_trace_shrink(value, leaf_budget, list_cap)`：
  - leaf 字串超過 budget → 截斷並附固定標記 `…[truncated]`；
  - list 超過 cap → 保留前 cap 項並於尾端附標記元素；
  - dict keys 一律保留；數字/布林原樣；遞迴處理。
- `_trace_snapshot()` 新流程：
  1. `json.dumps(sort_keys=True, separators=(",",":"))` → sanitize（不截斷）；
  2. 若 ≤ max_len → 直接回傳（**與舊實作 byte-for-byte 相同**，既有 query hash 不變，`test_small_snapshot_byte_stable` 驗證）；
  3. 超限 → leaf budget 依序 `200→100→50→20→10→5` 縮減重序列化，任一輪 ≤ max_len 即回傳；
  4. 仍超限 → list cap 依序 `200→50→10→2`（配合最小 leaf budget）縮減重序列化；
  5. 終極 fallback：`{"error":"snapshot_too_large","marker":"…[truncated]"}`（合法 JSON、固定代碼、無 exception text）。
- 不再對 serialized JSON 做字串切片；序列化失敗 fallback 亦為合法 JSON 固定代碼。
- 未加任何 API 輸入長度限制；四條 API 的 business response／HTTP status／trace metadata／RAG 行為不變。

### 新增回歸測試（`TraceSnapshotTruncationTests`，8 項）

- 5200 字 Agent goal：`sanitized_query ≤ 4000`、`json.loads` 成功、top-level keys 保留、含 `…[truncated]`。
- 6000 字 Scam text：同上（text/retrieval_query 保留）。
- Podcast 3000 項 events＋大 portfolio_summary：所有 top-level keys 保留、合法 JSON、含截斷標記。
- 9000 字 Agent answer：`answer ≤ 8000`、`json.loads` 成功、五個 business keys 保留、summary 含標記；
  **API response 的 summary 維持完整 9000 字（trace 截斷不影響 response）**。
- 相同長輸入兩次 → `sanitized_query` 與 `query_hash` deterministic。
- JWT／API key／64-hex 私鑰混入長 Scam text：原值不出現在 store payload、log、API response；
  前段 JWT 被遮罩為 `<JWT>`。
- 長 events 下 podcast response 欄位不變（title/lines 等）。
- 小 snapshot byte-for-byte 等於舊 deterministic 結果、無截斷標記。

## Codex 第一輪三類 blocker 修正

## Codex 第一輪三類 blocker 修正

### 1. `note_rag_error()` 留下固定 fallback_reason `rag_error` ✅

- `_ALLOWED_FALLBACK_CODES` 新增 `rag_error`；`_finish_inner` 在 metrics／`kb_unavailable`／`llm_unavailable` 都沒有更特定原因時才填入 `rag_error`（不覆蓋更特定代碼）。
- 反例測試（修正前重現 5 項 FAILED，復原後通過）：
  - service：`RagErrorCodeTests`（單獨 rag_error → `fallback_reason=rag_error`；`retrieval_error` 不被覆蓋）。
  - 端點：`RagExceptionCodeTests` 四 route 各一：HTTP／既有回答不變、`status=degraded`、`fallback=true`、`fallback_reason=="rag_error"`、合成 secret（`sk-fake-rag-secret`）不出現在 payload 與 API response。

### 2. Query／answer 保存「實際輸入」與「實際交付內容」 ✅

- 新增 `app._trace_snapshot(payload, max_len)`：deterministic JSON（`sort_keys=True`、`separators` 無空白）→ `sanitize_text` 遮罩 → 截斷。query snapshot ≤4000（契約上限）、answer snapshot ≤8000。
- 各 route query snapshot（= `sanitized_query`，HMAC 依此計算）：

| Route | query snapshot 欄位 |
|---|---|
| agent | `goal`、`profile`、`budget`、`retrieval_query`(=goal) |
| scam | `text`、`retrieval_query`(=text) |
| podcast | `market`、`risk_level`、`watchlist`、`events`、`portfolio_summary`（PERSONAL 且有值時）、`retrieval_query`(=market) |
| health | `holdings`、`metrics`（top1_weight/annual_vol/max_drawdown，實際提供給模型的指標）、`retrieval_query`（固定「配置風險波動集中度」） |

- 各 route answer snapshot = 該分支**實際回給使用者的完整 business response**（不含 trace_id/citations/confidence）：
  - agent：summary/steps/risks/next_action/allocation（含缺 key 與 LLM exception 的 fallback plan）
  - scam：risk_level/report（含缺 key 與「系統錯誤，請稍後再試。」分支）
  - podcast：title/bullets/script/estimated_seconds/lines（含 fallback podcast）
  - health：risk_health/narrative/highlights（含缺 key 與連線失敗分支）
  - **所有分支不再以空 answer 代表使用者收到的 fallback**。
- 反例測試（`SnapshotTests`，7 項）：
  - 相同 goal、不同 budget → `query_hash` 與 `sanitized_query` 皆不同。
  - agent/podcast/health snapshot 欄位逐一斷言（profile/budget/watchlist/events/holdings/metrics/retrieval_query）。
  - fallback 分支 answer JSON 與 API business response 逐欄相符（排除 trace metadata）。
  - podcast PERSONAL 的 events/portfolio_summary 放入合成 JWT 與 API key → 原文不出現在 store payload 與 API response，snapshot 中為 `<JWT>`／`<API_KEY>`。

### 3. `safe_citations()` 全部公開欄位防禦性清理 ✅

- 新增 `clean_public_field`（先遮罩保留字詞邊界 → 去控制字元 → 截斷）、`clean_citation_source`（basename）、`clean_chunk_id`（`path/to/file#rank` → `file#rank`，POSIX／Windows 皆處理）、`clean_public_label`（section/topic 的 path-like 值取 basename）。
- `safe_citations()` 維持 actually_injected-only；`chunk_id`／`source`／`section`／`topic` 全部清理後輸出；不影響 RAG 檢索、prompt 注入或 DB source rows。
- 反例測試：
  - service（`CitationSanitizerTests`，5 項）：POSIX path、Windows path、CR/LF/tab、JWT/API key 遮罩、正常欄位與順序保留。
  - 端點（`CitationEndpointSanitizerTests`，2 項）：`/srv/private/doc#1` → `doc#1`、`C:\private\section` → `section`；citation JSON 無目錄、控制字元與 secret。

## 修改檔案

| 檔案 | 修改目的 |
|---|---|
| `services/rag_trace_service.py` | 最小泛化：`start_run(endpoint, …)`（allowlist `{chat,agent,scam,podcast,health}`，未知 endpoint fail closed 回 None＋`trace_endpoint_rejected`）；`start_chat_run()` 保留並委派；`TraceRun` 帶 endpoint；`note_llm_unavailable()`；allowlist 新增 `llm_unavailable`／`llm_error`；`safe_citations()`＋`display_source()`（只含 injected、basename、無絕對路徑）；answer 上限 8000 |
| `services/rag_service.py` | `augment_agent`／`augment_scam`／`augment_podcast`／`augment_health` 增量回傳 `retrieval_results`＋`metrics_record`（與 Task 02 `augment_chat` 同型態；kb unavailable／retrieval exception 回固定代碼安全 metrics）；scam 另回傳 `citations`／`confidence`／`injected_count` |
| `services/prompt_builder.py` | `build_agent_prompt` 加入 `injected_count`（字數預算內實際注入數）；`build_podcast_prompt`／`build_health_prompt` 回傳 `injected_count = len(results)`（無預算截斷 → 全部注入） |
| `app.py` | 4 個共用小 helper（`_start_trace`／`_record_rag_for_trace`／`_finish_trace`／`_trace_meta`）＋四 route 最小接線；移除 3 處 provider exception 外洩（agent `debug=str(e)`、scam `系統錯誤: {str(e)}`、podcast `debug=OpenAI fallback: …`）；修復 agent prompt f-string 既有 bug（見下） |
| `tests/test_rag_endpoints_trace.py`（新增） | 27 個端點測試（四 endpoint × 成功/empty/store failure/exception/缺 key ＋ Auth/validation 邊界 ＋ metadata 不污染 ＋ citation 判定 ＋ podcast alias） |
| `tests/test_rag_trace_service.py` | 新增 6 個 service 級測試（allowlist fail-closed、endpoint 隔離、llm 代碼、safe_citations） |
| `claude_tasks/STATUS.md` | 僅 Task 03 Implementation 欄位 |

## 四條 route 的資料流

| Route | Auth | user_id | 查詢來源 | RAG 注入 | trace 起點 | LLM |
|---|---|---|---|---|---|---|
| `/api/agent-plan` | token_required | Auth UID（demo→NULL） | `goal` | `augment_agent(goal, profile, budget)` → context 注入 prompt | goal 驗證通過後 | `client.chat.completions.create`（OPENAI_MODEL_AGENT） |
| `/api/scam-scan` | 無（匿名） | NULL | `text` | `augment_scam(text)` → rag_snippets[:2] 注入 system prompt | text 非空後（在 client 檢查前） | `refresh_openai_client().beta…parse` |
| `/podcast/generate`＋`/api/podcast/generate` | 無（匿名） | NULL | `req.market` | `augment_podcast(req.market, …)` → context 注入 system_msg | pydantic 驗證通過後 | `refresh_openai_client().beta…parse` |
| `/portfolio/analyze-llm` | token_required | Auth UID（demo→NULL） | `holdings_text`（經遮罩） | `augment_health(rh_dict, holdings_text)` → context 注入 system prompt | pydantic 驗證通過後 | `client.beta…parse`（OPENAI_MODEL_PORTFOLIO） |

alias 與 canonical 共用同一個 handler（`api_generate_podcast_alias()` 直接呼叫 `generate_podcast()`）→ 一次 request 自然只產生一筆 trace（測試驗證兩路由各一筆）。

## endpoint / user / status 對照

| 情境 | status | error | fallback_reason |
|---|---|---|---|
| LLM 成功（含 RAG 成功） | `success` | — | — |
| RAG empty context / kb unavailable / retrieval·rewrite·router 降級 | `degraded` | — | `kb_unavailable`／`retrieval_error`／`rewrite_error`／`router_error` 等固定代碼 |
| LLM key/client 缺失（既有 fallback 回應） | `degraded` | — | `llm_unavailable` |
| LLM exception | `error` | `llm_error` | — |
| `abstained` | 未使用（五 endpoint 皆無 abstain 行為） | | |

status 只使用契約四值（success/degraded/abstained/error）；`partial`／`fallback` 皆轉為 degraded＋固定 fallback_reason，未寫入非法字串（`CrossEndpointTests` 有斷言）。

## citation 的 actually_injected 判定

- 注入判定來自 prompt builder 真實行為：`build_chat_prompt`／`build_agent_prompt` 在字數預算內逐筆 append 的結果計入 `injected_count`；podcast／health 無預算截斷 → 全部 retrieved 均 injected；scam 使用 `snippets[:2]` 且 `max_results=2` → 全部 injected。
- `TraceRun.record_rag` 以 `i < injected_count` 標記 `actually_injected`；`safe_citations()` **只**輸出 `actually_injected=True` 的來源。
- 對外 citation 只含安全欄位：`chunk_id`、`source`（`display_source()` 取 basename，`/server/abs/.../x.md` → `x.md`）、`section`、`topic`。無伺服器絕對路徑、無 raw provider metadata。
- Chat（Task 02）response 維持既有字串式 citations（已過審，未動）。

## 既有 bug 修復（透明揭露）

`git show HEAD:app.py` 證實：agent prompt f-string 的 JSON 範例 `{"symbol": "BTC", …}` 兩行的 `{` 未跳脫，runtime 必拋
`ValueError: Invalid format specifier` → `/api/agent-plan` 的 LLM 路徑在本 Task 前**永遠走 fallback**。
本次只把該兩行跳脫為 `{{…}}`（prompt 文字內容不變），使 LLM 成功路徑可達，否則無法滿足「正常成功」測試要求。此屬最小修復，非 prompt 重寫。

## 安全修正（provider exception 外洩移除）

- agent：`fallback["debug"] = str(e)` 移除。
- scam：`報告: f"系統錯誤: {str(e)}"` → 固定「系統錯誤，請稍後再試。」。
- podcast：`fallback["debug"] = f"OpenAI fallback: {type(e).__name__}"` 移除。
- 以上皆為 Task 03 明示允許的「移除 exception/token 外洩所必要的最小安全修正」；trace/log 仍只存固定代碼（`llm_error` 等）。

## 測試證據

| 指令 | 結果 | 備註 |
|---|---|---|
| `/tmp/cip-test-venv/bin/python -m pytest tests/ -q` | **150 passed**（第四輪修正後；原 149 項全數保留＋新增 1 項 collision allocator 反例） | venv Python 3.9.6、flask 3.1.3、pytest 8.4.2、supabase 2.30.0 |
| 第四輪修正前重現 | collision 測試 `AssertionError: 3 != 5`（value 靜默遺失） | 修正後通過 |
| `python3 -m unittest tests.test_rag_trace_service -v` | **70 tests OK**（系統 python 3.14） | 純 stdlib 核心 |
| `python3 -m unittest tests.test_trace_init_and_metrics_privacy` | 2 OK（1 skipped：無 flask） | |
| `/tmp/cip-test-venv/bin/python -m py_compile app.py tests/test_rag_endpoints_trace.py` | OK | 本輪修改 2 檔 |
| `python3 scripts/validate_rag_trace_migration.py` | PASS（70/70） | Task 01 契約未動 |
| `git -c core.whitespace=cr-at-eol diff --check` | 通過 | app.py 既有 CRLF 慣例；本輪新增行無真正 trailing space |
| 本輪修改檔 trailing whitespace | 皆 0 | |

### 每 endpoint 覆蓋矩陣（tests/test_rag_endpoints_trace.py，27 項）

| 測試類別 | agent | scam | podcast | health |
|---|---|---|---|---|
| 成功＋實際注入來源（status=success、sources≥1、citation 正確） | ✅ | ✅ | ✅（canonical 一筆） | ✅ |
| empty context / RAG unavailable（degraded） | ✅ | ✅ | ✅ | ✅ |
| trace primary/DB store failure 原 response 不變 | ✅ | ✅ | ✅ | ✅ |
| LLM exception 固定代碼（llm_error）且無 secret 外洩 | ✅ | ✅ | ✅ | ✅ |
| 缺 LLM key（degraded、llm_unavailable、既有 fallback 回應） | ✅ | ✅ | ✅ | ✅ |
| Auth/validation 拒絕不建立 trace | ✅（400/401） | ✅（空 text） | ✅（422） | ✅（422/401） |

- Auth UID：agent/health 用真實 UID（`USER_A`）；demo 會員 NULL。
- 匿名 scam/podcast：`user_id=None`。
- endpoint metadata 不污染：四連發後 `[(endpoint, user_id)]` 逐一正確。
- citations 只含 injected（injected_count=1/2 → 1 筆 citation）；無絕對路徑（`/server/…` → basename）。
- podcast canonical 與 alias 各自一次 request 只產生一筆 trace。
- RAG exception（含合成 token 的 raise）→ trace degraded、response 無 token。

## API response 相容性

- 各 endpoint 原有成功欄位全數保留：agent（summary/steps/risks/next_action/allocation）、scam（risk_level/report）、podcast（title/bullets/script/estimated_seconds/lines）、health（risk_health/narrative/highlights）；fallback 路徑欄位亦保留。
- 只增量新增 `trace_id`（32-hex）、`citations`（結構化 dict 列表）、`confidence`（prompt builder 既有字串，僅在有值時附上）。
- 移除的欄位僅為錯誤路徑的 `debug`（原為 exception 外洩）；HTTP status code 行為不變（agent 400、podcast/health 422、401 等）。
- scam 的驗證順序微調（text 空檢查移至 client 檢查前，兩者皆回 200＋`{risk_level, report}`；此為讓「已接受請求但缺 key」能建立 trace 的最小調整，於此揭露）。

## 誠實揭露

- **第四輪修正亦未連線任何資料庫、未執行 migration、未 commit、未 push**。
- 未接 `/portfolio/risk-health`、`/api/portfolio/analyze`、Podcast TTS、`/api/agent-auto-order`、模擬交易／會員資產流程。
- 未加入 GMGN／WHOIS／PTT 等外部掃描；未改前端；未開始 Task 04。
- DB 寫入路徑仍以 fake supabase module 驗證（Task 02 已過審之 store 未更動）。
- answer/query snapshot 是**應用層接線**產物，未改 DB schema、migration 或資料契約。

## 請 Codex 特別審核

1. query/answer snapshot 的欄位矩陣是否完整反映「模型看到什麼、使用者收到什麼」。
2. `rag_error` 的優先序（specific reason 優先）是否符合預期。
3. citation 清理規則（chunk_id 的 `basename#rank`、section/topic path-like 取 basename、先遮罩後去控制字元）的取捨。
4. answer snapshot ≤8000 的截斷是否可接受（契約 answer 欄位無長度上限，此為應用層自我限制）。
5. JSON-aware 縮減的 leaf budget（200→5）與 list cap（200→2）級距、截斷標記 `…[truncated]` 的選擇是否合理。
6. 縮減策略「先 leaf、後 list、再 dict entry-count、終極 fallback 固定代碼」是否足以涵蓋所有合法輸入。
7. leaf-first sanitize 後，既有 service sanitizer（Task 02 的 metrics 路徑、trace service 內部）仍各自獨立運作，未受本輪影響。

## 自我判定

- [x] 未超出 Task 範圍（第四輪僅 app.py `_trace_shrink()` 的 key candidate 局部數行＋1 個測試＋報告）
- [x] 未開始下一 Task（Task 04 未動）
- [x] 未執行 production migration、未連線正式 DB、未 commit、未 push
- [x] 未加入 secret／私鑰／助記詞（測試僅合成佔位字串）
- [x] 測試已實際執行（150/150；70/70；validator 70/70；修正前 3 != 5 重現 FAILED）
- [x] `STATUS.md` Implementation 已改為 `READY_FOR_CODEX_REVIEW`
