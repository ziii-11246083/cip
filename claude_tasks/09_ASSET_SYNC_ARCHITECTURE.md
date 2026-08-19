# TASK 09 — 資產同步架構與資料模型（不接 Provider）

## 依賴

- Task 08 的 Codex review 必須為 `PASS`。

## 本次唯一目標

只完成真實資產同步的架構、資料契約、migration 與 provider interface。不得呼叫任何真實錢包或交易所 API，不改會員 UI。

## 核心原則

- `real`、`simulated`、`manual` 三種資產來源完全分離。
- 本階段只接受公開地址概念，不保存交易所 API Secret。
- 不假裝已有真實付費；使用 server-side entitlement abstraction。

## 資料模型至少包含

- `external_accounts`
- `asset_balances`
- `asset_snapshots`
- `asset_sync_runs`
- entitlement 與既有 subscriptions 的整合方式（可只設計，不重做金流）

必要欄位：user、provider type/provider、public identifier、status、last sync/success/error、asset/network、quantity、price source/time、snapshot、created/updated。

## Provider interface

- `validate_account()`
- `fetch_balances()`
- `normalize_balances()`
- `health_check()`

定義 idempotency key、sync lock、timeout、rate limit、retry/backoff、success/partial/failed/stale、last-good snapshot 與 disconnect 行為。

## 安全要求

- RLS 與 ownership 必須明確。
- public address 也視為個資，不公開給其他使用者。
- 不保存助記詞/私鑰。
- 預留未來 encrypted credential reference，但本 Task 不建立明文 secret 欄位。
- migration 不執行正式 DB。

## Provider 決策閘門

在文件留下：

`APPROVED_PROVIDER: TBD`
`APPROVED_NETWORK: TBD`

這兩項只能在 Codex 審核 Task 09 後決定。Task 10 看見 TBD 時必須停止，不得自行選服務商。

## 驗收

- migration、RLS、ERD、狀態機與 provider contract 完整。
- 重複同步、部分成功、失敗保留舊快照、disconnect 都有明確語意。
- 沒有改 runtime/UI，沒有呼叫外部 provider。
- 完成後停止。
