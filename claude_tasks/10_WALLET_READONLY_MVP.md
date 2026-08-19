# TASK 10 — 公開錢包地址唯讀同步 MVP

## 依賴

- Task 09 的 Codex review 必須為 `PASS`。
- Task 09 文件內 `APPROVED_PROVIDER` 與 `APPROVED_NETWORK` 不得為 `TBD`。
- 若仍為 TBD，立即停止，只回報「等待 Codex/provider 決策」，不得修改程式。

## 本次唯一目標

依已核准 provider/network 實作一個公開地址唯讀同步 MVP，並在會員中心把真實資產與模擬資產分開顯示。

## 實作要求

- 只輸入公開地址；server-side 驗證地址格式與 network。
- 實作 Task 09 已審核的 adapter，不繞過 interface。
- 同步需 idempotent、具 lock、timeout、rate limit、retry/backoff。
- 保存 sync run 與 snapshot；失敗時沿用 last-good snapshot 並標 stale/failed。
- 同一 account/asset 不重複計算。
- 價格來源與時間需顯示；無價格的資產保留 quantity，不把價值猜成 0 或任意價格。
- 會員中心新增獨立「真實資產」區塊/tab，不修改既有模擬交易 ledger。
- UI 明示：唯讀、不會代下單、不會要求助記詞或私鑰。
- entitlement 必須 server-side 驗證；尚無付費流程時用明確 feature flag/demo entitlement，不宣稱已收費。

## 測試最低要求

- valid/invalid address。
- success/empty/partial/timeout/rate limited/provider error。
- retry 後成功、重複同步、concurrent sync。
- last-good snapshot。
- user A 不可讀 user B。
- entitlement denied。
- 不影響模擬資產數字與操作。

## 不可做

- 不串交易所 API。
- 不保存任何 secret。
- 不做真實交易。
- 不把只支援單一 network 說成全鏈支援。

## 驗收

核准 network 的真實公開地址可安全同步並清楚顯示限制；完成後停止。
