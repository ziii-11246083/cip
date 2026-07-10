# 第 17 章 RAG 精準化升級與評估（Phase 2A）

> 從 keyword-based RAG MVP 升級為 hybrid retrieval pipeline，提升檢索精準度、回答可信度與系統可觀測性。

## 17-1 升級總覽

### 從什麼 → 到什麼

| 維度 | MVP（Phase 1） | Phase 2A（本次） |
|------|---------------|-----------------|
| Chunking | `\n\n` 分段，無 overlap | Semantic chunking（H1/H2/H3 + 段落 + 列表） + 15% overlap |
| 檢索 | Keyword term-count | BM25 (sparse) + Dense embeddings + RRF fusion |
| Query 處理 | 原始 query 直接搜 | Router → Rewrite/expansion + similarity guard |
| 排序 | Raw keyword score | RRF fusion + lightweight reranker |
| 向量儲存 | 無 | ChromaDB persistent local |
| JSON 知識 | coin_profile() 直接查詢 | 納入 chunk pipeline，可被 retrieval 命中 |
| Fallback | keyword → empty | Dense → Sparse → Keyword (full chain) |
| 可觀測性 | 無 | Per-call metrics (route/latency/hits/fallback) |
| 評估 | 無 | 15 cases + eval script (P@K/Recall@K/MRR/NDCG) |
| 回答紀律 | 無特殊處理 | Confidence note + fallback wording + 資料不足提示 |

### 受影響的 endpoint（5 個）

| Endpoint | RAG 模式 | 升級內容 |
|----------|---------|---------|
| `/api/ai-chat` | 主要 RAG | Hybrid retrieval + routing + confidence note |
| `/api/agent-plan` | 主要 RAG | Deep path（強制 deep route） + 更多 chunks |
| `/podcast/generate` | 風格 RAG | Fast path（延遲敏感） |
| `/api/scam-scan` | 補充 RAG | Fast path + scam topic prior |
| `/portfolio/analyze-llm` | 補充 RAG | Deep path（分析需求複雜） |

---

## 17-2 Semantic Chunking 做法

### Markdown 檔案

1. **標題識別**：正則匹配 `^#{1,3}\s+(.+)$`，以 H1/H2/H3 為主要 section 邊界
2. **段落分割**：section body 以 `\n\n+` 分割為段落
3. **長段落處理**：若單一段落超過 ~1200 chars，以 `\n` 為邊界再拆分
4. **Overlap**：每個 chunk 取前一個 chunk 的最後 15% 內容作為重疊區
5. **最小過濾**：少於 80 chars 的 section 若無內容則跳過

### JSON 檔案

- `coin_profiles.json`：每個幣種（BTC/ETH/SOL...）為一個 chunk
- 展平格式：`key: value` + list items 以 `, ` 串接
- Metadata 標記 `doc_type: json`

### Metadata 結構

```json
{
  "chunk_id": "investment_rules#3",
  "content": "## 不追高原則（FOMO 控制）\n- 24小時內漲幅超過20%...",
  "doc_id": "investment_rules",
  "source": "data/knowledge/investment_rules.md",
  "topic": "投資原則",
  "section": "不追高原則（FOMO 控制）",
  "chunk_index": 3,
  "doc_type": "markdown",
  "last_updated": "2026-07-09",
  "content_hash": "a1b2c3d4e5f6g7h8"
}
```

---

## 17-3 Hybrid Retrieval 做法

### Sparse Retrieval（BM25）

- 使用 `rank-bm25` 套件的 `BM25Okapi`
- 中文分詞：`jieba`（若未安裝則用 regex `[\w一-鿿]+`）
- 中英文 stop words 過濾
- Fallback：若 `rank-bm25` 不可用 → 內部 BM25-like TF-IDF（含 IDF + BM25 scoring formula）

### Dense Retrieval（Embeddings）

- Embedding model：`text-embedding-3-small`（1536 dims）
- Vector store：ChromaDB persistent（`data/vector_store/`）
- 支援 topic filter（`where={"topic": {"$in": [...]}}`）
- Content-hash cache：相同內容不重複呼叫 API

### RRF Fusion（Reciprocal Rank Fusion）

```
RRF_score(chunk) = Σ (1 / (k + rank_i + 1)) × weight_i
```

- `k = 60`（configurable via `RAG_RRF_K`）
- `dense_weight = 0.5`, `sparse_weight = 0.5`（configurable）
- 最終 score normalized to [0, 1]

### Reranker（Lightweight）

預設使用輕量級 reranker，不依賴任何大型模型下載：

1. **Base score**：RRF fusion score
2. **Lexical overlap bonus**（+0~0.2）：query terms 與 chunk content 的 Jaccard overlap
3. **Metadata boost**（+0~0.15）：若 query 含有 scam/health/market/investment 關鍵詞，boost 對應 topic 的 chunks
4. **Heading match bonus**（+0~0.1）：query terms 出現在 section heading 中加分

可選 backend：cross-encoder（需設定 `RAG_RERANK_CROSS_ENCODER_MODEL` 環境變數，預設不啟用）

---

## 17-4 Query Rewrite Guard 怎麼做

### Rule-based Expansion（預設，always safe）

1. **Alias expansion**：BTC → bitcoin, 比特幣；AI → 人工智慧, FET, RNDR
2. **Topic synonym expansion**：詐騙 → 騙局, scam, honeypot, rug pull
3. **Domain lexicon expansion**：DCA → 定期定額, 分批進場
4. **Endpoint-specific expansion**：chat/scam/podcast/health/agent 各有對應的 regex 模式

### Embedding Similarity Guard

- 將 original query 與 expanded/rewritten query 分別做 embedding
- 計算 cosine similarity
- 若 similarity < `RAG_REWRITE_SIM_THRESHOLD`（預設 0.6）→ 捨棄 rewrite，使用原 query
- 若 embeddings 不可用 → 用 character bigram Jaccard similarity 作為 fallback

### LLM Rewrite（Optional，預設關閉）

- 需設定 `RAG_ENABLE_LLM_REWRITE=1` 才啟用
- 使用 GPT-4o-mini 做 query rewrite
- 同樣受 similarity guard 保護

### 記錄

每次 rewrite 皆記錄：
- `rewrite_used`: bool
- `rewrite_rejected`: bool
- `rewrite_similarity`: float
- `method`: "rule" / "llm" / "none" / "rule_rejected" / "llm_rejected"

---

## 17-5 Strategy Router 設計

### Fast Path（預設）

- **觸發條件**：query 短於 50 chars、complexity < 0.4、entity < 3、無 multi-intent markers
- **流程**：Query → Hybrid Retrieval（skip rewrite, skip rerank）
- **適用 endpoint**：scam, podcast（延遲敏感）

### Deep Path

- **觸發條件**：complexity >= 0.4、entity >= 3、含 multi-intent markers、或 endpoint 為 health/agent
- **流程**：Query → Rewrite → Hybrid Retrieval → Rerank
- **適用 endpoint**：health, agent（分析需求複雜）

### Complexity 計算（heuristic）

- Query 長度（0~0.5）：< 15 chars = 0, < 50 = 0.1, < 100 = 0.3, >= 100 = 0.5
- Multi-intent markers（+0.2）：含「而且」「比較」「vs」或多個問號
- Entity count（+0.1 per entity, max 0.3）：BTC/ETH/SOL/AI/RWA/DeFi/牛市/熊市...
- Question complexity（+0.1）：含「為什麼」「如何」「建議」「策略」

---

## 17-6 為什麼先不用 LambdaMART

1. **資料不足**：LambdaMART 是 learning-to-rank 模型，需要大量 relevance-judged query-document pairs 做訓練。目前僅有 15 筆 eval cases，不足以訓練。
2. **過早優化**：在 BM25 + embeddings + RRF 已經能提供明顯優於 keyword-only 的檢索品質時，投入 LambdaMART 的工程成本與回報不成比例。
3. **維護複雜度**：LambdaMART 需要持續的訓練資料收集、模型重訓練、特徵工程維護，對一個還在 Phase 2A 的系統來說過重。
4. **替代方案已就位**：Lightweight reranker（score fusion + metadata boost + lexical overlap）在目前知識庫規模（~50 chunks）下已經足夠有效。
5. **未來路徑清晰**：當 eval cases 累積到 100+、且線上 retrieval metrics 顯示 reranker 是瓶頸時，可以升級到 cross-encoder（介面已預留），再到 LambdaMART（如果資料量允許）。

---

## 17-7 目前有哪些 Fallback

| 層級 | Fallback 條件 | Fallback 行為 |
|------|-------------|-------------|
| Embedding | 無 OPENAI_API_KEY 或 API call 失敗 | `embedding_service.available = False`，dense retrieval 停用 |
| Vector Store | ChromaDB 未安裝或 init 失敗 | `vector_store.available = False`，dense retrieval 停用 |
| BM25 | rank-bm25 未安裝 | 內部 TF-IDF（BM25-like scoring） |
| jieba | jieba 未安裝 | Regex-based tokenization（`[\w一-鿿]+`） |
| Reranker | 任何錯誤 | Skip rerank，直接使用 RRF fusion 結果 |
| Hybrid Retrieval | Sparse + Dense 任一失敗 | 使用可用的那一側 |
| All Retrieval | 全部失敗 | Keyword fallback（`KnowledgeBase.search_keywords()`） |
| KB | KB 未載入或無檔案 | 跳過檢索，使用原始 prompt（無 RAG context） |
| LLM | LLM call 失敗 | Deterministic fallback response |

**金句**：在沒有任何新增依賴（chromadb/rank-bm25/jieba）且沒有 OPENAI_API_KEY 的情況下，系統行為與 MVP 時期完全一致。

---

## 17-8 如何 Rebuild Index

### 方法一：API endpoint

```bash
curl -X POST http://localhost:5000/api/rag/rebuild-index
```

### 方法二：Python script

```python
from services.retrieval_service import get_retrieval
count = get_retrieval().rebuild_index()
print(f"Indexed {count} chunks")
```

### 方法三：程式內自動觸發

- `RetrievalService._ensure_bm25()`：若 BM25 index 為空，首次使用時自動從 chunks 建立
- `RetrievalService._ensure_vector_store()`：若 ChromaDB collection 為空，首次使用時自動 embed + 寫入

### Rebuild 流程

```
1. ChunkingService.build_all_chunks()
   └─ 讀取 data/knowledge/*.md + *.json
   └─ Semantic chunking + metadata
   └─ Return List[Chunk]

2. BM25Service.build_index(chunks)
   └─ Tokenize (jieba/regex)
   └─ Build BM25Okapi or TF-IDF index

3. EmbeddingService.embed_chunks(texts)
   └─ Batch embed via text-embedding-3-small
   └─ Hash cache for dedup

4. VectorStoreService.rebuild_index(chunks, embeddings)
   └─ Reset ChromaDB collection
   └─ Batch add (ids + docs + metadatas + embeddings)
```

---

## 17-9 如何做 Eval

### 快速 smoke test

```bash
curl -X POST http://localhost:5000/api/rag/eval \
  -H "Content-Type: application/json" \
  -d '{"queries":["比特幣適合長期持有嗎","如何判斷詐騙"],"endpoint":"chat"}'
```

### 完整離線評估

```bash
cd 正式版
python scripts/eval_rag.py --cases eval/rag_eval_cases.jsonl --verbose

# With faithfulness eval (requires OPENAI_API_KEY)
python scripts/eval_rag.py --faithfulness

# Save results
python scripts/eval_rag.py --output eval_results.json
```

### Eval Cases 格式

```json
{
  "query": "比特幣適合長期持有嗎",
  "endpoint": "chat",
  "expected_topics": ["投資原則", "市場敘事"],
  "expected_sources": ["investment_rules"],
  "expected_keywords": ["比特幣", "長期", "DCA"],
  "gold_answer": "比特幣作為數位黃金..."
}
```

### 支援的指標

| 指標 | 說明 | 自動化 |
|------|------|--------|
| Precision@K | Top-K 中與 expected_topics 匹配的比例 | ✅ 自動 |
| Recall@K | expected_topics 中有多少在 Top-K 中出現 | ✅ 自動 |
| MRR | 第一個相關結果的 reciprocal rank | ✅ 自動 |
| NDCG@K | Normalized Discounted Cumulative Gain | ✅ 自動 |
| Keyword Overlap | retrieved text 中含 expected_keywords 的比例 | ✅ 自動 |
| Latency (avg/p50/p95/p99) | Retrieval pipeline 延遲分佈 | ✅ 自動 |
| Faithfulness | LLM judge：回答是否忠於 retrieved context | ⚠️ Optional（需 API key） |
| Answer Relevance | 回答與 query 的相關性 | 🔜 Future |

---

## 17-10 Config 參數總表

| 環境變數 | 預設值 | 說明 |
|---------|--------|------|
| `RAG_ENABLE_EMBEDDINGS` | `1` | 啟用 embeddings/dense retrieval |
| `RAG_ENABLE_VECTOR_STORE` | `1` | 啟用 ChromaDB vector store |
| `RAG_ENABLE_QUERY_REWRITE` | `1` | 啟用 query rewrite/expansion |
| `RAG_ENABLE_RERANK` | `1` | 啟用 reranker |
| `RAG_ROUTING_MODE` | `auto` | 路由模式：auto/fast/deep |
| `RAG_TOP_K_SPARSE` | `10` | Sparse retrieval 的 top_k |
| `RAG_TOP_K_DENSE` | `10` | Dense retrieval 的 top_k |
| `RAG_TOP_K_FINAL` | `5` | 最終注入 prompt 的 top_k |
| `RAG_REWRITE_SIM_THRESHOLD` | `0.6` | Rewrite similarity guard 閾值 |
| `RAG_REWRITE_SIM_THRESHOLD` | `0.6` | Embedding similarity 最低接受值 |
| `RAG_VECTOR_DB_PATH` | `data/vector_store/` | ChromaDB 持久化路徑 |
| `RAG_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding 模型 |
| `RAG_DEBUG_LOGGING` | `0` | 啟用 RAG metrics logging |
| `RAG_ENABLE_LLM_REWRITE` | `0` | 啟用 LLM-based query rewrite（可選） |
| `RAG_RERANK_CROSS_ENCODER_MODEL` | (空) | Cross-encoder 模型名稱（可選） |
| `RAG_RRF_K` | `60` | RRF 的 k 參數 |
| `RAG_DENSE_WEIGHT` | `0.5` | RRF dense weight |
| `RAG_SPARSE_WEIGHT` | `0.5` | RRF sparse weight |

---

## 17-11 已完成 vs 未來 Phase

### Phase 2A（本次已完成）

- [x] Semantic chunking（markdown + JSON + overlap + metadata）
- [x] Embedding service（text-embedding-3-small + hash cache + fallback）
- [x] Vector store（ChromaDB persistent + rebuild + query）
- [x] BM25 sparse retrieval（rank-bm25 + jieba + TF-IDF fallback）
- [x] Hybrid retrieval（RRF fusion + configurable weights）
- [x] Query rewrite/expansion（rule-based + alias/synonym + similarity guard）
- [x] Strategy router（fast/deep path）
- [x] Lightweight reranker（score fusion + metadata boost）
- [x] Observability（per-call metrics log）
- [x] Evaluation harness（15 cases + eval script）
- [x] 文件同步更新

### Phase 2B（下一步優先）

1. **線上 retrieval 監控**：從 file-based metrics → Grafana/streaming dashboard
2. **A/B testing 框架**：比較 keyword vs hybrid 的真實使用指標
3. **Eval cases 擴充**：從 15 → 50+ cases，增加 edge cases 與多語言 cases
4. **知識庫自動更新**：爬蟲 → NLP 摘要 → 人工審核 → auto upsert
5. **Cross-encoder reranker**：當資料量允許時（介面已預留）

### Phase 3（遠期）

1. **使用者行為個人化 RAG**：根據歷史對話調整 retrieval weights
2. **Query 意圖分類 model**：取代 heuristic router
3. **多模態 RAG**：支援圖表、交易截圖的檢索
4. **LambdaMART / Learning-to-rank**：當有足夠 training data 時
5. **多語言知識庫**：英文技術文件 + 法規文件的雙語 RAG

---

## 17-12 關鍵設計決策

| 決策 | 理由 |
|------|------|
| 用 ChromaDB 而非 Pinecone | 開源、本地部署、零費用、適合專題展示 |
| 用 RRF 而非加權分數合併 | RRF 不依賴 score normalization，對不同 backend 的 score distribution 更 robust |
| Rule-based rewrite 優先於 LLM rewrite | 低延遲、零費用、可控、不會產生語意偏移 |
| Lightweight reranker 而非 cross-encoder | 不需下載大型模型（> 500MB），0 依賴風險，在 ~50 chunks 規模下效果足夠 |
| Embedding similarity guard | 防止 query expansion 過度偏離原意，是 retrieval 品質的安全網 |
| 不做 LambdaMART | 資料不足（15 cases vs 需要 1000+），過早優化 |
| Graceful degradation 全鏈路 | 確保在任何依賴缺失的情況下系統仍可運作，不影響期末展示 |
