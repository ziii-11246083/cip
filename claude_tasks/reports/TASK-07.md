# TASK-07 實作報告

## 本次目標

將原本容易被誤解為合約或鏈上掃描的詐騙功能，如實定位為「可疑文案風險辨識」，分開 deterministic rules、本地 RAG 與 LLM 證據，並在不確定時明確呈現限制。

## 實際流程

1. `/api/scam-scan` 只接收最多 12,000 字的可疑文案。
2. 先執行可測試的文字紅旗規則，建立風險下限。
3. RAG 只檢索專案本地詐騙案例知識；只回傳實際注入的 citations。
4. LLM 只產生文案風險說明，不能降低 deterministic rule 的風險下限。
5. 程式合併舊的 `risk_level/report` 與新的 rules/reasons/warnings/evidence/citations/uncertainty/trace_id。

本流程沒有呼叫 GMGN、WHOIS、PTT、網域、合約或鏈上掃描 API。

## 規則與合併語意

| Rule ID | 級別 | 可解釋紅旗 |
|---|---|---|
| `guaranteed_profit` | high | 保證獲利、穩賺或固定收益 |
| `credential_request` | high | 索取助記詞、私鑰或錢包備份 |
| `support_impersonation` | high | 冒名交易所/錢包客服並聲稱帳號異常 |
| `urgent_transfer` | high | 用緊急或限時要求匯款、轉幣或付款 |
| `prompt_injection` | medium | 嘗試要求分析器忽略安全規則 |

- 最終級別不得低於規則下限；LLM 失敗或回傳 low 不會將明確紅旗降級。
- 少於 12 字且無規則命中的輸入為 `unknown` / high uncertainty。
- 未命中規則只表示「未發現內建文字紅旗」，不代表安全。
- LLM 聯合未驗證外部掃描名稱與「已查/掃描結果」之類聲稱時，改為固定的未執行外部掃描說明。

## Response 與 UI

- 保留 `risk_level` 與 `report`，增量加入 `triggered_rules`、`reasons`、`warnings`、`evidence`、`citations`、`uncertainty`、`trace_id`與既有 `confidence`。
- UI 明確顯示「規則與原因」、「警示與限制」、「證據類型」、「不確定性」，並告知使用者未掃描合約/網域/鏈上交易。
- API 輸出經過 public sanitizer；前端動態內容只用 `textContent` / `createElement`，沒有把 API 內容插入 `innerHTML`。

## 文件一致性

已修正 `docs/05`、`06`、`08`、`10`、`12`、`13`、`16`：現行詐騙流程不再宣稱已有 GMGN/WHOIS/PTT/鏈上掃描；`scam_scan_logs` 改為未來文案風險紀錄契約，並標明 runtime 目前不寫入。

## 測試證據

| 指令 | 結果 |
|---|---|
| `/tmp/cip-test-venv/bin/python -m pytest tests/test_scam_truth.py tests/test_rag_endpoints_trace.py -q` | 67 passed |
| `/tmp/cip-test-venv/bin/python -m pytest -q` | 238 passed，11 個既有第三方 warnings |
| `python3 -m unittest tests.test_rag_trace_service` | 70 tests OK |
| `python3 scripts/validate_rag_trace_migration.py` | 70/70 PASS |
| `py_compile` | PASS |
| `git -c core.whitespace=cr-at-eol diff --check` | PASS |

Task 07 新增 10 項測試：四類 high 紅旗、一般文案、資訊不足、prompt injection、LLM failure、RAG empty、假外部掃描聲稱、response 相容、UI XSS 與真實限制文案。

## 未完成／刻意未做

- 沒有串接 GMGN、WHOIS、PTT、交易所或新第三方服務。
- 沒有宣稱文案辨識能保證交易安全，也沒有虛構 accuracy、precision 或 recall。
- 沒有建立/執行 `scam_scan_logs` migration，也沒有寫正式 DB。
- 沒有改動發文、留言、任務、排程、儲值、付款或模擬交易核心流程。

## 自我判定

- [x] 功能名稱、API、UI 與文件符合實際能力
- [x] 四類高風險紅旗可測試、可解釋且不可被 LLM 降級
- [x] 不確定與外部掃描限制會顯示給使用者
- [x] 舊 response 欄位保留，追蹤/citation 契約沒有被破壞
- [x] 完整回歸、XSS 靜態安全與 migration validator 皆通過
