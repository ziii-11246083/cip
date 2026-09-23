# TASK-09 實作報告

## 本次目標

只建立真實資產同步的 provider-neutral 架構、資料契約、versioned migration 與抽象 provider interface；不連外部 provider、不執行 migration、不改 runtime/UI。

## 完成內容

- 新增 `external_accounts` / `asset_sync_runs` / `asset_snapshots` / `asset_balances` 四表 migration，限制 `source_kind=real`，不依賴 `sim_*` 或尚未存在的 subscriptions schema。
- authenticated 四表僅能 SELECT 自己的資料；沒有 client write policy/grant，anon 無權限。
- 公開錢包地址視為私密帳號資料；去重使用 server-side keyed HMAC，未建立助記詞、私鑰、API secret 或 raw provider payload 欄位。
- 用 composite FK 同時錯住 snapshot→run 與 balance→snapshot 的 account ownership，避免跨使用者關聯。
- 定義 idempotency key、每 account 單一 active run DB lock、bounded timeout/retry/backoff/rate-limit、同步狀態機、last-good 與 disconnect 語意。
- `AssetSyncProvider` 只有 `validate_account()` / `fetch_balances()` / `normalize_balances()` / `health_check()` 契約，沒有 HTTP/RPC SDK 或網路呼叫。
- entitlement 只有 server-side abstraction，預設 `DenyByDefaultEntitlementChecker`；不把 Demo、email 或 client plan 當付費證據。

## Codex 自審修正

- 將 snapshot 與 sync run 改為 `(sync_run_id, external_account_id)` composite FK，阻擋跨 account run 連結。
- RLS ownership subquery 使用完整 outer table 欄位，排除相關子查詢欄位歧義。
- `last_success_at` 存在時強制 `last_sync_at` 必須存在且時間不得較早。
- provider type 雖預留 enum，Task 09 account contract 明確拒絕 exchange。
- 將每秒 request 上限放入 `SyncPolicy`，並說明 distributed deployment 需 shared limiter。

## 驗證證據

| 驗證 | 結果 |
|---|---|
| Task 09 migration/interface 靜態 validator | 107/107 PASS（未連 DB） |
| Task 09 contract tests | 9/9 PASS |
| 完整 regression | pytest 247/247 PASS |
| Task 01 validator | 70/70 PASS |
| Python compile / diff check | PASS |

## 範圍聲明

- 沒有連線 Supabase，沒有執行 migration。
- 沒有呼叫錢包、交易所、RPC 或價格 API。
- 沒有改 Flask route、前端 UI、模擬交易、儲值或訂閱流程。
- Task 09 送審時 provider/network 仍為 `TBD`；未先偷選廠商。

## 實作判定

- Implementation：`READY_FOR_CODEX_REVIEW`
- 未執行 Task 10。
