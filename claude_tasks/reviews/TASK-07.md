# TASK 07 — Codex 審核

審核結果：`PASS`

審核日期：2026-08-20

## 結論

可疑文案功能已從不存在的外部合約/網域掃描敘述，收旂為實際的文字規則、本地 RAG 與 LLM 風險說明。明確紅旗不會被模型失敗或過度樂觀的輸出降級，UI 能顯示證據類型與不確定性，文件與 runtime 一致。可解鎖 Task 08。

## 接受證據

- 實碼與查找證據證實 `/api/scam-scan` 沒有 GMGN、WHOIS、PTT 或鏈上 API call。
- 保證獲利、索取私鑰/助記詞、冒名客服、緊迫匯款均有 deterministic high rule；prompt injection 以 medium 提醒。
- 最終 risk 取規則下限與 LLM 較高者；LLM failure/RAG empty 不會將明確 high 降為 low。
- 資訊不足輸出 unknown/high uncertainty；一般文案也持續告知低風險不等於安全。
- 保留舊 `risk_level/report` 與現有 trace metadata，新結構欄位為增量擴充。
- 前端動態資料用 `textContent`/DOM node 渲染，靜態反例不允許將 API report 放入 `innerHTML`。
- 指定七份文件均改成實際文案風險流程；其他 PTT 只留在真實的社群情緒模組或「未串接」限制聲明。
- focused 67/67、完整 pytest 238/238、trace service 70/70、migration validator 70/70、compile/diff gates 全部通過。

## 非阻擋限制

- 本功能不能驗證真實身分、網域、合約或鏈上活動；已在 API 輸出、UI 與文件明確告知。
- `scam_scan_logs` 仍是規劃中的資料契約，runtime 不寫入；不在 Task 07 自行擴大為 DB migration。
- 尚無已標記的詐騙分類資料集，因此不宣稱準確率或召回率。

## 開門

- TASK 07 Codex review：`PASS`。
- 允許開始 TASK 08；TASK 09 仍鎖定至 08 PASS。
