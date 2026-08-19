# Claude Code 分階段執行規則

## 目的

本目錄把評審改善工作拆成小型、可審核的任務。每次只允許執行一個 Task，避免一次修改過多而偏離方向。

## 每次開始前必做

1. 確認工作目錄是本檔案所在專案根目錄的上一層（`正式版`）。
2. 閱讀本檔、`STATUS.md`，以及使用者指定的唯一一個 Task 檔案。
3. 執行 `git status --short`，保留所有既有修改，不覆蓋、不還原、不清除。
4. 確認前一個 Task 的 `Codex review` 已是 `PASS`。Task 01 不受此限制。
5. 先用 5–10 行說明理解、預計修改檔案與測試方式，再開始實作。

## 強制限制

- 一次只能做一個 Task；禁止順手做下一個 Task。
- Task 未授權的檔案原則上不可修改；若真的必要，先停下說明理由。
- 不做大重構，不拆改整個 `app.py`，以新增 service、migration、測試與小範圍接線為主。
- 不執行 production migration，不操作正式 Supabase 資料，不呼叫會改變外部狀態的 API。
- 不修改或重寫 Git 歷史，不 commit、不 push，除非使用者另外明確要求。
- 不破壞 Auth、AI 對話歷史、模擬交易 RPC、入金、下單、持倉、重置、Podcast、會員中心。
- 不建立真實交易、提款功能；不收助記詞、私鑰；不把 API Secret 寫到前端、log 或明文資料庫。
- 不把 mock、planned、pending review 說成 completed。
- 不以「測試無法執行」當作通過；必須說明原因、實際執行了什麼及剩餘風險。

## 每次完成後必做

1. 執行該 Task 規定的測試與必要 regression checks。
2. 重新執行 `git status --short` 與 `git diff --stat`。
3. 依 `REPORT_TEMPLATE.md` 建立 `claude_tasks/reports/TASK-XX.md`。
4. 將 `STATUS.md` 該 Task 的 `Implementation` 改為 `READY_FOR_CODEX_REVIEW`。
5. 不得修改 `Codex review` 欄位。
6. 立即停止，不得開始下一 Task。

## 審核流程

Claude Code 完成後，使用者會交由 Codex 審核。Codex 會檢查：

- 是否超出範圍。
- 資料流、權限與錯誤處理是否正確。
- migration/RLS 是否安全。
- 是否破壞既有核心流程。
- 測試是否真的覆蓋成功、失敗與邊界情境。
- 文件是否如實反映實作。

只有 Codex 把前一階段標為 `PASS`，Claude Code 才能開始下一階段。
