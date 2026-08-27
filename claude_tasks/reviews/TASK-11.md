# TASK 11 — Codex 審核

審核結果：`PASS`

審核日期：2026-08-20

## 結論

Task 11 已在不改動既有模擬交易帳本的前提下，完成可重現、可比較且不冒充歷史回測的情境壓力測試。可解鎖 Task 12。

## 關鍵審核證據

- 純計算 service 不匯入或呼叫任何 `sim_*` persistence/order helper；endpoint regression 也證明保存與下單函式零呼叫。
- 同一 snapshot、period、seed 的三策略／四情境 metrics 與 path deterministic；每次 run id 獨立。
- 空持倉、單一／集中資產、重複 symbol、純穩定幣、缺價、負值、布林、極端大數、非法 symbol、期間／seed 邊界都有反例。
- 缺價資產會明確 warning 並排除，不把未知價格當 0；重複資產不重複計價。
- UI 清楚顯示起始基準、合成期間、seed、模型限制，並將「實際即時價格／建議動作」修正為假設終值錨點與中性情境說明。
- unexpected exception 只回 `stress_internal_error`，不外洩原始訊息。
- 完整 pytest 284/284、三組 static validators 70/70、108/108、28/28，以及 Python/Node/diff gates 全通過。

## 非阻擋限制

- stress run 目前不持久化；若未來需要比較歷次結果，應另建獨立資料契約，不得混入模擬交易 ledger。
- client snapshot 不是 server-authoritative 歷史證據；目前用途是頁面內即時教育與答辯展示。
- synthetic model 僅用於固定假設比較，不能由 PASS 延伸宣稱預測準確率或投資績效。

## 開門

- TASK 11 Codex review：`PASS`。
- 允許開始 TASK 12；不得把假設式壓力測試寫成歷史回測。
