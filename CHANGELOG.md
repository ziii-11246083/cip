# CHANGELOG — Smart Invest Crypto

## 2026-07-09: Hybrid AI Architecture & RAG MVP

### AI 架構整理
將原本「所有 AI 功能都直接呼叫 GPT」的扁平架構，重構為五層 **Hybrid AI Architecture**：
1. **Rule-based Layer** — SFI 風險、FOMO 檢測、技術指標（不改動）
2. **Quantitative Layer** — 健康度數值、模擬交易損益、權益曲線（不改動）
3. **RAG Layer** — 關鍵字檢索 + 知識庫注入（本次新增）
4. **LLM Layer** — GPT-4o-mini 對話/腳本/分析（既有，新增 RAG context）
5. **Agent Orchestration Layer** — Agent Plan 生成（既有，新增 RAG context）

### 新增 RAG 基礎設施
- `services/knowledge_base.py` — 本地 Markdown/JSON 知識庫載入器
- `services/retrieval_service.py` — 關鍵字檢索抽象層（預留 embedding/vector DB 介面）
- `services/prompt_builder.py` — 結構化 Prompt 組裝器（system + RAG context + user context + citations）
- `services/ai_guardrails.py` — 輸入/輸出安全過濾（禁止保證獲利、報明牌、槓桿、prompt injection）
- `services/rag_service.py` — RAG 總管，統一 retrieval → prompt building → fallback 流程

### 新增知識庫（7 個檔案）
- `data/knowledge/investment_rules.md` — 分散配置 / 風控 / FOMO / 停損停利 / DCA / 情境應對
- `data/knowledge/risk_health_guide.md` — 健康度指標解讀 / 保守穩健積極配置原則
- `data/knowledge/scam_patterns.md` — 8 種常見加密詐騙模式 + 檢測建議
- `data/knowledge/coin_profiles.json` — BTC/ETH/SOL/XRP/BNB/DOGE/USDT/USDC 結構化資料
- `data/knowledge/market_narratives.md` — 7 大敘事分類（AI/RWA/Meme/L2/DeFi/Stablecoin/Exchange）
- `data/knowledge/podcast_style_guide.md` — Nova/Onyx 角色分工 + 開場結尾框架 + 禁止語句
- `data/knowledge/scenario_playbooks.md` — Normal/Bull/Bear/BlackSwan 四情境 playbook

### 哪些功能已接上 RAG
1. **`/api/ai-chat`** — 對話前檢索投資原則/市場情境/敘事知識，注入 system prompt
2. **`/api/agent-plan`** — 計畫生成前檢索投資原則/情境 playbook/健康度指南
3. **`/podcast/generate`** — 腳本生成前檢索 Podcast 風格指南/市場敘事/情境 playbook
4. **`/api/scam-scan`** — 核心邏輯不變，額外檢索 scam_patterns.md 作為案例補充
5. **`/portfolio/analyze-llm`** — 數值計算不變，文字生成前檢索健康度指南/投資原則

### 哪些功能刻意不接 RAG（理由）
| 功能 | 理由 |
|------|------|
| SFI 風險計算 | Deterministic Copula 公式，不需 LLM/RAG |
| FOMO 檢測 | 純數值閾值判斷（漲跌幅 > 20%），不需 LLM/RAG |
| 技術指標計算 | 數學公式（Beta/波動/回撤），不需 LLM/RAG |
| 模擬交易成交邏輯 | 金融交易邏輯，必須 deterministic |
| 持倉/PnL/權益曲線 | 純數值運算，不可被 AI 污染 |

### ML / DL 架構準備
- `models/sentiment/` — 目錄就緒，預留 FinBERT/multilingual-BERT 規劃
- `models/scam_classifier/` — 目錄 + `schema.json` 就緒，預留 TF-IDF+XGBoost/BERT fine-tune 規劃
- `models/regime_detection/` — 目錄 + `schema.json` 就緒，預留 LSTM/TFT/HMM 規劃
- `eval/` — 評估目錄 + `README.md`，定義評估資料格式與指標
- `models/README.md` — ML/DL 整體規劃說明

### 新增文件
- `docs/14-RAG設計與導入規劃.md` — RAG 適用性分析 + 架構 + 升級路徑
- `docs/15-AI系統總架構.md` — 完整五層 Hybrid AI 架構
- `docs/16-模型與資料流說明.md` — 所有 AI 功能的輸入→處理→輸出資料流

### 目前限制與下一步
1. **檢索方式**：MVP 使用關鍵字匹配，尚未導入 embedding/向量檢索
2. **知識庫**：本地 Markdown 檔案，尚未版本化或自動更新
3. **ML 模型**：全部停留在 architecture-ready，尚未訓練
4. **回測**：框架已設計，歷史數據回測待 Phase 2
5. **Embedding pipeline**：尚未實作，預留 `RetrievalService` 抽象介面供未來升級
6. **Usage tracking**：尚未記錄 RAG retrieval 的 hit rate 與 latency

### Phase 2 規劃
- 向量資料庫（ChromaDB/Pinecone）+ embeddings（text-embedding-3-small）
- 知識庫自動更新 pipeline（爬蟲 → 清洗 → chunk → embed → upsert）
- 訓練 scam_classifier + regime_detection 第一版模型
- RAG retrieval hit-rate 監控 + A/B 測試
