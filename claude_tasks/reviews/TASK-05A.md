# TASK 05A — Codex 第一輪審核

審核結果：`CHANGES_REQUESTED`

審核日期：2026-08-20

## 結論

主要方向正確：15 題原始內容未改、metadata 與 pending-review 契約已補齊；既有 evaluator 已收斂成離線 retrieval 評測，answer metrics 誠實標 unavailable，artifact 不自動覆寫，也未連 DB、未啟用 LLM judge 或開始 05B。

但 Codex 反例確認四類 blocker：normalized metric 可大於 1、loader/CLI 仍有 raw exception 與 secret 旁路、run-id 可將 artifact 寫出 output root、provenance 依啟動 cwd 而失真。這些會直接污染下一階段 baseline；TASK 05A 暫不 PASS，TASK 05B 繼續鎖定。

## 已接受、不需重做

- 15 題 query、endpoint、expected_topics、expected_sources、expected_keywords、gold_answer 與 HEAD 逐題相同。
- 15 個 case_id 唯一，dataset_version 統一，全部 `pending_review`／`reviewer: null`。
- answer metrics 一律 `unavailable/not_evaluated_in_task_05a`；移除 05A LLM judge 符合範圍。
- 每筆 case、overall、per-endpoint、latency 與 timestamped JSON/Markdown 的整體資料形狀可沿用。
- 完整 pytest `199 passed`、trace service unittest 70/70、py_compile、Task01 validator 70/70、diff check 均可重現。
- 報告的 199、30、15/15、MRR 0.7222 數字全文一致。

## 必修 1：Metric 必須有一致語意且 normalized 值不可超過 1

Codex 反例：

```python
ndcg_at_k(["a", "a", "a"], ["a"], 3)
```

目前回 `2.1309297535714578`。原因是 DCG 對同一 expected topic 的重複結果每個位置都算 relevant，但 IDCG 只按 expected unique topic 計一次。NDCG 不可大於 1，否則 regression gate 沒有可信尺度。

修正要求：

- P@K、Recall@K、NDCG@K 採一致的 topic-label relevance：每個 distinct expected topic 只在第一次 retrieved occurrence 貢獻一次 relevance；後續相同 topic 不得再次增加 hit/DCG。MRR 保持第一個 relevant rank。
- 所有 normalized metrics 必須保證在 `[0,1]`，但不可用 `min(value, 1)` 掩蓋公式錯誤。
- `source_match` 改為 `[0,1]` ratio：canonicalize expected source id 與 retrieved source basename/stem 後做精確比對；不得以任意 substring 判定，也不得用 raw count 讓不同 expected-source 數量的案例有不同上限。
- 反例必須通過：三個重複 `a` 對 expected `a` 時 NDCG≤1 且只算一次；`rules` 不得命中 `not_rules_backup.md`；2 個 expected source 命中 1 個時 score=0.5。
- README、summary/report 的 metric 定義同步更新。

## 必修 2：Loader、case processing 與 CLI 必須真的 fail closed

Codex 反例：

- `endpoint=[]`、`review_status=[]` 直接拋 raw `TypeError: cannot use 'list' as a set element`，不是固定 `EvalCaseError`。
- duplicate case_id 若是 `Bearer-sk-fake-case-id-DO-NOT-LOG`，secret 會原樣出現在錯誤訊息。
- retrieve_fn 回傳缺少 `snippet` 的結果時，後處理直接 `AttributeError`，整批中止且沒有 failed case artifact。
- cases 檔不存在直接拋含絕對路徑的 `FileNotFoundError`；非法 `--clock` 直接 raw `ValueError`。
- KB 初始化 exception 含合成 Bearer 時，`run_cli()` 直接把該 exception 向外拋出。

修正要求：

- 先驗證 endpoint/review_status 是 string，再做 allowlist membership；所有 JSON 合法但 schema 錯誤的輸入只回固定 code＋安全行號/field。
- case_id 必須先符合明確 safe slug regex 與長度上限，才可用於錯誤定位；未通過時錯誤訊息不可回顯原值。
- cases file 不存在／不可讀、clock 不合法、KB/RAG 初始化失敗皆轉成固定安全 code，CLI non-zero，不輸出 raw exception、secret、query 或絕對路徑。
- 每題的 retrieve、result shape parsing、metric 計算、source/topic/chunk 清理都必須位於同一個 per-case failure boundary；任一環節失敗都產生該 case 的固定 failed/error_code，不得中止其他 cases。
- `method`、`route` 等 artifact 字串也要使用 allowlist 或既有 public sanitizer，不得成為 raw provider/path/secret 旁路。
- 新增上述每個反例，並 capture stdout/stderr/artifact 驗證合成 secret 與 traceback 不存在。

初始化在任何 case 開始前失敗時，可選擇不建立 artifact，但必須固定 code＋non-zero；不得偽造 completed。若建立 artifact，必須是 `run_status=failed` 且 case counts/metrics 語意一致。

## 必修 3：Artifact path 必須被限制在 output root，Git provenance 必須指向本專案

Codex 反例：

```text
run_id = slot/../../escaped
```

目前會把 `results.json`／`summary.md` 寫到 output root 外層。

另從專案上一層以絕對 script path 執行時，本專案 HEAD 明明存在，但 `git_code_commit()` 回 `unavailable`、dirty 回 `None`；原因是 Git subprocess 沒有固定 `cwd`。

修正要求：

- `--run-id` 使用明確 safe slug regex 與合理長度上限，只允許字母、數字、`.`、`_`、`-`，禁止 slash、backslash、`..` 路徑語意、控制字元與空白。
- `write_artifacts()` 自身也要防禦，不可只依賴 argparse；resolve 後驗證 run_dir 確實位於 resolved output root 之下。
- traversal、絕對路徑、換行 run-id 必須 fixed-code fail closed，且 output root 外不得產生任何檔案。
- `git rev-parse` 與 `git status` 明確使用 `cwd=PROJECT_ROOT`（或等價注入）；從 repo 外啟動 evaluator 仍需記錄正式版本 repo 的 HEAD 與 dirty state。
- 加入「從另一個 cwd 執行」與 path traversal 回歸測試。

## 必修 4：還原與 05A 無關的 README 內容

`eval/README.md` 刪除了既有「AI 教練回答安全性評估」20 題規劃。此內容不是過期的「測試集尚未建立」一句，也不屬於 05A 的替換範圍。

修正要求：

- 還原既有「AI 教練回答安全性評估」段落。
- 「目前狀態」可改寫成 RAG 15 題 pending review 與其他資料集/回測仍待建立的真實狀態，但不可整段刪除而讓其他評估規劃消失。

## 允許修改範圍

- `scripts/eval_rag.py`
- `tests/test_rag_eval.py`
- `eval/README.md`
- `claude_tasks/reports/TASK-05A.md`
- `claude_tasks/STATUS.md` 的 05A Implementation 欄位

原 15 題 JSONL metadata 已接受，不應再修改。不得改 Task01–04、production endpoint、retrieval/rerank/router、知識庫、DB/migration，也不得開始 05B。

## 重新送審驗收

- NDCG duplicate 反例落在 `[0,1]` 且公式語意正確；source false-positive 不再命中且 source score 為 ratio。
- endpoint/review_status 錯型別、unsafe case_id、missing file、invalid clock、KB init secret、malformed result 都固定 code fail closed，無 raw exception/secret/path。
- run-id traversal 無法在 output root 外建立檔案；從 repo 外啟動仍得到正確本 repo commit/dirty。
- README 無關安全評估內容已還原。
- 原 199 tests 全保留，新增反例全通過；重跑 service 70、compile、validator 70/70、diff check。
- 報告更新 metric 語意、修正前反例、真實測試總數與未完成範圍；完成後停止，不開始 05B。
