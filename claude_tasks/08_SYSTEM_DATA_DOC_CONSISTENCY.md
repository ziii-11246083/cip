# TASK 08 — 系統功能、UML、資料字典一致性

## 依賴

- Task 07 的 Codex review 必須為 `PASS`。

## 本次唯一目標

做文件一致性修正，不新增產品功能。

## 實作要求

- 建立 `docs/18-系統功能與資料一致性矩陣.md`，每一功能至少列：
  - UI/page
  - route
  - service/function
  - table/RPC
  - auth/role
  - 狀態：implemented/partial/planned/deprecated
  - 證據檔案
- 以程式為準核對 `docs/05`、`06`、`07`、`08`、`10`、`12`、`13`、`16`。
- 分析類別圖只放問題域；設計類別圖才放 Flask/Supabase/service。
- 已存在但文件寫待補（例如 footer）需更新。
- 只有文件、沒有 migration/CRUD/route 的表必須標 planned，不得標 implemented。
- 資料字典欄位與現有 payload/RPC 名稱不一致時，列出差異；不要偷偷改 runtime 來迎合文件。
- 更新評審修正對照表，狀態必須有證據。

## 允許修改

- `docs/**`
- Mermaid/文件圖片產物（如流程確實需要）
- Task report/status

不得修改 Python、JS、HTML、CSS、migration。

## 驗收

- 抽查 Scam、RAG、會員、模擬交易、訂閱、external account 六條資料流均一致。
- planned/mock 不列為完成。
- 每個 ✅ 都有可定位的程式或 migration 證據。
- 完成後停止。
