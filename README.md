# Smart Invest Crypto

加密資產研究與風險教育平台，整合市場資訊、AI 投資教練、RAG 引用與回饋、可疑文案辨識、投資組合健康度、模擬交易及情境壓力測試。

## 0830 Demo 版

本分支為 `0830`。相對 `0727` 版本，主要差異如下：

- 0727 已有的市場、AI 教練、初版 RAG、Agent、健康度與模擬交易核心流程全部保留。
- RAG 新增 trace、citation、confidence、feedback、15 題離線評測與 regression contract，從「有回答」提升為「可追溯、可量測」。
- 可疑投資文案辨識新增固定高風險下限與 reasons／warnings／evidence／uncertainty 結構化結果。
- 模擬交易新增 3 策略、4 情境、固定 seed 的獨立壓力測試，不改寫既有帳本。
- 新增公開 Ethereum 地址唯讀資產同步 Beta 基礎；交易所 API、自動排程與正式付費 entitlement 尚未完成。
- 移除 0727 會直接回覆付款、Premium 或 external sync 成功的 Demo 假 route，避免把規劃功能說成已上線。
- 修正 Demo 登入跨頁失效、AI 教練同頁登入未解鎖、未登入版型偏左與 390px 手機橫向溢出。
- 補齊安全、回歸測試、功能狀態矩陣與明日教授 Demo 文件。

詳細內容：

- [0830 與 0727 版本差異（教授 Demo 版）](docs/VERSION_0830_CHANGES.md)
- [0830 教授 Demo 與測試清單](docs/DEMO_AND_TEST_GUIDE_0830.md)
- [功能、Route、資料與完成狀態矩陣](docs/18-系統功能與資料一致性矩陣.md)
- [複評證據包與答辯紅線](docs/19-複評證據包.md)

## 本機啟動

建議使用 Python 3.12：

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run_local.py
```

瀏覽器開啟：`http://127.0.0.1:5000`

本機 Demo 會員：

- Email：`test@smartinvest.local`
- Password：`Test123456`

Demo 會員只供本機展示，不等於真實 Supabase 使用者、付費會員或正式權限。
Demo 對話不寫入正式 Supabase conversation UUID 表；重新整理後不保留 Demo 對話紀錄。

## 環境變數

請在本機 `.env` 設定，不要把金鑰提交到 Git：

```dotenv
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini
OPENAI_MODEL_AGENT=gpt-4o-mini
OPENAI_MODEL_PORTFOLIO=gpt-4o-mini
CG_API_KEY=your_coingecko_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_publishable_or_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_server_only_service_role_key
RAG_TRACE_HMAC_SECRET=at_least_32_random_bytes
```

`SUPABASE_SERVICE_ROLE_KEY` 與 `RAG_TRACE_HMAC_SECRET` 只能留在伺服器端；不可放入前端、文件、截圖或 GitHub。缺少外部服務設定時，部分功能會以固定錯誤或降級內容運作，詳見操作手冊。

## 重要邊界

- RAG 已有 trace、citation、feedback、離線評測與 regression gate，但 15 題資料集仍待人工審核，不能宣稱「已證明很準」。
- 公開錢包同步目前是 Ethereum Mainnet、唯讀、Beta code/migration；不收助記詞或私鑰，也尚未完成交易所串接與自動排程。
- 模擬交易不會送出真實交易；情境壓力測試是固定 seed 的合成情境，不是歷史回測或價格預測。
- 訂閱、Stripe 金流與正式付費 entitlement 仍是規劃項目，不可在 Demo 中說成已上線。

## 測試入口

```bash
python -m pytest -q
node tests/test_ai_coach_frontend.test.js
node tests/test_auth_frontend.test.js
python scripts/validate_rag_trace_migration.py
python scripts/validate_asset_sync_migration.py
python scripts/validate_asset_sync_mvp.py
```

完整人工驗收順序與預期結果請直接照 [0830 測試與 Demo 操作手冊](docs/DEMO_AND_TEST_GUIDE_0830.md) 執行。
