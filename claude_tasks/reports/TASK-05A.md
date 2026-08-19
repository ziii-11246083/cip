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
| `tests/test_rag_eval.py`（新增） | 30 個測試（loader fail-closed 9、metric 手算 10、eval_cases/aggregate 5、artifacts 2、CLI 2、15 題 metadata 1、錯誤訊息安全 1） |
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
| case_id 重複 | `eval_case_duplicate_id line N case_id X` |
| dataset_version 不一致（整批檢查，無行號） | `eval_case_version_mismatch N dataset_versions found` |
| review_status 非 allowlist 或非 pending_review／reviewer 非 null | `eval_case_bad_review_status` |
| expected_topics/sources/keywords 為空（不默默計好成績） | `eval_case_empty_expected` |
| K ≤ 0 或非整數 | `eval_invalid_k` |

## Metric 定義與邊界語意（deterministic，binary relevance）

| Metric | 定義 |
|---|---|
| Precision@K | \|top-K ∩ expected\| / K；K 恆為分母（結果數 < K 亦然）；retrieved 重複項以位置各計一次 |
| Recall@K | \|expected（去重）∩ top-K\| / \|expected（去重）\| |
| MRR | 1 / 第一個 relevant 的 rank；無 relevant → 0 |
| NDCG@K | DCG=Σ rel_i/log2(i+2)，以理想排序（expected 全中在前）正規化 |
| source match | expected_sources 中「為任一 retrieved source 子字串」的筆數 |
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

## 測試證據（數量全文一致：本輪新增 30 項，完整 pytest 共 199 項）

| 指令 | 結果 |
|---|---|
| `/tmp/cip-test-venv/bin/python -m pytest tests/ -q` | **199 passed**（既有 169 全數保留＋新增 30 項 test_rag_eval） |
| `/tmp/cip-test-venv/bin/python -m pytest tests/test_rag_eval.py -q` | **30 passed** |
| `python3 -m unittest tests.test_rag_trace_service -v` | **70 tests OK**（系統 python 3.14） |
| `/tmp/cip-test-venv/bin/python -m py_compile scripts/eval_rag.py tests/test_rag_eval.py` | OK |
| `python3 scripts/validate_rag_trace_migration.py` | PASS（70/70） |
| `git -c core.whitespace=cr-at-eol diff --check` | 通過 |
| 修改檔 trailing whitespace | 4 檔皆 0 |
| 真實 CLI smoke（真實 KB、輸出至 /tmp、事後清除） | 15/15 completed、run_status=completed、MRR 0.7222（sample 15）、results.json/summary.md 有效、answer metrics unavailable |

### 新增 30 項測試覆蓋

- **資料集（9 項）**：15 題解析＋id 唯一＋版本一致＋全 pending/null reviewer；malformed JSON、
  缺欄位、expected_topics 以字串冒充、重複 id、混合版本、假 reviewer、approved status、
  空 expected_topics 皆 fail closed；錯誤訊息不含 query／絕對路徑。
- **Metrics（10 項，期望值手算）**：P@K 命中/未中、P@K 結果數<K、Recall、MRR rank、
  NDCG 公式值、duplicate 以位置計、空 retrieved 全 0、非法 K（0/-1）、空 expected、
  keyword overlap、source match。
- **eval_cases／aggregate（5 項）**：成功路徑 metrics 與安全欄位（source basename、無絕對路徑）、
  answer_metrics unavailable；retrieval exception 標 failed 不略過（error_code 固定、
  合成 token 不出現在任何輸出、aggregate 只計 completed）；全失敗 latency unavailable；
  latency 統計；非法 K 拒絕。
- **Artifacts（2 項）**：不覆寫（同 clock/run-id fail closed、不同 run-id 新目錄）；
  JSON/MD run_id 與主要數值一致。
- **CLI（2 項）**：case 失敗 → exit 1 且 artifact 留下、summary/results 無合成 token；
  loader 失敗 → exit 1 且不建立 run 目錄。

## 誠實揭露

- 未連線任何資料庫、未執行 migration、未 commit、未 push；未寫 `rag_eval_runs`／
  `rag_evaluations`。
- 未呼叫任何 LLM judge、未讀取或要求 API key（answer metrics 一律 unavailable）。
- 未做 baseline 核准／比較／regression threshold（Task 05B）。
- 15 題尚未經人工審核（pending_review、reviewer null）；`gold_answer` 僅為待審參考答案。
- 未修改 Task 01–04 已通過內容、retrieval/rerank/router、知識庫內容、任何 production endpoint。
- 未開始 TASK 05B。

## 請 Codex 特別審核

1. recall 以「expected 去重」計命中、precision 以位置重複各計一次的語意是否符合評測慣例。
2. version-mismatch 錯誤無行號（整批檢查）是否符合「固定 code＋定位資訊」要求。
3. `scripts/eval_rag.py` 從 `services.rag_trace_service` 匯入安全清理函式的耦合是否可接受。
4. 移除 `--faithfulness`／LLM judge 是否為 05A 正確的範圍收斂（05B 可再加回）。

## 自我判定

- [x] 未超出 Task 範圍（僅允許檔案；未動 Task 01–04、未動 retrieval/endpoint）
- [x] 未開始下一 Task（05B 未動）
- [x] 未連正式 DB、未執行 migration、未 commit、未 push
- [x] 未呼叫 LLM judge、未讀取 API key
- [x] 測試已實際執行（新增 30／完整 199／unittest 70／validator 70/70）
- [x] `STATUS.md` 05A Implementation 已改為 `READY_FOR_CODEX_REVIEW`
