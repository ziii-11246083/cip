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

詳細實作與測試規格應在 05A PASS 後由 Codex依實際 artifact schema再補充。未收到 05B 明確啟動 prompt 前不得開始。
