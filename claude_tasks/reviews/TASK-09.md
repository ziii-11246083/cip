# TASK 09 — Codex 審核

審核結果：`PASS`

審核日期：2026-08-20

## 結論

Task 09 已在不接 provider、不動 UI/runtime 的邊界內，建立可審核的真實資產同步契約。real/manual/simulated 分離、ownership、RLS、idempotency、lock、failure/last-good/disconnect 均有可定位證據。可進入 provider/network 決策閨門；決策寫入前 Task 10 仍不得啟動。

## 接受證據

- 四張新表只保存 real wallet normalized data，沒有 sim/subscription runtime 依賴。
- authenticated 只有 own-row SELECT，沒有 INSERT/UPDATE/DELETE policy/grant，anon 沒有 policy。
- snapshot→run 與 balance→snapshot 的 composite FK 阻止跨 account 資料串接。
- 同 account idempotency unique key、active-run partial unique index 與 last-good partial unique index 定義並發邊界。
- 契約只容許公開地址；exchange credential reference 在 DB 強制 NULL，程式也 fail closed。
- provider interface 沒有 network dependency；entitlement 預設 deny，不接受 client 付費宣稱。
- 完整 pytest 247/247、Task 09 validator 107/107、Task 01 validator 70/70、compile/diff check 通過。

## 非阻擋限制

- migration 尚未在 Supabase test project 執行；部署前必須實測 RLS、cascade 與 concurrent unique indexes。
- process-local rate policy 不是 distributed quota；Task 10 如進入 multi-worker 執行，需 shared limiter/DB lock。
- 本階段沒有真實付費 entitlement backend，所以契約正確地 fail closed，不能對外稱付費會員已可用。

## 開門

- TASK 09 Codex review：`PASS`。
- 審核後決策：`Alchemy Portfolio API` + `Ethereum Mainnet (eth-mainnet)`。
- 理由：官方 `assets/tokens/by-address` 可同時回傳 native/ERC-20 balance、metadata、USD price/time，且有 top-level partial network errors 與 per-token errors，符合本專案的 partial/last-good 模型。MVP 仍只核准單一 `eth-mainnet`。
- 官方來源：https://www.alchemy.com/docs/data/portfolio-apis/portfolio-api-endpoints/portfolio-api-endpoints/get-tokens-by-address 與 https://www.alchemy.com/docs/reference/compute-unit-costs（查詢日 2026-08-20）。
- provider/network 值已寫入契約，允許開始 TASK 10。
