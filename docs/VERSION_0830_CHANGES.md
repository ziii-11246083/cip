# 0830 與 0727 版本差異（教授 Demo 版）

> 比較基準：`origin/0727`（`ca7fa7d`）與 `0830` 分支。本文件只列可由程式、測試或文件證明的差異。

## 一句話定位

- 0727 已有市場資訊、AI 教練、初版 RAG、Agent、健康度、可疑文案辨識與模擬交易。
- 0830 沒有推翻這些核心流程，而是新增「可追溯、可評測、可重現」能力，修正登入與版型問題，並移除會讓人誤以為金流或同步已完成的 Demo 假功能。

## 教授先看：0830 的 10 個主要差異

### 1. RAG 回答從「有回答」升級為「可追來源」

- 0727：已有初版 RAG retrieval，但難以確認某次回答實際用了哪些資料。
- 0830：每次支援的 AI 回答可產生 `trace_id`，記錄模型、延遲、token、狀態、降級原因與實際注入來源。
- 0830：AI 教練可顯示 citation 與 confidence；無來源或低信心時會明確提示。
- Demo 說法：回答現在「可追溯」，不是只看 AI 最後講了什麼。

### 2. RAG 品質從「憑感覺」升級為「可量測」

- 0727：沒有完整的版本化評測流程與 regression gate。
- 0830：新增 15 題離線資料集、deterministic evaluator、JSON／Markdown artifact、baseline 與退步判定契約。
- 0830：新增回答 👍／👎 feedback 流程；正式寫入需要真實 Supabase 使用者與已部署 migration。
- 重要限制：15 題仍待人工審核與核准 baseline，因此只能說「可評測、可防退步」，不能說「已證明很準」。

### 3. RAG 管理功能補上權限與錯誤保護

- 0727：RAG stats、eval、rebuild 的管理邊界不足。
- 0830：公開 stats 只回 aggregate；詳細資料、eval 與 rebuild 改由可信任的 admin metadata 控制。
- 0830：rebuild 加入鎖定與固定錯誤碼，避免例外、query 或敏感資料直接出現在回應與 log。

### 4. 可疑投資文案辨識更結構化、更誠實

- 0727：已有規則、RAG 與 LLM 判斷，但結果較偏單一報告，provider 例外也可能被直接帶到回應。
- 0830：新增 deterministic risk floor，不讓明顯的「保證獲利、索取助記詞」被模型判成較低風險。
- 0830：回傳 `reasons`、`warnings`、`evidence`、`uncertainty`、citation 與 trace，錯誤改為固定安全內容。
- Demo 說法：這是「可疑投資文案風險辨識」，不是網域、合約、GMGN、WHOIS 或鏈上掃描器。

### 5. 新增獨立的情境壓力測試

- 0727：已有虛擬下單、持倉與資金紀錄。
- 0830：額外新增 3 種策略、4 種情境（normal／bull／bear／black_swan）與固定 seed 的可重現壓力測試。
- 0830：壓力測試使用獨立 snapshot 純計算，不會改寫既有模擬交易帳本。
- Demo 說法：這是「合成情境壓力測試」，不是歷史回測、價格預測或投資建議。

### 6. 新增公開錢包唯讀資產同步 Beta 基礎

- 0727：會員資產主要來自模擬交易資料，另有會回傳 Demo 同步成功的假 external-sync route。
- 0830：新增公開 Ethereum 地址唯讀 adapter、獨立 real/manual/simulated 資料來源、partial／last-good／idempotency／lock 契約與會員 UI 分區。
- 0830：不要求私鑰或助記詞，也不把真實資產寫入模擬持倉。
- 重要限制：目前是 code/migration-ready Beta；必須先部署 Supabase migration、設定 Alchemy 與權限才可展示成功。尚未串交易所 API、付費 entitlement 或自動 scheduler。

### 7. 移除會誤導成「已完成」的 Demo 假功能

- 0727 的 mock checkout 會直接回覆付款完成，Demo subscription 會直接顯示 Premium。
- 0727 的 external sync 可在沒有真實 provider 時回覆本機 Demo 同步成功。
- 0727 另有只回空資料或 fallback 的 notifications／health reports route。
- 0830 移除上述誤導性 route，不再把規劃中的訂閱、金流、同步、通知或報告保存說成已上線。
- Demo 說法：這不是功能倒退，而是把「已完成、部分完成、尚未完成」分清楚。

### 8. 修正登入後切換功能會掉回未登入

- 0727：Demo 登入可能被 Supabase 初始化的空 session 事件覆寫；AI 教練同頁登入後也可能仍停在會員提示。
- 0830：保護有效 Demo session；真正 Supabase session 到達時仍會正確接管。
- 0830：AI 教練監聽共用 auth state，不重新整理即可解鎖。
- 0830：Demo user 不再查寫需要 UUID 的正式 conversation tables，避免錯誤 log 與測試資料污染。

### 9. 修正 AI 教練與手機版顯示問題

- 0830：AI 教練未登入提示卡在桌機版跨欄置中，不再擠在左側並留下大片空白。
- 0830：登入後維持原本聊天雙欄，不改 `/api/ai-chat` 核心 contract。
- 0830：390px 手機版模擬交易 grid 可正常縮小，不再造成整頁水平捲動。

### 10. 補齊測試、安全與交接證據

- 0830：新增 RAG trace、feedback、eval、admin、資產同步、壓力測試、登入與前端顯示等回歸測試。
- 0830：移除 Git 追蹤中的 service account 檔、Python cache 與本機模擬資料，`.env` 與金鑰不得提交。
- 0830：新增功能一致性矩陣、複評證據包、版本差異與 Demo 測試文件。
- 最新完整驗證：pytest 287 項加 43 個 subtests、unittest 287 項、AI Coach Node 25/25、Auth Node 3/3、三組 validator 70/108/28，皆通過。

## 0727 已有、0830 保留且強化的核心流程

- 市場首頁、行情、幣種分析、社群情緒與 Narrative Radar。
- AI 投資教練、對話、初版 RAG、Agent、Podcast、健康度與可疑文案辨識。
- 模擬交易下單、持倉、紀錄、入金、資本額與重設流程。
- 0830 沒有為了整理架構而重寫以上核心流程，也沒有把壓力測試結果寫回交易帳本。

## 0830 仍未完成，Demo 不可講成已上線

- RAG 人工核准的 accuracy baseline 尚未完成，不能宣稱準確率已被證明。
- Supabase migrations 尚需在目標專案實際部署與做 RLS integration test。
- 公開錢包同步仍是 Ethereum 單鏈唯讀 Beta；交易所 API、多鏈與自動排程尚未完成。
- 付費訂閱、Stripe 金流、正式 entitlement 與實際營收尚未完成。
- 可疑文案辨識沒有做網站、合約或鏈上安全驗證。
- 情境壓力測試不是歷史回測、預測或實盤交易。

## 建議教授問答的一句話版本

- 問「0830 最大進步是什麼？」：從功能可跑，提升到回答可追溯、品質可評測、結果可重現，並把登入與展示穩定性補好。
- 問「RAG 現在準嗎？」：現在能記錄來源、接受回饋並用固定資料集比較版本；人工 baseline 尚未核准，所以不誇大準確率。
- 問「有自動同步資產嗎？」：已有公開 Ethereum 地址唯讀 Beta 與資料契約；交易所、自動排程與正式部署仍是下一階段。
- 問「有付費會員嗎？」：目前完成商業模型與技術規劃，沒有假裝 Stripe 或訂閱已上線。
- 問「為什麼刪掉一些 API？」：0727 有些 route 只會回 Demo 成功；0830 移除假完成，讓展示與實際能力一致。
