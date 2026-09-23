# TASK 05A — RAG 評測資料契約、離線 Runner 與 Artifacts

## 依賴

- Task 04 的 Codex review 必須為 `PASS`。

## 本次唯一目標

局部升級既有 `scripts/eval_rag.py` 與現有 15 題資料，使同一份資料集能被驗證、重複執行，並且每次留下不覆寫的本地 JSON 與 Markdown 評測證據。

本階段**不做 baseline 核准／比較、不做 regression threshold、不呼叫 LLM judge、不連 Supabase**。上述功能留到 Task 05B。

## 開始前必讀

1. `claude_tasks/00_READ_ME_FIRST.md`
2. `claude_tasks/STATUS.md`
3. 本檔案
4. `docs/RAG_TRACE_DATA_CONTRACT.md` 的 `rag_evaluations`、`rag_eval_runs` 與「LLM judge 不是唯一真相」段落
5. `eval/rag_eval_cases.jsonl`
6. `scripts/eval_rag.py`
7. `eval/README.md`

先用 5–10 行回報：現有 evaluator 可保留哪些函式、預計修改檔案、測試方式；確認只做 05A 才開始。

## 允許修改範圍

- `eval/rag_eval_cases.jsonl`
- `eval/README.md`
- `scripts/eval_rag.py`
- Task 05A 專用 tests（建議 `tests/test_rag_eval.py`）
- 必要時新增 `eval/results/.gitkeep` 或等價的空目錄保留方式；不得提交實際執行產生的大量結果檔，除非是很小的測試 fixture
- `claude_tasks/reports/TASK-05A.md`
- `claude_tasks/STATUS.md` 的 **05A Implementation** 欄位

若認為需要修改其他檔案，先停止並說明，不得自行擴張。

## 1. 15 題資料契約

保留現有 15 題的 query、endpoint、expected topics/sources/keywords 與原參考答案內容，只做可追溯 metadata 補齊：

- 每題新增唯一且穩定的 `case_id`；重排或重跑不可改變 ID。
- 每題新增同一個明確 `dataset_version`。
- 每題新增 `review_status: "pending_review"`。
- 每題新增 `reviewer: null`。
- 現有 `gold_answer` 在沒有真人審核證據前只能視為「待審參考答案」，不可改標 verified、不可拿它宣稱 answer accuracy 已通過；可保留欄位以避免不必要相容性改動，但 README 與輸出 metadata 必須說清楚。
- 不新增虛構題目、不虛構 reviewer、不把 candidate 放入正式 15 題。

loader 必須 fail closed 驗證：

- JSONL 每行為 object。
- 必要欄位、型別與允許 endpoint 正確。
- `case_id` 唯一且非空，所有正式 cases 的 `dataset_version` 一致。
- `review_status` 只接受明確 allowlist；本批沒有真人證據，15 題均應為 `pending_review` 且 reviewer 為 null。
- `expected_topics`、`expected_sources`、`expected_keywords` 為 string list，不能以字串冒充 list。
- 無 expected topic/source 的案例不得被默默計成好成績；若未定義正式 no-answer schema，直接 validation error。
- 錯誤訊息只能使用固定安全 code 加 case_id/行號等非敏感定位資訊，不輸出 raw exception、token、完整 query 或本機絕對路徑。

## 2. 局部升級現有 evaluator

- 必須沿用／整理現有 `scripts/eval_rag.py`，不得另建第二套互相競爭的 evaluator。
- retrieval 仍走既有本地 RAG/KB 讀取路徑；不得改 BM25、dense、rerank、router 或 production endpoint。
- 明確定義並實作 deterministic：Precision@K、Recall@K、MRR、NDCG@K、source match、keyword match。
- 每筆結果至少保存：case_id、endpoint、dataset_version、review_status、retrieval status、安全固定 error code、retrieved source/topic/chunk 的必要安全欄位、各項 metric、latency。
- 任何 case retrieval exception 都不能被 `continue` 靜默略過；結果要標 failed/unavailable，整次 run 必須能看出 completed/failed case 數。若有 case 執行失敗，CLI 最後 exit non-zero，但仍可留下標示失敗的 artifact 供除錯。
- latency 需提供 count、avg、p50、p95、p99；0 筆時標 unavailable，不可用 0 冒充實測延遲。
- 輸出 overall 與 per-endpoint aggregates；樣本數必須一起顯示，避免小樣本百分比誤導。
- faithfulness、answer relevance、citation correctness 在 05A 一律輸出 `unavailable` 與固定 reason（例如 `not_evaluated_in_task_05a`），不得填 0、1 或假 pass。

## 3. Run metadata 與本地 artifacts

每次執行預設建立新的 timestamp/run-id 目錄，例如：

`eval/results/<UTC timestamp>-<run_id>/`

至少產出：

- `results.json`：完整 machine-readable 結果。
- `summary.md`：人可讀摘要、overall/per-endpoint、資料與版本資訊、available/unavailable 說明。

要求：

- 不覆寫任何既有結果；目標目錄已存在時 fail closed。
- JSON 與 Markdown 指向同一 run_id。
- metadata 至少含 dataset_version、case count、K values、model、config、KB、index、code commit、dirty state、開始／結束時間與 run status。
- retrieval-only 的 model 應如實標 `not_used` 或 unavailable；不能暗示有跑生成模型。
- Git 不可用或無 commit 時標 `unavailable`；工作樹有修改時明確 `dirty: true`。
- KB/index/config 尚無可靠版本來源時標 unavailable，不得捏造版本。
- artifact 只存經既有 public/safe 規則清理的來源識別，不得輸出 secret、絕對路徑、raw exception。
- 可接受注入 clock/run-id/output root 以利 deterministic tests；不要為測試硬編 production 值。

## 4. README 同步

更新 `eval/README.md`：

- 移除「RAG 測試集尚未建立」這個過期說法，改成已有 15 題但全部 pending human review。
- 寫出 05A 執行指令、輸出路徑、metric 定義、限制與 unavailable 語意。
- 明確說明本地 artifacts 尚未寫入 `rag_eval_runs/rag_evaluations`，也不能單獨證明答案正確。

## 測試最低要求

- 15 題解析成功、case_id 唯一、dataset_version 一致、全部 pending_review/reviewer null。
- malformed JSON、缺欄位、錯型別、重複 case_id、混合 dataset_version、假 reviewer／非法 review_status 均 fail closed。
- deterministic metric 單元測試涵蓋：命中、未命中、排序、duplicate、K 大於結果數、空輸入與非法 K；期望值必須手算可核對。
- overall/per-endpoint aggregate 與 sample count 正確。
- retrieval exception 不被略過，artifact 標 failed/unavailable 且 CLI non-zero；log/report 不含合成 token 或 raw exception。
- timestamped artifacts 不覆寫；同 clock/run-id collision 要 fail closed。
- JSON/Markdown run_id 與主要數值一致。
- answer metrics 在 05A 只能是 unavailable。
- 執行完整既有 pytest、Task 01 validator、py_compile、`git diff --check`，不得只跑新增 tests。

## 明確不可做

- 不實作 baseline approval、baseline comparison、regression threshold；這是 Task 05B。
- 不啟用或呼叫 OpenAI／其他 LLM judge，不需要 API key。
- 不連 Supabase、不寫 `rag_eval_runs`／`rag_evaluations`、不執行 migration。
- 不修改 `/api/rag/eval`、`/api/rag/stats`、`/api/rag/rebuild-index` 或任何 production endpoint；管理權限是 Task 06。
- 不改 retrieval/rerank 演算法，不以「提高測試分數」為理由改知識庫或正式題目預期值。
- 不改 Task 01–04 已通過內容，不碰 Auth、AI Chat、交易、儲值、任務、排程、會員與 Podcast 核心流程。
- 不 commit、不 push、不開始 Task 05B。

## 完成與報告

完成後建立 `claude_tasks/reports/TASK-05A.md`，列出：

- 15 題 metadata 變化（不得貼全部 query/answer）。
- metric 明確定義與邊界語意。
- artifact schema、範例路徑、status/unavailable 規則。
- 實際測試指令、數量與結果。
- 誠實揭露未連 DB、未跑 LLM judge、未核准 baseline、15 題尚未人工驗證。

將 `STATUS.md` 的 05A Implementation 改為 `READY_FOR_CODEX_REVIEW`，Codex review 保持 `PENDING`，然後立即停止。

## 驗收標準

Codex 能只靠 artifact 回答：「這是哪個 dataset version、哪 15 題、用哪個 code/config/KB/index、跑了哪些 deterministic retrieval metrics、哪些 answer metrics 尚不可用、是否有 case 失敗」，且重跑不覆寫舊證據。
