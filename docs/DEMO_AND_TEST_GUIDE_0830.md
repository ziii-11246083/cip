# 0830 教授 Demo 與測試清單（相對 0727）

> 原則：明天先完成「Demo 前 10 項必測」，現場照「8 分鐘展示順序」。任何條件式功能若環境未就緒，就展示契約與證據，不做假成功。

## 一、Demo 前 10 項必測

- [ ] **1. 首頁與版本**
  - 開啟 `http://127.0.0.1:5000`，確認首頁正常顯示。
  - 開啟本文件與 `docs/VERSION_0830_CHANGES.md`，確認比較基準寫的是 0727，不是 08/20。
  - 預期：頁面 HTTP 200，文件可直接照著講。

- [ ] **2. AI 教練未登入版型**
  - 開啟 `/ai-coach`，保持未登入。
  - 預期：會員提示卡在桌機版置中，右側沒有像跑版的大片空欄；聊天區保持鎖定。
  - 0830 差異：修正未登入時沿用雙欄造成的偏左跑版。

- [ ] **3. 同頁登入立即解鎖**
  - 在 `/ai-coach` 使用 Demo 帳號 `test@smartinvest.local`／`Test123456` 登入。
  - 不重新整理頁面。
  - 預期：會員提示消失，輸入區與對話區立即出現。
  - 0830 差異：AI 教練開始監聽共用登入狀態。

- [ ] **4. 跨頁登入不消失**
  - 登入後依序開 `/health` → `/sim-trade` → `/member` → `/agent` → `/market` → `/ai-coach`。
  - 每頁停留數秒再切換。
  - 預期：所有頁面都維持登入，不重新要求帳密；只有主動登出才重新鎖定。
  - 0830 差異：Supabase 空 session 不再覆寫有效 Demo session。

- [ ] **5. AI 教練與 RAG 顯示**
  - 提問：「我只有 10 萬元，BTC 部位風險怎麼控制？」
  - 預期：回答可讀；有實際注入來源時可展開 citation 與 confidence；無來源或低信心時明確提示。
  - 預期：失敗時只顯示固定安全內容，不顯示 provider exception、traceback 或 API key。
  - 0830 差異：回答新增 trace、citation、confidence 與安全降級紀錄。

- [ ] **6. 可疑投資文案辨識**
  - 在 `/scam-detect` 輸入：「保證每天獲利 10%，把助記詞傳給客服立即入金。」
  - 預期：至少 high risk，並顯示原因、警示、證據與不確定性。
  - 預期：畫面清楚說明沒有做網域、合約或鏈上掃描。
  - 0830 差異：deterministic risk floor 與結構化安全結果。

- [ ] **7. 模擬交易核心流程不受影響**
  - 在 `/sim-trade` 查看資金、建立一筆小額虛擬訂單並查看紀錄。
  - 預期：虛擬持倉與紀錄一致；不會送出真實交易，也不會改到真實資產區。
  - 版本重點：0727 既有流程保留，0830 沒有大重構。

- [ ] **8. 情境壓力測試**
  - 使用同一組 snapshot、期間與 seed 重跑相同策略／情境。
  - 預期：結果一致；可切換 3 種策略與 4 種情境。
  - 預期：測試前後模擬交易帳本不變。
  - 0830 差異：新增可重現的合成壓力測試。

- [ ] **9. 390px 手機顯示**
  - 將瀏覽器調成 390 × 844，檢查 `/sim-trade` 與 `/ai-coach`。
  - 預期：整頁沒有水平捲動；情境按鈕、輸入欄、登入與送出按鈕都可操作。
  - 0830 差異：修正模擬交易 grid 橫向溢出與 AI 教練 gate 排版。

- [ ] **10. 登出與敏感資料**
  - 主動登出後切換會員頁面。
  - 預期：功能重新鎖定，Demo 對話不會寫入正式 Supabase UUID tables。
  - 確認 Git、畫面、終端與截圖沒有 `.env`、API key、service-role key、JWT、私鑰或助記詞。

## 二、需要特定環境才測的項目

- **RAG feedback 寫入**
  - 條件：已部署 RAG trace migration，並使用真實 Supabase 測試會員與該會員自己的 `trace_id`。
  - 預期：👍／👎 一次只送一個 request；成功後標記 active，失敗時回答保留且可重試。
  - Demo 帳號預期 fail closed，不應假裝寫入成功。

- **公開 Ethereum 錢包同步 Beta**
  - 條件：已部署兩份 asset-sync migration、正確設定 Supabase／Alchemy、開啟 Beta entitlement。
  - 預期：只輸入公開地址，不收私鑰或助記詞；能分辨 success、partial、last-good 與錯誤。
  - 若條件未齊：只展示會員中心分區、資料契約與測試證據，不點出「同步成功」。

- **RAG 管理功能**
  - 條件：真實 Supabase 使用者的可信任 `app_metadata` 具 admin 權限。
  - 預期：一般使用者只能看 aggregate stats；details、eval、rebuild 對非 admin fail closed。

## 三、建議 8 分鐘教授 Demo 順序

- **0:00–0:50｜先講 0727 與 0830 差異**
  - 開 `docs/VERSION_0830_CHANGES.md`。
  - 說：「0727 已有核心 AI 與模擬交易；0830 的重點是讓 AI 可追溯、品質可評測、壓力結果可重現，並修好登入與顯示。」

- **0:50–1:50｜展示登入穩定性**
  - 從 `/ai-coach` 未登入置中畫面開始。
  - 同頁登入、不重新整理，切到 `/health`、`/member` 再回 `/ai-coach`。
  - 說：「0727 可能被空 session 蓋掉；0830 登入狀態跨頁保持一致。」

- **1:50–3:00｜展示 AI 教練與 RAG 證據**
  - 問一題風險控制問題，展開 citation／confidence 或無來源提示。
  - 說：「0830 能知道答案用了什麼來源，也能記錄 latency、fallback 與品質回饋。」
  - 補充：「15 題 evaluator 已建立，但人工 baseline 尚未核准，所以不誇大準確率。」

- **3:00–4:00｜展示可疑文案辨識**
  - 輸入「保證每天 10% 並要求助記詞」。
  - 指出 risk、reasons、warnings、evidence、uncertainty。
  - 說：「0830 會保住明顯高風險下限，但這是文案辨識，不是鏈上掃描。」

- **4:00–5:20｜展示模擬交易與新壓力測試**
  - 快速展示既有虛擬持倉，再跑一組 black_swan。
  - 用同 seed 重跑，指出結果一致且帳本不變。
  - 說：「0727 有模擬交易；0830 新增的是獨立、可重現的合成情境測試。」

- **5:20–6:10｜展示公開錢包同步方向**
  - 開 `/member` 的真實資產分區。
  - 若環境已就緒才輸入公開 Ethereum 地址；否則展示 disabled／文件狀態。
  - 說：「目前是唯讀單鏈 Beta，與模擬資產分開；交易所與自動排程仍未完成。」

- **6:10–7:05｜解釋為什麼移除假功能**
  - 說明 0727 的 mock checkout、Demo Premium 與假 external sync 會直接回成功。
  - 說：「0830 把這些移除，避免把規劃中的金流與同步誤講成已上線。」

- **7:05–8:00｜用測試與 Git 收尾**
  - 開 GitHub `0830` 分支與下方自動化測試摘要。
  - 說：「核心流程不是只靠現場點過；登入、RAG、安全、資產契約、壓力測試與手機版都有回歸測試。」

## 四、最新自動化驗證結果

- Python pytest：287 項通過，另含 43 個 subtests，process exit 0。
- Python unittest discovery：287 項通過。
- AI Coach 前端 Node 測試：25/25 通過。
- Auth 前端 Node 測試：3/3 通過。
- RAG trace migration validator：70/70 通過。
- Asset sync migration validator：108/108 通過。
- Asset sync MVP validator：28/28 通過。
- 本機 HTTP smoke：14/14 頁面／endpoint 通過。
- Browser：AI 教練同頁登入、6 頁跨頁登入、390px 手機版 overflow 均通過。

## 五、教授現場不可宣稱事項

- 不說「RAG 已經很準」；說「已可追溯、可評測、可做 regression 比較」。
- 不說「已接交易所自動同步」；說「公開 Ethereum 地址唯讀 Beta，交易所與排程待做」。
- 不說「已有付費會員或 Stripe」；說「商業模型與技術規劃已整理，runtime 尚未上線」。
- 不說「詐騙偵測能驗證網站或鏈上安全」；說「可疑投資文案風險辨識」。
- 不說「壓力測試是歷史回測或預測」；說「固定 seed 的合成情境」。
- 不展示、口述或提交任何 API key、service-role key、JWT、私鑰或助記詞。

## 六、問題回報格式

- 版本／分支：`0830` + commit SHA。
- 頁面與功能：例如 `/ai-coach` 登入。
- 身分：未登入／Demo／真實測試會員。
- 裝置與視窗：例如 Chrome 390 × 844。
- 操作步驟：逐步列出。
- 預期結果與實際結果：分開寫。
- HTTP 狀態／固定錯誤碼：若有再附。
- 是否可重現：每次／偶發／一次。
- 截圖或錄影：先遮掉個資與所有 secret。
