# TASK-05A 實作報告

## 本次目標

局部升級既有 `scripts/eval_rag.py`（唯一 evaluator）與現有 15 題資料：同一資料集可驗證、
可重複執行，每次留下不覆寫的本地 JSON＋Markdown 評測證據。不做 baseline 核准／比較、
不呼叫 LLM judge、不連 Supabase（留待 05B）。

## 修改檔案

| 檔案 | 修改目的 |
|---|---|
| `eval/rag_eval_cases.jsonl` | 15 題 query/endpoint/expected_*/gold_answer 原文內容**逐字未動**；僅補 `case_id`（case-001…case-015，隨題目物件走）、統一 `dataset_version`（`rag-eval-15-v1-2026-08-20`）、`review_status: "pending_review"`、`reviewer: null` |
| `scripts/eval_rag.py` | strict loader（fail closed）、deterministic metrics（沿用並補邊界語意）、run metadata（clock/run-id 可注入）、timestamped artifacts（不覆寫）、per-case failed/error_code、answer metrics 一律 unavailable、CLI non-zero on failure；**移除** `--faithfulness` 與 LLM judge 程式 |
| `eval/README.md` | 移除「測試集尚未建立」過期說法；改為 15 題全 pending_review；補 05A 執行指令、輸出路徑、metric 定義、unavailable 語意與「artifacts 未寫入 DB、不能單獨證明答案正確」聲明 |
| `eval/results/.gitkeep`（新增） | 空目錄保留（未提交任何實際結果檔） |
| `tests/test_rag_eval.py`（新增） | 39 個測試；第一輪 30 個全保留，新增 9 個 blocker 回歸測試，涵蓋 duplicate metric、source 精確比對、錯型別、unsafe ID、malformed result、provider 欄位遮罩、path traversal、artifact run-id 一致性、repo cwd、missing file、invalid clock 與 init secret |
| `claude_tasks/STATUS.md` | 僅 05A Implementation 欄位 |

## 15 題 metadata 變化（不含 query/answer 內容）

- 每題新增唯一穩定 `case_id`（case-001…case-015；ID 隨題目物件移動，重排不改變）。
- 全部使用同一 `dataset_version = "rag-eval-15-v1-2026-08-20"`。
- 全部 `review_status = "pending_review"`、`reviewer = null`（無任何真人審核證據）。
- `gold_answer` 保留欄位但視為「待審參考答案」：README 與 summary.md 均明示不得據此宣稱
  answer accuracy 已通過；未改標 verified、未新增題目、未虛構 reviewer、未放入 candidate 題。

## Loader fail-closed 規則（固定 code＋行號，無 raw exception／query／絕對路徑）

| 違規 | error code |
|---|---|
| 非 JSON object／parse 失敗 | `eval_case_invalid_json line N` |
| 缺必要欄位 | `eval_case_missing_field line N field F` |
| 型別錯誤（含 endpoint 不在 allowlist、expected_* 以字串冒充 list） | `eval_case_bad_type line N field F` |
| case_id 非 safe slug／含敏感 token-like 內容 | `eval_case_bad_type line N field case_id`（不回顯原值） |
| case_id 重複 | `eval_case_duplicate_id line N field case_id`（不回顯原值） |
| dataset_version 不一致（整批檢查，無行號） | `eval_case_version_mismatch N dataset_versions found` |
| review_status 非 allowlist 或非 pending_review／reviewer 非 null | `eval_case_bad_review_status` |
| expected_topics/sources/keywords 為空（不默默計好成績） | `eval_case_empty_expected` |
| K ≤ 0 或非整數 | `eval_invalid_k` |
| cases 不存在／不可讀 | `eval_cases_unavailable` |
| clock／run-id 不合法 | `eval_invalid_clock`／`eval_invalid_run_id` |
| KB/RAG 初始化失敗 | `eval_initialization_failed` |

## Metric 定義與邊界語意（deterministic，binary relevance）

| Metric | 定義 |
|---|---|
| Precision@K | top-K 中 distinct expected topic 的首次命中數 / K；K 恆為分母，後續重複 topic 不再計分 |
| Recall@K | top-K 中 distinct expected topic 的首次命中數 / distinct expected topics 數 |
| MRR | 1 / 第一個 relevant 的 rank；無 relevant → 0 |
| NDCG@K | DCG=Σ rel_i/log2(i+2)；每個 distinct expected topic 只在首次命中 relevant，以理想排序正規化，保證 0–1 |
| source match | expected/retrieved source basename 去最後副檔名、case-fold 後精確比對；distinct expected source 命中比例，範圍 0–1 |
| keyword match | expected_keywords 於片段串接文字 case-insensitive 子字串命中比例 |
| latency | count/avg/p50/p95/p99；0 筆 → 各項 `unavailable`（不以 0 冒充） |

- 非法 K → `ValueError`／loader 拒絕；空 expected → `ValueError`（loader 已擋，metric 層再防禦）。
- 每題結果：case_id、endpoint、dataset_version、review_status、retrieval_status
  （completed/failed）、error_code（固定或 null）、metrics、latency、retrieved 安全欄位
  （source 取 basename、topic 經 public-label 清理、chunk_id 經 `basename#rank` 清理）、
  method、route；answer_metrics（faithfulness/answer_relevance/citation_correctness）
  一律 `unavailable`＋reason `not_evaluated_in_task_05a`。

## Artifact schema 與 status 規則

- 每次執行建立 `eval/results/<UTC timestamp>-<run_id>/`（預設；`--output-root` 可改）；
  已存在 → `eval_output_exists` fail closed，不覆寫任何既有證據。
- run-id 只接受 1–64 字元安全 slug（英數開頭，後續僅英數／`.`／`_`／`-`），拒絕 `..`、slash、backslash、空白、控制字元與 token-like 值；`write_artifacts()` 自身再做 resolved containment，不能寫出 output root。
- `results.json`：`metadata`（run_id、dataset_version、case_count、k_values、model
  {generation_model:"not_used"、embedding_model}、config fingerprint、kb_version、
  index_version:"unavailable"、code commit/dirty、started_at/ended_at、run_status）、
  `case_counts`、`overall`、`per_endpoint`、`per_case`。
- `summary.md`：與 JSON 同一 run_id；overall/per-endpoint（含 sample_count）、
  unavailable 語意、pending-review 聲明。
- run_status：`completed`／`completed_with_failures`（有 case failed 時 CLI exit 1，artifact 仍留下）。
- git 不可用或無 commit → `unavailable`；工作樹有修改 → `dirty: true`；
  KB/index/config 無可靠版本來源 → `unavailable`，不捏造版本。
- sample_count = 實際納入 metric 計算的 completed 樣本數；0 筆時 metrics 為 `unavailable`。

## 測試證據（第一輪修正後：test_rag_eval 共 39 項，完整 pytest 共 208 項）

| 指令 | 結果 |
|---|---|
| `/tmp/cip-test-venv/bin/python -m pytest tests/ -q` | **208 passed**（第一輪 199 全數保留＋新增 9 個 blocker tests） |
| `/tmp/cip-test-venv/bin/python -m pytest tests/test_rag_eval.py -q` | **39 passed** |
| `python3 -m unittest tests.test_rag_trace_service -v` | **70 tests OK**（系統 python 3.14） |
| `/tmp/cip-test-venv/bin/python -m py_compile scripts/eval_rag.py tests/test_rag_eval.py` | OK |
| `python3 scripts/validate_rag_trace_migration.py` | PASS（70/70） |
| `git -c core.whitespace=cr-at-eol diff --check` | 通過 |
| 修改檔 trailing whitespace | 4 檔皆 0 |
| 真實 CLI smoke（真實 KB、輸出至 `/private/tmp`） | 15/15 completed、run_status=completed、MRR 0.7222、NDCG@3/5 0.6734、source_match 0.8333；per-case normalized metrics 皆 0–1；commit `5b7f523...`、dirty=true；results/summary 有效 |

### 39 項測試覆蓋

- **資料集（9 項）**：15 題解析＋id 唯一＋版本一致＋全 pending/null reviewer；malformed JSON、
  缺欄位、expected_topics 以字串冒充、重複 id、混合版本、假 reviewer、approved status、
  空 expected_topics 皆 fail closed；錯誤訊息不含 query／絕對路徑。
- **Metrics（10 項，期望值手算）**：P@K 命中/未中、P@K 結果數<K、Recall、MRR rank、
  NDCG 公式值、duplicate distinct-topic-once、空 retrieved 全 0、非法 K（0/-1）、空 expected、
  keyword overlap、source exact-match ratio（含 substring false-positive 反例）。
- **eval_cases／aggregate（5 項）**：成功路徑 metrics 與安全欄位（source basename、無絕對路徑）、
  answer_metrics unavailable；retrieval exception 標 failed 不略過（error_code 固定、
  合成 token 不出現在任何輸出、aggregate 只計 completed）；全失敗 latency unavailable；
  latency 統計；非法 K 拒絕。
- **Artifacts（2 項）**：不覆寫（同 clock/run-id fail closed、不同 run-id 新目錄）；
  JSON/MD run_id 與主要數值一致。
- **CLI（2 項）**：case 失敗 → exit 1 且 artifact 留下、summary/results 無合成 token；
  loader 失敗 → exit 1 且不建立 run 目錄。
- **第一輪新增 blocker 反例（9 項）**：endpoint/review_status 錯型別；unsafe/duplicate case_id 不回顯；
  malformed result 只標該題 failed 且後題繼續；method/route 遮罩；run-id traversal/absolute/newline/backslash；
  artifact/argument run-id 不一致時寫入前拒絕；repo 外 cwd provenance；missing cases/invalid clock 固定 code；KB init secret 不出現在 stdout/stderr。

## 誠實揭露

- 未連線任何資料庫、未執行 migration；未寫 `rag_eval_runs`／`rag_evaluations`。TASK 01–05A
  第一輪前 checkpoint 已依使用者指示 push 到 `origin/08/20`（`5b7f523`）；本輪修正尚未另行 commit/push。
- 未呼叫任何 LLM judge、未讀取或要求 API key（answer metrics 一律 unavailable）。
- 未做 baseline 核准／比較／regression threshold（Task 05B）。
- 15 題尚未經人工審核（pending_review、reviewer null）；`gold_answer` 僅為待審參考答案。
- 未修改 Task 01–04 已通過內容、retrieval/rerank/router、知識庫內容、任何 production endpoint。
- 未開始 TASK 05B。

## 請 Codex 特別審核

1. duplicate topic 的 P/Recall/NDCG 只計首次命中，normalized metrics 與 source ratio 是否全程維持 0–1。
2. per-case boundary 是否完整涵蓋 result shape、metric 與 public-field 清理，且 fixed code 不洩漏 exception。
3. run-id safe slug、resolved containment 與 `cwd=PROJECT_ROOT` provenance 是否關閉 traversal/cwd blocker。
4. 還原 AI 教練 20 題安全評估與目前狀態後，README 是否同時保留 05A 真實進度。

## 自我判定

- [x] 未超出 Task 範圍（僅允許檔案；未動 Task 01–04、未動 retrieval/endpoint）
- [x] 未開始下一 Task（05B 未動）
- [x] 未連正式 DB、未執行 migration；本輪修正未另行 commit/push
- [x] 未呼叫 LLM judge、未讀取 API key
- [x] 測試已實際執行（05A 39／完整 208／unittest 70／validator 70/70／真實 KB smoke 15/15）
- [x] `STATUS.md` 05A Implementation 已改為 `READY_FOR_CODEX_REVIEW`
