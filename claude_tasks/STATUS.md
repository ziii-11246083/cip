# 分階段任務狀態

狀態值：

- Implementation：`PENDING` / `IN_PROGRESS` / `READY_FOR_CODEX_REVIEW` / `CHANGES_REQUESTED`
- Codex review：`PENDING` / `PASS` / `CHANGES_REQUESTED`

| Task | 主題 | Implementation | Codex review |
|---|---|---|---|
| 01 | RAG trace 資料契約與 migration | READY_FOR_CODEX_REVIEW | PASS |
| 02 | RAG trace service 與 AI Chat 接線 | READY_FOR_CODEX_REVIEW | PASS |
| 03 | 其餘 RAG endpoints 與 citation API | READY_FOR_CODEX_REVIEW | PASS |
| 04 | Citation UI 與使用者 feedback | READY_FOR_CODEX_REVIEW | PASS |
| 05A | RAG 評測資料契約、離線 runner 與 artifacts | READY_FOR_CODEX_REVIEW | CHANGES_REQUESTED |
| 05B | RAG baseline 比較與 regression gate | PENDING | PENDING |
| 06 | RAG 管理 endpoints 權限 | PENDING | PENDING |
| 07 | 詐騙檢測真實化與結構化證據 | PENDING | PENDING |
| 08 | 系統功能、UML、資料字典一致性 | PENDING | PENDING |
| 09 | 資產同步架構與資料模型（不接 provider） | PENDING | PENDING |
| 10 | 公開錢包地址唯讀同步 MVP | PENDING | PENDING |
| 11 | Paper Trading 情境壓力測試 | PENDING | PENDING |
| 12 | 商業數字、競品與 GitHub 複評證據 | PENDING | PENDING |

## 規則

- Claude Code 只能更新 `Implementation`。
- `Codex review` 只能由 Codex 審核後更新。
- 前一 Task 未 `PASS` 時，不得開始下一 Task；`05A` 與 `05B` 亦視為獨立審核閘門。
- 若某 Task 被判定 `CHANGES_REQUESTED`，只修該 Task 的審核意見，不得擴張範圍。
