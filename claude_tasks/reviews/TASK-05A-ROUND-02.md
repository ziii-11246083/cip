# TASK 05A — Codex 第二輪複審

審核結果：`PASS`

審核日期：2026-08-20

## 結論

第一輪四類 blocker 已關閉，可以進入 TASK 05B。修正維持在 evaluator、05A tests、README 與報告範圍，未修改 15 題原文／metadata、retrieval/rerank/router、production endpoint、資料庫或 Task 01–04。

## 已驗證修正

- P@K、Recall@K、NDCG@K 對每個 distinct expected topic 只在 retrieved 第一次出現時計 relevance；`[a,a,a]` 對 `[a]` 的 NDCG=1，不再大於 1。
- source_match 改成 basename/stem/case-fold 後精確比對的 0–1 ratio；`rules` 不命中 `not_rules_backup.md`，2 個 expected 命中 1 個為 0.5。
- endpoint/review_status 先驗型別；case_id 與 dataset_version 使用 1–64 字元 safe slug，且 sanitizer 必須 byte-stable。錯誤不回顯 unsafe/duplicate ID。
- retrieve、result shape、metadata、metric 與 public-field 清理位於同一 per-case boundary；缺 snippet 只使該題 failed，後續題目仍執行。
- method/route 與 source/topic/chunk 經既有 public sanitizer；合成 Bearer/API key 不進 artifact/stdout/stderr。
- missing cases、invalid clock、KB/RAG init exception 與 output write 都轉成固定安全 code、CLI non-zero，無 traceback/raw exception/絕對 input path。
- run-id 拒絕 traversal、absolute、slash/backslash、換行、`..` 與 token-like 值；`write_artifacts()` 自身驗證 resolved containment，並要求 argument run-id 與 artifact metadata run-id 相同。
- Git subprocess 固定 `cwd=PROJECT_ROOT`；從 repo 外 cwd 呼叫仍取得本 repo commit 與 dirty state。
- README 已還原「AI 教練回答安全性評估」20 題規劃與真實「目前狀態」。

## 獨立驗證證據

- `pytest tests/test_rag_eval.py -q`：39 passed。
- `pytest tests/ -q`：208 passed，11 個既有第三方 warning，無 failure。
- `python3 -m unittest tests.test_rag_trace_service`：70 tests OK。
- `python3 scripts/validate_rag_trace_migration.py`：70/70 PASS。
- `py_compile` 與 CRLF-aware `git diff --check`：PASS。
- 真實本地 KB smoke：15/15 completed、MRR 0.7222、NDCG@3/5 0.6734、source_match 0.8333；per-case NDCG/source_match 皆在 0–1。
- smoke provenance：commit `5b7f52351c92e75406e9d8296bf103b8364423ac`、dirty=true，符合目前工作樹狀態。

## 保留限制

- 15 題仍全為 pending_review／reviewer null，gold_answer 只是待審參考答案。
- 05A 沒有 LLM judge、answer accuracy、baseline approval/comparison 或 regression threshold。
- 未連 Supabase、未寫 `rag_eval_runs/rag_evaluations`、未執行 migration。
- `/private/tmp/cip-05a-smoke.y4gx0W` 是本輪真實 smoke 產物；自動刪除被工具安全規則拒絕，未重試。它不在 repo 或提交範圍。

## 閘門

- TASK 05A Codex review：`PASS`。
- 允許開始 TASK 05B；仍不得開始 TASK 06，直到 05B 通過複審。
