# TASK-11 實作報告

## 目標與邊界

- 將原本只有 multiplier 的展示，升級成可重現的假設式組合壓力測試。
- 明確區分即時模擬交易、情境壓力測試與歷史回測。
- 壓力測試只接收一次性的 request snapshot，不讀寫或改動 `sim_*` 帳本。

## 完成內容

- 新增純計算 `paper_stress_service`，比較 normal、bull、bear、black_swan 四種固定情境。
- 提供 conservative、balanced、aggressive 三種固定配置規則；風險資產權重分別為 35%、65%、90%。
- 每組結果輸出 total return、annualized volatility、max drawdown、Sharpe-like 與 final value。
- seed 與 7–365 個合成日期間可設定；相同 snapshot、seed、期間會得到相同 metrics/path，run id 仍保持唯一。
- 新增受會員驗證保護的 `POST /api/paper-stress-test`；Demo 可體驗紙上功能，輸入與未預期例外均使用固定錯誤碼。
- `/sim-trade` 以安全 DOM renderer 顯示同一組合的四情境比較、期間、起始基準、seed 與限制。
- 移除情境區塊的方向性投資建議字眼，改為中性的假設說明。
- 文件矩陣與流程圖補上獨立 snapshot、無 persistence、不得稱為歷史回測或價格預測的資料邊界。

## 自審補強

- 拒絕布林、負值、NaN/Infinity、超過 1e18 或加總溢位的金額。
- 重複 symbol 先合併，缺價持倉明確排除並回 warning，不以 0 假裝完整。
- 極端輸入與未知 runtime failure 都 fail closed，API 不回傳 raw exception。
- 測試直接 mock 模擬帳本寫入函式，證明壓力測試 endpoint 不會觸發保存或下單。

## 驗證

| 驗證 | 結果 |
|---|---|
| Task 11 focused tests | 14/14 PASS |
| 完整 regression | pytest 284/284 PASS |
| Task 01 RAG validator | 70/70 PASS |
| Task 09 asset validator | 108/108 PASS |
| Task 10 asset MVP validator | 28/28 PASS |
| Python compile / Node syntax / CRLF-aware diff check | PASS |

## 誠實揭露

- 此模型使用合成報酬路徑與固定終值錨點，不讀歷史 K 線、不是歷史回測，也不是價格預測。
- 結果只隨 API response 回傳並顯示，不持久化 stress run；快照由前端當下顯示的模擬組合建立。
- 未模擬費用、稅負、流動性、滑價或真實成交；Sharpe-like 也不是正式投資績效認證。
- 未修改既有模擬交易 Supabase RPC、本地 store、position、transaction 或 equity curve 流程。
