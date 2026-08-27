# TASK 06 — Codex 審核

審核結果：`PASS`

審核日期：2026-08-20

## 結論

三條既有 RAG 管理 endpoint 已完成 server-side 權限與資訊分級，未授權者不能 rebuild/eval/read detailed metrics；public stats 只保留 health summary。rebuild 有目前部署模型適用的 process lock 與完成驗證，失敗不再回 success/raw exception。可解鎖 Task 07。

## 接受證據

- Supabase server-verified app_metadata 是唯一 admin 來源；email、user_metadata、demo 都不能升權。
- Anonymous 401、authenticated non-admin 403，三個 protected route 語意一致。
- Concurrent rebuild 409 且第二次不執行；成功須通過 count/BM25/vector post-condition；所有路徑 finally 釋放 lock。
- Public stats response exact allowlist，不含 query/user/path/config/model/metrics；details 僅 admin 可讀且 aggregate metric 再經 allowlist。
- Eval 有 bounded validation、RAG unavailable 與 provider failure fixed codes，所有 public text/path/score 安全化。
- Audit 只有 action/status/fixed code/actor hash；合成 Bearer/API key 不出現在 response/log。
- 完整 pytest 228/228、Task 06 focused 11/11、trace service 70/70、validator 70/70、compile/diff gates 全通過。

## 非阻擋限制

- `threading.Lock` 是單一程序鎖；目前 Flask process 模型可用。部署擴展到多 worker／多機前，必須升級 distributed lock。
- rebuild 引擎本身不是 transaction；本任務依範圍只保證 partial/failure 不被 API 宣稱 success，未重構底層索引。

## 閘門

- TASK 06 Codex review：`PASS`。
- 允許開始 TASK 07；TASK 08 仍鎖定直到 07 PASS。
