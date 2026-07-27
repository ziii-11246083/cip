# Smart Invest Crypto - 2026/07/27 修正紀錄

本次修正主要針對初評評審意見進行補強，除 GitHub 活動度紀錄外，其餘問題皆已補到文件、程式或 MVP 展示流程。

## 主要修正

### 1. 商業模式與會員制

- 新增會員方案 API：`/api/membership/plans`
- 新增訂閱狀態 API：`/api/membership/subscription`
- 新增 mock checkout API：`/api/membership/mock-checkout`
- 會員中心新增「目前訂閱狀態」與「會員方案」區塊
- 新增管理員 Demo 帳號，預設為專業版會員：
  - Email: `admin@smartinvest.local`
  - Password: `Admin123456`
- 真實第三方金流仍列為 Phase 2，MVP 先保留付款紀錄與訂閱資料流程

### 2. 模擬交易多情境

- 模擬交易支援六種市場情境：
  - 一般市場
  - 盤整市場
  - 牛市
  - 山寨輪動
  - 熊市
  - 黑天鵝
- 情境會影響持倉估值與本次模擬下單價格
- 新增壓力測試摘要：
  - 情境總資產
  - 現金緩衝
  - 本次下單影響
  - 情境風險提醒

### 3. RAG 與 AI 差異化

- 強化 RAG 檢索流程，不再只是把問題直接丟給 GPT
- 新增中文 BM25 tokenizer fallback
- 新增 endpoint topic prior 與 query router 強化
- 補穩定幣、投資原則、單日買賣時機等 domain knowledge
- RAG 評估腳本可執行：`scripts/eval_rag.py`
- 最近一次評估結果：
  - MRR: `0.8056`
  - Recall@5: `0.8333`
  - Cases: `15/15`

### 4. 資料庫與資料紀錄

- 補會員、訂閱、付款、通知、健康度報告、詐騙掃描、市場敘事、外部同步等資料表設計
- `supabase_client.py` 新增對應 CRUD 方法
- 健康度報告、詐騙掃描、市場敘事分析皆可保存資料紀錄
- Supabase 未設定時，MVP 會使用 demo / fallback 流程展示

### 5. 爬蟲資料清洗

- 新增社群與新聞資料清洗流程
- 加入文字正規化、去重、來源驗證狀態
- 移除原本隨機產生的推文數與隨機情緒
- 改用 deterministic 關鍵字規則判斷初步情緒

### 6. 外部同步

- 新增手動同步 API：`/api/external-sync/manual`
- 新增外部帳戶查詢 API：`/api/external-sync/accounts`
- 目前 MVP 採手動同步，真實交易所 API 自動同步列為 Phase 2

### 7. 文件補強

- `docs/05-商業模式與競品分析.md`
- `docs/08-資料庫設計.md`
- `docs/10-評審建議修正對照表.md`
- `docs/11-複評口頭答辯重點.md`
- `docs/13-系統流程總覽.md`
- `docs/17-RAG精準化升級與評估.md`

## 本地啟動

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run_local.py
```

開啟：

```text
http://127.0.0.1:5000
```

## 測試帳號

一般會員：

```text
test@smartinvest.local
Test123456
```

管理員 / 專業版：

```text
admin@smartinvest.local
Admin123456
```

## 驗證項目

已確認以下頁面與 API 可正常回應：

- `/member`
- `/sim-trade`
- `/api/membership/plans`
- `/api/market-scenarios`
- `/api/rag/stats`

語法檢查：

```powershell
python -m py_compile app.py supabase_client.py services\bm25_service.py services\rag_service.py services\query_router_service.py scripts\eval_rag.py
node --check static\js\member.js
node --check static\js\sim_trade.js
node --check static\js\auth.js
```

RAG 評估：

```powershell
python scripts\eval_rag.py --cases eval\rag_eval_cases.jsonl
```

## 尚未處理

- 第 15 點 GitHub 活動度需由組員實際補 commit / push 紀錄
- 真實第三方金流串接列為 Phase 2
- 真實交易所 API 自動同步列為 Phase 2
