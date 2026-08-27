# TASK-05B 實作報告

## 本次目標

在已通過的 05A evaluator/artifact 上加入明確 baseline 核准、不可覆寫 manifest、相容版本比較與可設定 regression gate；不改資料集、知識庫、retrieval/rerank/router 或 production endpoint。

## 修改檔案

| 檔案 | 修改目的 |
|---|---|
| `claude_tasks/05B_RAG_BASELINE_REGRESSION.md` | Codex 依 05A PASS schema 補齊 manifest、相容性、threshold 與驗收規格 |
| `scripts/eval_rag.py` | baseline manifest v1、SHA-256 pointer、approval eligibility、comparison、threshold gate、CLI 與 summary 接線 |
| `tests/test_rag_eval.py` | 保留 39 個 05A tests，新增 9 個 05B tests（本檔共 48） |
| `eval/README.md` | 補核准／比較指令、metric 方向、threshold 與限制 |
| `eval/baselines/.gitkeep` | 只保留空目錄；沒有自動核准真實 baseline |
| `claude_tasks/STATUS.md` | 只更新 05B Implementation |

## Baseline 資料流與安全條件

1. 預設執行只建立新的 timestamped run artifact，不碰 baseline。
2. 只有 `--approve-baseline --baseline-name <safe-slug>` 才嘗試核准。
3. 核准來源必須 `run_status=completed`、completed=total=metadata case_count、failed=0、case_count>0、Git commit 為 40–64 hex 且 dirty=false。
4. memory artifact 必須與 disk `results.json` 完全一致，artifact 必須 resolve 在 project root 且檔名為 `results.json`。
5. manifest 保存 artifact project-relative ref＋SHA-256、compatibility、overall/per-endpoint snapshot 及 run/code/KB/index/model provenance。
6. `<baseline-root>/<baseline-name>.json` 以 exclusive create 寫入；同名固定 `eval_baseline_exists`，永不覆寫。
7. 比較時重新驗證 pointer containment、SHA-256、artifact JSON、eligibility，以及 manifest 所有 snapshot；壞 JSON、缺檔、tamper 都只回固定 `eval_baseline_invalid`。

## 相容性與 metric 規則

- 必須完全相同：dataset_version、排序後 case_ids、K values、`rag-retrieval-metrics-v2-distinct-topic`、config fingerprint。
- code/dirty/KB/index/model 不作相容性鍵，保留為 candidate/baseline provenance，讓變更可被比較。
- 比較 P@K、Recall@K、NDCG@K、MRR、keyword_overlap、source_match、latency.avg_ms。
- 品質 metric 高者較好；latency 低者較好。狀態為 improved/stable/regressed/unavailable。
- `delta=current-baseline`；品質 degradation=`max(0, baseline-current)`，latency degradation=`max(0, current-baseline)`。
- `--threshold METRIC=VALUE` 可重複；VALUE 必須 finite 且 ≥0。degradation 大於 threshold 才 fail，等於通過。
- 有 threshold 且只有一邊 unavailable 時 fail closed；未設定 threshold 時仍顯示 unavailable，不偽造 0/delta。
- gate fail、baseline missing/tampered/incompatible 時 CLI exit 1，但 completed retrieval artifact 仍一次寫入完整 comparison/error，不事後覆寫。

## 測試證據

| 指令 | 結果 |
|---|---|
| `/tmp/cip-test-venv/bin/python -m pytest tests/test_rag_eval.py -q` | 48 passed（05A 39＋05B 9） |
| `/tmp/cip-test-venv/bin/python -m pytest tests/ -q` | 217 passed，11 個既有第三方 warnings |
| `python3 -m unittest tests.test_rag_trace_service` | 70 tests OK |
| `/tmp/cip-test-venv/bin/python -m py_compile scripts/eval_rag.py tests/test_rag_eval.py` | PASS |
| `python3 scripts/validate_rag_trace_migration.py` | 70/70 PASS |
| `git -c core.whitespace=cr-at-eol diff --check` | PASS |

### 05B 新增 9 項測試

- explicit approval、project-relative pointer、64-hex hash、exclusive collision、memory/disk mismatch。
- dirty、failed、unavailable commit 拒絕。
- improved/stable/regressed 與品質/latency 相反方向；threshold 等於通過、超過失敗。
- unavailable threshold fail closed。
- dataset/case IDs/K/config 四類不相容。
- artifact hash tamper、壞 manifest＋合成 secret 固定 code 且不洩漏。
- threshold allowlist、duplicate、negative、NaN 與 malformed input。
- CLI missing baseline 仍留 artifact、fixed code/non-zero/no secret。
- CLI 預設不寫 baseline、明確核准成功、candidate regression gate non-zero 且 comparison 入 artifact。

## 未完成／刻意未做

- 沒有自動或代替使用者核准正式 baseline；目前 worktree dirty，本來就必須被 approval gate 拒絕。
- 未實作／呼叫 LLM judge；answer metrics 仍是 05A 的 unavailable。
- 未產生 candidate 題、未修改 15 題或其 expected/gold answer。
- 未連 Supabase、未寫 `rag_eval_runs/rag_evaluations`、未執行 migration。
- 未修改 production endpoint、retrieval/rerank/router/KB、Task 01–05A 已通過語意。
- 本輪尚未 commit/push；先前 checkpoint `5b7f523` 已在 `origin/08/20`。

## 請 Codex 特別審核

1. clean completed run eligibility 是否足以防止不可重現 baseline。
2. manifest pointer/hash 與 snapshot 雙向核對是否關閉 tamper／memory-disk 分叉。
3. 相容性鍵是否避免錯組資料，同時允許不同 code/KB candidate 被觀察。
4. threshold 的品質/latency 方向、等於邊界與 unavailable fail-closed 是否符合 regression gate 語意。
5. baseline error/gate fail 時保留 retrieval artifact、但不覆寫任何歷史證據的流程是否正確。

## 自我判定

- [x] 未超出 05B 允許範圍
- [x] 未開始 Task 06
- [x] 預設不寫 baseline，沒有核准真實 baseline
- [x] 未連 DB、未執行 migration、未發外部請求
- [x] 完整回歸與安全反例已實際執行
