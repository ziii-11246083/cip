# TASK 05B — RAG Baseline 比較與 Regression Gate

## 依賴

- Task 05A 的 Codex review 必須為 `PASS`。

## 本次唯一目標

在已通過審核的 05A artifacts 與 evaluator 上，加入明確 baseline 核准、相容版本比較與可設定 regression gate；不得回頭改資料集答案或 retrieval 演算法來追分。

## 範圍摘要

- baseline 只能由明確 CLI flag 核准，預設執行永不改 baseline。
- 核准與比較不得覆寫歷史 artifact；baseline 應是不可變 artifact 的 pointer/manifest。
- 只比較相同 dataset_version、case set、K values 與相容 config；不相容時固定錯誤並 non-zero，不顯示誤導 delta。
- threshold 可設定，退步超過門檻 exit non-zero；改善、持平、退步與 unavailable 要明確區分。
- LLM judge 若保留，只能由明確 flag 啟用並記錄 evaluator/model/version；缺 key 或 judge failure 標 unavailable，不能偽造 pass。測試不得發真實外部請求。
- candidate 題若產生，只能進獨立 pending_review 檔，不得自動加入正式 baseline。
- 不連正式 Supabase、不執行 migration、不改 production endpoint；是否將 artifacts 寫入評測資料表要另立任務與隔離 DB integration gate。

## Codex 依 05A PASS artifact 補充規格（2026-08-20）

### 允許修改範圍

- `scripts/eval_rag.py`（沿用唯一 evaluator，不另建第二套 runner）
- `tests/test_rag_eval.py`
- `eval/README.md`
- `eval/baselines/.gitkeep`（只保留空目錄；不代替使用者核准真實 baseline）
- `claude_tasks/reports/TASK-05B.md`
- `claude_tasks/STATUS.md` 的 05B Implementation 欄位

不得改 15 題 JSONL、retrieval/rerank/router/KB、production endpoint、Task 01–05A 已通過語意。

### Baseline manifest v1

- CLI 只有收到 `--approve-baseline --baseline-name <safe-slug>` 才能建立 baseline；預設執行不得寫 baseline。
- baseline manifest 為 `<baseline-root>/<baseline-name>.json`，以 exclusive create 建立；存在即固定錯誤，不得覆寫。
- 核准來源必須是本次 `run_status=completed`、0 failed、Git commit available、`dirty=false` 的 05A artifact；否則拒絕。這代表目前未 commit 的工作樹只能測試功能，不能偷核准正式 baseline。
- manifest 至少保存 schema/version、baseline id、approved_at、artifact_ref、artifact SHA-256、dataset_version、排序後 case_ids、K values、metric schema、config fingerprint、run/code/KB/index/model provenance、overall/per-endpoint 指標快照。
- artifact_ref 必須 resolve 後位於 project root；不接受 traversal、絕對 ref 或外部 artifact。

### 相容性與比較

- 使用 `--baseline <manifest>` 才比較；缺檔、壞 JSON、schema 錯誤、hash/pointer 不一致均固定 code＋non-zero，不輸出 raw path/exception。
- 必須完全相同：dataset_version、排序後 case_ids、K values、metric schema version、config fingerprint。任一不同即 `eval_baseline_incompatible`，不計 delta。
- code commit、dirty、KB/index/model 必須顯示於 provenance，但不當作相容性鍵；其差異正是 regression run 需要觀察的候選變更。
- 比較 overall 的 `P@K`、`Recall@K`、`NDCG@K`、`MRR`、`keyword_overlap`、`source_match` 與 `latency.avg_ms`。
- 高者較好的品質 metric：`delta=current-baseline`、`degradation=max(0, baseline-current)`；latency 相反，`delta=current-baseline`、`degradation=max(0, current-baseline)`。
- 每項狀態明確為 improved/stable/regressed/unavailable；不得把 unavailable 當 0。

### Regression threshold

- CLI 以可重複 `--threshold METRIC=VALUE` 設定「允許最大絕對退步量」；VALUE 必須 finite 且 ≥0，metric 必須在本 run allowlist。
- degradation `>` threshold 才 gate fail；等於 threshold 通過。baseline/current 一邊 numeric、一邊 unavailable 時，有設定 threshold 的該 metric 必須 fail closed。
- gate failure、baseline 不相容或 baseline 錯誤皆 exit non-zero；仍要讓成功完成的 retrieval run 留下 artifact。比較結果在首次寫入 `results.json`/`summary.md` 時一併保存，不事後覆寫。

### 測試與完成

- 測試 explicit approval、預設不寫、immutable collision、dirty/failed/unavailable commit 拒絕、manifest hash/pointer、缺/壞 baseline、四種 incompatibility、improved/stable/regressed/unavailable、品質與 latency 方向、threshold 邊界、gate non-zero、secret/path 不洩漏。
- 重跑完整 pytest、trace service unittest、py_compile、Task 01 validator、CRLF-aware diff check；不連 DB、不執行 migration、不發外部請求。
- 建立 `TASK-05B.md` 報告後只把 Implementation 設 `READY_FOR_CODEX_REVIEW`；Codex review 通過前不得開始 06。
