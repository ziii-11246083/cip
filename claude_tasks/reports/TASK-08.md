# TASK-08 實作報告

## 本次目標

只修正系統功能、UML、資料字典與評審對照文件，以可定位的 runtime/migration/client evidence 區分 `implemented` / `partial` / `planned` / `deprecated`；不新增產品功能。

## 完成內容

- 新增 `docs/18-系統功能與資料一致性矩陣.md`，共 23 條功能；每條列 UI/page、route、service/function、table/RPC、auth/role、狀態與證據檔案。
- 單獨對照 Scam、RAG、會員、模擬交易、訂閱、external account 六條必查資料流。
- `docs/06` 保留分析類別圖的問題域邊界，設計圖才放 Flask/Supabase/service；移除不存在的 `SocialMediaEngine.scan_scam`，更新 route/template 數與詐騙文案組件。
- `docs/07` 移除 GMGN 已串接聲稱，將 PTT/RSS 清洗文件改為程式實際行為，並誠實標出未實作去重、PR/robot 過濾、48h 時間窗與 deterministic sentiment。
- `docs/08` 新增表級狀態盤點；只有 RAG 5 表有 repo migration，其他表依 client call 或僅文件分成 partial/planned。模擬交易 RPC 明標 repo 缺 migration，外部帳號也不再聲稱「手動同步」。
- `docs/10` 引入證據狀態；訂閱/付款/通知/external account 等只有文件的項目改為 planned，footer 依實碼改為完成。
- `docs/12`, `docs/13`, `docs/16` 更新模型 env 契約、移除漂移行號、標記訂閱/external flow 為未來規劃，並將即時分析與持久化缺口分開。
- `docs/05` 連到一致性矩陣，AI 成本明標為規劃假設，上線前需依當時官方定價重算。

## 關鍵判定

- `/member` 只顯示 paper-trading 資金/持倉，不是真實錢包或交易所資產。
- Demo Member 只是體驗登入/本地模擬流程，不是 Pro/Premium entitlement 或付費訂閱證據。
- `supabase_client.py` 有 method 不等於 repo 已有相對應 DDL/RLS/RPC；正式部署前仍需實 DB 比對。
- RAG migration 已入 repo 且 validator 70/70，但本階段未執行 migration，不聲稱正式 DB 已部署。

## 驗證證據

| 驗證 | 結果 |
|---|---|
| 矩陣靜態檢查 | 23 feature rows，每列 8 欄，狀態值全合法 |
| UML 邊界 | 分析類別圖區段無 Flask/Supabase/DataManager/RAGTraceService |
| Footer | Flask 實際 render 的 13 個 templates 全引用 footer partial |
| Markdown | 指定文件 code fences 全數配對；`diff --check` PASS |
| 完整 regression | pytest 238/238 PASS |
| RAG migration validator | 70/70 PASS（靜態，未連 DB） |

## 範圍聲明

- 本 Task 沒有修改 Python、JS、HTML、CSS、migration 或 DB。
- 沒有將 planned schema 補成 migration，也沒有把 runtime 偷改成迎合文件。
- 沒有連線 Supabase、沒有執行 migration、沒有 commit/push。

## 自我判定

- [x] 六條必查流程皆可定位並正確分級
- [x] planned/mock 不再列為完成
- [x] 每個完成宣稱有程式、migration 或測試證據
- [x] 只修文件，不影響核心流程
