# TASK 10 — Codex 審核

審核結果：`PASS`

審核日期：2026-08-20

## 結論

Task 10 以小範圍完成 Ethereum Mainnet 公開地址唯讀同步 MVP，沒有將單鏈功能說成全鏈，也沒有將 Beta flag 說成付費訂閱。真實資產資料流與模擬交易完全分離，可解鎖 Task 11。

## 關鍵審核證據

- 官方 Alchemy endpoint 只由 server adapter 呼叫；沒有 sign/send/trade method。
- address format/network/provider 三層 fail closed；公開地址 API response 只回遮罩版。
- service-role store 不回退 anon/generic key；user UID 從 verified token 取得，body user_id 被忽略。
- atomic RPC 锁 account/run，驗證 ownership/provider/network/counts，且只授權 service role。
- success/empty/partial/timeout/429/5xx/retry/idempotent/active lock/last-good/wrong-user/entitlement 皆有反例。
- 無價格時 quantity 保留，不寫假 0 total；duplicate asset 不重複計價。
- 前端真實資產 renderer 只用 text nodes，並顯示 price source/time、partial/stale 語意與密鑰警語。
- 270 項完整 pytest、28 項 MVP static checks、108 項 Task 09 checks、70 項 RAG checks、JS/Python syntax 與 diff check 全通過。

## 非阻擋部署限制

- 上線前必須在 Supabase test project 執行 migration，實測 RLS/RPC/concurrent unique indexes，再對正式環境放行。
- 需由部署者安全設定 `ALCHEMY_API_KEY`、`ASSET_SYNC_HMAC_SECRET` (至少 32 bytes)、`SUPABASE_SERVICE_ROLE_KEY` 與 `ASSET_SYNC_ENABLED=1`。
- process-local rate limiter 不是 multi-worker shared quota；擴展前需 distributed limiter。
- 本次未使用真實 provider credential，所以 PASS 表示程式/契約/測試通過，不代表線上 integration 已證實。

## 開門

- TASK 10 Codex review：`PASS`。
- 允許開始 TASK 11；不將部署限制偷渡為已上線宣稱。
