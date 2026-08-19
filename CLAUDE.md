# Claude Code 專案執行入口

本專案採分階段、逐關審核流程。

## 每次收到實作要求時

1. 必須先完整閱讀：
   - `claude_tasks/00_READ_ME_FIRST.md`
   - `claude_tasks/STATUS.md`
   - 使用者本次指定的唯一 Task 檔案
2. 若使用者未指定 Task 編號，停止並請使用者指定，不可自行挑選或一次執行多個 Task。
3. 前一 Task 的 `Codex review` 未標示 `PASS` 時，不得開始下一 Task。
4. 完成當前 Task 後，依 `claude_tasks/REPORT_TEMPLATE.md` 產出報告並停止。
5. Claude Code 不得修改 `STATUS.md` 的 `Codex review` 欄位。

產品程式與資料的詳細限制，以 `claude_tasks/00_READ_ME_FIRST.md` 及當前 Task 為準。
