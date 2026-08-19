# TASK 11 — Paper Trading 情境壓力測試

## 依賴

- Task 10 的 Codex review 必須為 `PASS`，或 Codex 明確標記 Task 10 延後且允許 Task 11 開始。

## 本次唯一目標

把目前只展示 multiplier 的情境區塊升級成獨立、可比較的壓力測試；不得改寫既有模擬交易帳本。

## 實作要求

- 區分：即時模擬交易、情境壓力測試、歷史回測。
- 壓力測試使用獨立 run/snapshot，不把 scenario price 寫回 sim_transactions/sim_positions。
- 同一初始資金與配置比較 normal/bull/bear/black_swan。
- 若加入策略，至少 conservative/balanced/aggressive，且規則需固定、可說明。
- 輸出 total return、volatility、max drawdown、Sharpe-like metric、final value。
- 說明 multiplier 模型是假設式 scenario，不等於歷史 backtest。
- 結果可重現；randomness 必須可設 seed。

## 測試最低要求

- 各 scenario deterministic fixture。
- 空持倉、單一資產、集中持倉、穩定幣、價格缺失。
- 相同 seed 結果一致。
- 不修改既有 ledger 的 regression test。
- UI 明確標示假設、期間、基準與限制。

## 驗收

能在答辯中展示同一配置於四種市場的可比較結果，且不誤稱歷史回測。完成後停止。
