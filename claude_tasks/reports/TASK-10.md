# TASK-10 實作報告

## 目標與決策

- 審核後核准 provider：Alchemy Portfolio API。
- 單一核准 network：Ethereum Mainnet (`eth-mainnet`)。
- 只做公開地址唯讀資產同步，不簽名、不下單、不接交易所。

## 完成內容

- `AlchemyEthereumProvider` 實作已審核 interface：Ethereum address validation、bounded pageKey 分頁、native/ERC-20 balance/metadata/price 正規化、canonical asset key 去重。
- API key 僅從 `ALCHEMY_API_KEY` server env 讀取；raw URL/exception 不進 log/response。無 key 直接 fail closed。
- 實作 timeout、429/5xx 分類、最多 3 次 retry、1/2/4s bounded backoff、process/request rate limit 與 per-account DB unique lock。
- `ASSET_SYNC_ENABLED` 為 server-side Beta entitlement；Demo 帳號拒絕，不相信 client plan/user_id。
- 帳號去重使用獨立 `ASSET_SYNC_HMAC_SECRET`，並拒絕 service-role key 與 anon/generic key 相同的歧義設定。
- 新增 service-role-only `asset_sync_commit_snapshot` RPC；account/run row lock 下一次寫 snapshot/balances/counts，只有 complete success 切換 last-good。
- 缺價保留 quantity，price/value/total 保持 NULL 並標 partial；無 silent skip，fetched/normalized 可說明。
- 新增 4 條 member JWT API：connect、portfolio、manual sync、disconnect；他人 account 統一視為 not found。
- `/member` 新增獨立「真實資產」區，下方原模擬 ledger/下單不改。UI 標明唯讀、單一 network、不要求助記詞/私鑰、Beta 不代表已收費。

## 自審補強

- 補上完整 pageKey 分頁與重複/過多頁 fail closed。
- 將 duplicate asset 視為 partial 證據，不重複計價。
- 區分真正 active-run collision 與 DB outage，不把所有 DB 錯誤假報 409。
- 更新功能矩陣、DB 文件與系統流程，不再宣稱「無錢包同步」，仍誠實標記 migration 未執行。

## 驗證

| 驗證 | 結果 |
|---|---|
| Task 09 + 10 focused tests | 32/32 PASS |
| Task 10 static validator | 28/28 PASS |
| 完整 regression | pytest 270/270 PASS |
| Task 09 validator | 108/108 PASS |
| Task 01 validator | 70/70 PASS |
| JS syntax / member render smoke | PASS；`/member` 200 |
| py_compile / CRLF-aware diff check | PASS |

## 誠實揭露

- 未呼叫真實 Alchemy API，測試全用 injected fake session，不使用或產生 API key。
- 未連 Supabase、未執行兩份 migration/RPC，因此不宣稱線上已可用。
- 目前是手動同步，沒有 scheduler；只支援 fungible native/ERC-20，不包含 NFT/DeFi positions。
- 目前 entitlement 是可控 Beta flag，不是付費訂閱證據。
