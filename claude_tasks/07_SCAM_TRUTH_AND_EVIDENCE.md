# TASK 07 — 詐騙檢測真實化與結構化證據

## 依賴

- Task 06 的 Codex review 必須為 `PASS`。

## 本次唯一目標

讓詐騙功能的名稱、資料流、response、UI 與文件符合實際能力。近期定位為「可疑文案風險辨識」，不得假裝已有外部合約/網域掃描。

## 實作要求

- 先證明目前 `/api/scam-scan` 實際執行哪些步驟。
- 將 response 增量擴充為：risk_level、triggered_rules、reasons、warnings、evidence、citations、uncertainty、trace_id；保留舊欄位相容。
- deterministic rules 與 LLM/RAG 判斷分開，UI 能看出證據類型。
- LLM 不得聲稱已執行 GMGN、WHOIS、PTT、鏈上掃描，除非真的有可驗證 API response。
- 高風險紅旗至少涵蓋：保證獲利、索取助記詞/私鑰、冒名客服、緊迫匯款；規則需可測試、可解釋。
- 不確定時要顯示 uncertainty，不可硬判低風險。
- 更新 scam UI 最小必要區塊與相關文件；修正「文案」與 `target_address` 資料字典矛盾。

## 文件必查

- `docs/05`、`06`、`08`、`10`、`12`、`13`、`16`
- 任何 GMGN/WHOIS/PTT 三層掃描宣稱

## 測試最低要求

- 四類明確紅旗、一般安全文案、資訊不足、prompt injection、LLM failure、RAG empty。
- 不得因 LLM 失敗把明確高風險規則降為 low。
- UI 防 XSS。
- response backward compatibility。

## 不可做

- 不在本 Task 串 GMGN、WHOIS 或新第三方服務。
- 不把可疑文案檢測改成真實交易安全保證。

## 驗收

答辯時能逐步展示規則、RAG、LLM、證據與不確定性；文件不再失真。完成後停止。
