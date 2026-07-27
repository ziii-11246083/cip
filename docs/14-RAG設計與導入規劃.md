# 第 14 章 RAG 設計與導入規劃

> 更新日期：2026-07-09（Phase 2A 升級完成）

## 14-1 RAG 適用性分析

### 適合用 RAG 的功能

| 功能 | 適合原因 | RAG 貢獻 |
|------|---------|---------|
| `/api/ai-chat` | 使用者提問範圍廣，需要投資知識補充 | 提供分散配置/風控/情境應對原則，讓回答更有依據 |
| `/api/agent-plan` | 需要根據市場情境給出結構化建議 | 提供情境 playbook + 配置原則，減少 GPT 幻覺 |
| `/podcast/generate` | 需要一致的風格與結構 | 提供 Podcast 風格指南 + 市場敘事框架 |
| `/api/scam-scan` | 詐騙模式持續演進，需要案例知識 | 補充詐騙模式百科，但核心判斷仍靠 API+規則 |
| `/portfolio/analyze-llm` | 數值解讀需要領域知識 | 提供健康度指標解讀指南 + 配置建議原則 |

### 不適合用 RAG 的功能

| 功能 | 不適合原因 | 正確做法 |
|------|-----------|---------|
| SFI 風險計算 | 數學公式（Copula），需要精確數值 | Rule-based / Quantitative |
| FOMO 檢測 | 純閾值判斷（漲幅 > 20%），不需語言理解 | Rule-based |
| 技術指標 | Beta/波動/回撤，數學運算 | Quantitative |
| 模擬交易 | 金融交易邏輯，不可有歧義 | Deterministic code |
| 持倉/PnL | 純數值，不需 AI | 直接計算 |

---

## 14-2 RAG 架構設計

### 14-2-1 目前架構（Phase 2A — Hybrid RAG）

```
使用者查詢 → Query Router ─┬→ Fast Path ──→ Hybrid Retrieval ──→ Prompt Builder → LLM
                           │                   ├─ BM25 (sparse)
                           │                   ├─ Dense (embeddings + ChromaDB)
                           │                   └─ RRF Fusion
                           │
                           └→ Deep Path ──→ Query Rewrite ──→ Hybrid + Rerank ──→ Prompt Builder → LLM
                                              (similarity guard)
                          
                          All paths: ↓ failure → keyword fallback → LLM (graceful degradation)
```

### 14-2-2 從 MVP 升級到 Phase 2A

| 組件 | MVP | Phase 2A |
|------|-----|----------|
| Chunking | `\n\n` 分段，無 overlap | Semantic chunking (H1/H2/H3 + 段落 + 列表) + 15% overlap |
| Sparse Retrieval | Term-count keyword | BM25 with jieba tokenization |
| Dense Retrieval | 無 | text-embedding-3-small + ChromaDB |
| Fusion | 無 | Reciprocal Rank Fusion (RRF) |
| Query Enhancement | 無 | Rule-based expansion + alias/synonym + similarity guard |
| Routing | 無 | Fast/Deep path based on query complexity |
| Reranking | 無 | Lightweight (score fusion + metadata boost + lexical overlap) |
| Observability | 無 | Per-call metrics log (endpoint/route/latency/hits/fallback) |
| Evaluation | 無 | 15 test cases + eval script (P@K/Recall@K/MRR/NDCG) |

---

## 14-3 資料來源

| 來源 | 類型 | 更新頻率 | Chunk 數 |
|------|------|---------|---------|
| `data/knowledge/*.md` | 投資知識 | 手動更新 | ~40-60 chunks |
| `data/knowledge/coin_profiles.json` | 幣種結構化資料 | 手動更新 | ~8 chunks |
| CoinGecko API | 即時市場數據 | 每 5 分鐘（快取） | N/A |
| PTT / RSS | 社群情緒 | 每次請求 | N/A |
| Supabase | 使用者持倉/對話歷史 | 每次請求 | N/A |

---

## 14-4 Chunking 策略（Phase 2A）

### Markdown 檔案
- 以 H1/H2/H3 標題為主要邊界
- 每個 section 內再依段落（`\n\n`）細分
- 長段落依行邊界（`\n`）再拆分
- Chunk size: ~1200 chars soft max（約 300-400 tokens for mixed CN/EN）
- Overlap: 15%（取前一 chunk 尾部作為下一 chunk 開頭）
- Min chunk size: 80 chars（跳過過短 chunk）

### JSON 檔案
- 每筆 logical record（例如 coin_profiles.json 中 BTC 為一筆）轉為一個 chunk
- 展平為 `key: value` 格式的文字

### Metadata（每個 chunk 都帶）
- `chunk_id`: 唯一識別（`{doc_id}#{chunk_index}`）
- `doc_id`: 原始檔案名（不含副檔名）
- `source`: 檔案路徑（`data/knowledge/xxx.md`）
- `topic`: 中文主題標籤
- `section`: 所屬 H2/H3 標題
- `chunk_index`: 在檔案內的序號
- `doc_type`: `markdown` 或 `json`
- `last_updated`: 建立日期
- `content_hash`: SHA256 前 16 字元

---

## 14-5 Metadata 設計

```json
{
  "chunk_id": "investment_rules#3",
  "doc_id": "investment_rules",
  "source": "data/knowledge/investment_rules.md",
  "topic": "投資原則",
  "section": "不追高原則（FOMO 控制）",
  "chunk_index": 3,
  "doc_type": "markdown",
  "last_updated": "2026-07-09",
  "content_hash": "a1b2c3d4..."
}
```

---

## 14-6 Retrieval 流程（Phase 2A）

1. **Query Routing**：根據 query 複雜度、長度、entity 數量、endpoint 類型決定 fast/deep path
2. **Query Rewrite**（deep path only）：rule-based expansion（alias + synonym + domain lexicon + endpoint-specific），embedding similarity guard 過濾偏差過大的 rewrite
3. **Sparse Retrieval**：BM25 with jieba tokenization，top_k_sparse（預設 10）
4. **Dense Retrieval**：query embedding → ChromaDB query，top_k_dense（預設 10）
5. **RRF Fusion**：Reciprocal Rank Fusion（k=60），combine sparse + dense rankings
6. **Rerank**（deep path only）：lightweight reranker（score fusion + metadata boost + lexical overlap），取 top_k_final
7. **組裝**：chunks → RetrievalResult → PromptBuilder → LLM

---

## 14-7 Prompt 組裝方式

見 `services/prompt_builder.py`：

```
System: [角色設定 + 行為規則]
Confidence Note: [若 retrieval 信心不足 → 提醒使用者]
Context: [RAG 檢索結果 + 優先依據標記] ← 升級為 chunk-level
Fallback Note: [若無檢索結果 → 告知使用者資訊不完整]
User Context: [持倉/風險偏好/市場情境]
User Message: [使用者原始輸入]
Citation Hint: [參考資料標記]
```

Token 預算控制：context 上限 ~600 tokens（約 1800 chars），總 prompt 控制在 ~2500 tokens 以內。

---

## 14-8 Citation / Source Attribution

- 每個檢索結果附帶 `source`（檔案名）和 `topic`（主題標籤）
- 在 AI 回覆末尾可選擇加入簡短來源提示（不破壞前端格式）
- 格式：`（參考資料：投資原則、市場情境）`
- 新增：retrieval confidence note（low confidence 時主動提醒使用者）

---

## 14-9 Fallback 設計

```
RAG 檢索開始
  ├─ KB 未載入 → 跳過檢索，使用原始 prompt
  ├─ Embedding 不可用 → dense retrieval disabled → sparse-only
  ├─ ChromaDB 不可用 → vector store disabled → sparse-only
  ├─ BM25 不可用 → internal TF-IDF fallback
  ├─ jieba 不可用 → regex-based tokenization
  ├─ Reranker 不可用 → skip rerank，使用 fusion 結果
  ├─ 所有 retrieval 失敗（exception） → keyword fallback（KnowledgeBase.search_keywords）
  ├─ 檢索無結果 → 跳過，使用原始 prompt
  └─ 檢索成功 → 注入 RAG context → LLM call
       └─ LLM call 失敗 → 回傳 deterministic fallback 回應
```

所有 RAG 失敗都不影響原功能，保證 **graceful degradation**。

---

## 14-10 Phase 2A 導入項目（已完成）

1. ✅ Semantic chunking（markdown + JSON + overlap + metadata）
2. ✅ Embedding service（text-embedding-3-small + cache + fallback）
3. ✅ Vector store（ChromaDB persistent + rebuild + query）
4. ✅ BM25 sparse retrieval（rank-bm25 + jieba + TF-IDF fallback）
5. ✅ Hybrid retrieval（RRF fusion + configurable weights）
6. ✅ Query rewrite/expansion（rule-based + alias/synonym + similarity guard）
7. ✅ Strategy router（fast/deep path based on query complexity）
8. ✅ Lightweight reranker（score fusion + metadata boost + lexical overlap）
9. ✅ Observability（per-call metrics log）
10. ✅ Evaluation harness（15 cases + eval script）
11. ✅ 文件同步更新（14/15/16/17 章 + CHANGELOG）

---

## 14-11 未來 Phase 2B/3 規劃

1. **知識庫自動更新 pipeline**：爬蟲 → 清洗 → chunk → embed → upsert
2. **Cross-encoder reranker**：當資料量足夠時可升級（目前介面已預留）
3. **Query 意圖分類模型**：取代目前的 heuristic router
4. **線上 A/B testing**：比較 keyword-only vs hybrid retrieval 的真實使用者回饋
5. **Retrieval 線上監控儀表板**：從目前的 file-based metrics 升級到 Grafana/DB
6. **使用者行為個人化 RAG**：根據使用者歷史查詢調整 retrieval 權重
7. **多語言知識庫擴充**：英文技術文件、法規文件的雙語 RAG
