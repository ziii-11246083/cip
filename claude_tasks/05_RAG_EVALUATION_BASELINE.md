# TASK 05 — RAG Baseline、評測紀錄與 Regression Gate（總覽，不可直接執行）

> 為避免一次變更過大，本 Task 已拆為 `05A_RAG_EVAL_DATASET_RUNNER.md` 與
> `05B_RAG_BASELINE_REGRESSION.md`。Claude Code 每次只能執行其中一份，不能直接把本總覽全部做完。

## 依賴

- Task 04 的 Codex review 必須為 `PASS` 才能開始 05A。
- Task 05A 的 Codex review 必須為 `PASS` 才能開始 05B。

## 本次唯一目標

讓現有 15 題評測可重複執行、保存結果、比較 baseline。不得捏造更多「已人工驗證」資料。

## 實作要求

- 為現有 cases 補穩定 case_id、dataset_version、expected source/topic、review_status、reviewer nullable。
- 現有題目若未有人確認，標為 `pending_review`；不可自行填虛構 reviewer。
- 評測輸出 timestamped JSON 與 Markdown summary，包含：
  - Precision@K、Recall@K、MRR、NDCG
  - source/keyword match
  - latency distribution
  - faithfulness、answer relevance、citation correctness 的 available/unavailable 狀態
  - overall 與 per-endpoint
- 保存 model/config/kb/index/code commit 資訊；無 Git commit 時明確標示 dirty/unavailable。
- baseline 只能由明確 CLI 參數核准，不能每次自動覆寫。
- regression threshold 可設定；超過退步門檻需 exit non-zero。
- LLM judge 可選，但結果必須標 evaluator/model/version；沒有 Key 時不能偽造通過。
- 可產生候選題，但只能放在 candidate/pending_review 檔，不列入正式 baseline。

## 測試最低要求

- deterministic metric 單元測試。
- baseline 建立、比較、退步失敗、缺 baseline、缺 Key。
- 不覆寫舊結果。
- 15 題檔案解析與 case_id 唯一。

## 不可做

- 不宣稱達到任意百分比，除非有實際輸出證據。
- 不用同一個模型的自評當唯一正確性證據。
- 不改 production endpoint。

## 驗收

05A 先回答「哪一版、哪組題、哪些指標」；05B 再回答「比核准 baseline 好或差多少」。每一小階段完成後都必須停止等待 Codex。
