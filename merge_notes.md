# Merge Notes — 正式版整合紀錄

## Base 版本
以 **77更新版/cip-main** 為主幹進行整合。

## 從舊版/CIP-main 補入的內容
- `docs/` — 4 份設計文件（設計模型、實作模型、資料庫設計、轉圖片說明）
- `scripts/markdown_to_image.py` — Markdown 轉圖片腳本
- `啟動說明.txt` — 專案啟動說明
- `requirements.txt` — 新增 `markdown` 與 `weasyprint` 依賴

## 77更新版 vs 舊版主要差異（77版勝出，全數保留）
- app.py：77版有 import guards（matplotlib/wordcloud try/except）、PTT retry 邏輯、更友善的錯誤訊息、本機模擬交易系統、可設定的幣種數量環境變數
- templates/analysis.html：77版新增 SFI 風險指標圖、BTC 相關性散點圖、蒙特卡洛模擬圖
- templates/ai_coach.html：77版有 8 個快速提問按鈕（舊版僅 2 個）
- static/js/analysis.js：僅存在於 77版（全新檔案）
- static/js/podcast.js：77版新增瀏覽器語音合成備援、更完善的錯誤處理
- static/js/common.js：77版有 `waitForSmartInvestAuth()`、`restoreOriginalSiteIcon()`
- static/js/auth.js：77版有 Supabase session 持久化配置、`ensureReady()` 方法
- static/js/market.js：77版 API timeout 從 12s 延長至 20s
- static/css/common.css：77版新增 analysis page 圖表樣式
- static/css/market.css：77版新增 market page 背景樣式

## 已修復的整合衝突與問題
1. **ai_coach.html 會員 gating**：新增 `member-gate` 遮罩，未登入時隱藏完整 UI
2. **ai_coach.js**：新增 `isLocked` 狀態管理，init 時檢查登入狀態，所有互動入口增加鎖定檢查
3. **ai_coach.css**：新增 `.ai-coach-locked { display: none !important; }`
4. **common.js**：新增 `applyMemberFeatureGating()`，自動為所有 `[data-member-feature]` 元素加上鎖定遮罩
5. **auth.js**：`updateMembership()` 增加 `is-member-locked` body class 切換
6. **.gitignore**：新增 `serviceAccountKey.json`、`data/`、IDE 暫存檔、OS 暫存檔、壓縮檔
7. **requirements.txt**：補入 `markdown`、`weasyprint`

## 權限規則確認
- **公開頁面**：首頁 `/`、市場 `/market`、分析 `/analysis/<symbol>`、社群 `/social-sentiment`、敘事 `/narrative-radar`、防詐 `/scam-detect`、Podcast `/podcast`
- **會員限定**：健康度 `/health`、AI 教練 `/ai-coach`、模擬交易 `/sim-trade`、會員中心 `/member`
- **訪客模式**：可瀏覽公開頁面與使用 Podcast；AI 教練、健康度、模擬交易有鎖定遮罩，點擊會彈出登入提示
- 所有會員限定 API 路由已加上 `@token_required`，未登入時回傳 401

## 複評文件補強 (2026-07-09)

### 新增文件
- `docs/05-商業模式與競品分析.md` — 成本量化、三層定價、競品比較、MVP vs 完整版
- `docs/10-評審建議修正對照表.md` — 31 項評審意見逐項對照、修正狀態
- `docs/11-複評口頭答辯重點.md` — 10 題常見評審提問 + 建議回答 + 展示路徑
- `docs/12-AI風險控管與回測方法.md` — SFI 公式、詐騙三層檢測、Agent I-P-O、回測框架
- `docs/13-系統流程總覽.md` — 8 個完整流程圖（登入/會員/交易/風險/詐騙/Agent/Podcast/爬蟲）
- `templates/partials/footer.html` — 免責聲明 footer partial

### 重寫文件
- `docs/06-設計模型.md` — 分析 vs 設計類別圖區分、UML visibility 說明、分層架構、元件圖、3 個循序圖
- `docs/07-實作模型.md` — 完整技術棧、模組實作細節、API 總覽、資料清洗流程、套件圖、容錯表
- `docs/08-資料庫設計.md` — 從 13 表擴至 22+ 表、完整 ER 圖、資料字典、sim 情境設計、RLS 策略

### 程式修正
- `app.py` Config 新增 `SIM_STRATEGY_PRESETS`（保守/穩健/積極）與 `MARKET_SCENARIOS`（牛市/熊市/黑天鵝）

## 已知風險
1. **外部服務依賴**：Supabase、OpenAI API、CoinGecko API 需要有效的 API key 才能完整運作
2. **Supabase 未配置時**：登入/註冊功能無法使用，但 Demo 會員（test@smartinvest.local / Test123456）仍可本機測試
3. **OpenAI API key 未設定時**：AI 教練、AI Agent、Podcast TTS 會顯示友善提示而非崩潰
4. **matplotlib/wordcloud 未安裝時**：有 try/except guards，分析頁面圖表會顯示空狀態
5. **訂閱/金流系統**：目前為文件設計層級，MVP 以 Demo 會員模式替代
6. **策略回測**：回測框架已設計但尚未執行歷史數據回測
7. **footer 免責聲明**：已建立 partial，各頁面引用待補
