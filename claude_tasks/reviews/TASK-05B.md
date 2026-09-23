# TASK 05B — Codex 審核

審核結果：`PASS`

審核日期：2026-08-20

## 結論

05B 已建立可信的 explicit approval、immutable baseline manifest、相容性比較與 regression threshold gate；預設執行不會寫 baseline，也沒有自動核准任何真實 baseline。修改限於 evaluator、tests、README、任務／報告與空 baseline 目錄，未改資料集、KB、retrieval/rerank/router、production endpoint 或 DB。

## 接受證據

- baseline 只由 `--approve-baseline`＋safe baseline name 建立，manifest 使用 exclusive create，collision 固定拒絕。
- 核准只接受 completed/0 failed/完整 case count/clean 40–64 hex commit；dirty、failed、unavailable commit 皆拒絕。
- project-relative artifact pointer 有 resolve containment 與 SHA-256；核准時 memory/disk artifact 必須一致。
- 比較時重新驗證 hash、artifact eligibility、compatibility、overall/per-endpoint 與 run/code/KB/index/model snapshots；缺檔、壞 JSON、secret path、tamper 固定 code，不洩漏 raw exception。
- compatibility 鍵為 dataset_version、sorted case IDs、sorted K values、metric schema v2、64-hex config fingerprint；不相容不計 delta。
- 品質 metric higher-is-better、latency lower-is-better；improved/stable/regressed/unavailable 與 delta/degradation 明確。
- threshold finite/非負/allowlist；degradation 大於 threshold 才失敗，等於通過；單邊 unavailable 且有 threshold 時 fail closed。
- CLI baseline error/incompatibility/gate failure exit non-zero，但 completed retrieval artifact 仍只寫一次並保存 comparison/error。
- embedding model provenance 經既有 sanitizer；baseline manifest 不成為 token/provider 字串旁路。

## 測試

- `pytest tests/test_rag_eval.py -q`：48 passed（含 9 個 05B tests）。
- `pytest tests/ -q`：217 passed，11 warnings（既有第三方相容／棄用警告）。
- trace service unittest：70 OK。
- Task 01 validator：70/70 PASS。
- py_compile、CRLF-aware diff check：PASS。

## 保留限制

- 沒有正式 baseline 被核准；使用者需在 clean commit 上明確執行 approval，並保存 manifest 與被指向 artifact。
- 15 題仍 pending human review；retrieval baseline 不代表 answer accuracy。
- 沒有 LLM judge、candidate auto-promotion、Supabase eval 寫入或 production endpoint 變更。

## 閘門

- TASK 05B Codex review：`PASS`。
- 允許開始 TASK 06；TASK 07 仍鎖定直到 06 PASS。
