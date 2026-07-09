# 第 14 章 RAG 設計與導入規劃

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

### 14-2-1 目前 MVP 架構

```
使用者查詢 → Query Routing → 關鍵字檢索(KnowledgeBase) → Prompt Builder → LLM
                                  ↓ 失敗
                              Fallback: 原始 Prompt（無 RAG context）
```

### 14-2-2 未來升級架構（Phase 2）

```
使用者查詢 → Query Routing → Hybrid Search ─────────────→ Reranker → Prompt Builder → LLM
                │                ├─ Dense (embeddings)    │
                │                └─ Sparse (BM25)         │
                │                     ↓                   │
                └── Vector DB (ChromaDB/Pinecone) ────────┘
```

---

## 14-3 資料來源

| 來源 | 類型 | 更新頻率 |
|------|------|---------|
| `data/knowledge/*.md` | 投資知識 | 手動更新 |
| `data/knowledge/coin_profiles.json` | 幣種結構化資料 | 手動更新 |
| CoinGecko API | 即時市場數據 | 每 5 分鐘（快取） |
| PTT / RSS | 社群情緒 | 每次請求 |
| Supabase | 使用者持倉/對話歷史 | 每次請求 |

---

## 14-4 Chunking 策略

### MVP（目前）
- 以 **段落** 為單位（`\n\n` 分割），不做更細的 chunking
- 每個 snippet 上限 300 字元
- 每次檢索最多回傳 3 個 section

### Phase 2 規劃
- Chunk size：256–512 tokens，overlap 50 tokens
- 使用 `text-embedding-3-small` 做 dense embedding
- Metadata：source_file、topic、section_header、last_updated

---

## 14-5 Metadata 設計

```json
{
  "doc_id": "investment_rules.md#分散配置原則",
  "source": "data/knowledge/investment_rules.md",
  "topic": "投資原則",
  "section": "分散配置原則",
  "last_updated": "2026-07-09",
  "content_hash": "sha256...",
  "chunk_index": 0
}
```

---

## 14-6 Retrieval 流程

1. **Query 標準化**：去標點、分詞、去停用詞（中英文）
2. **關鍵字匹配**：對每個 term 在所有 section 中計數
3. **Scoring**：`score = sum(min(count(term), 5) for term in terms)`
4. **排序**：依 score 降冪，取 top-N（N=2–4）
5. **Snippet 擷取**：每個匹配 section 取前 2 段含有關鍵字的段落
6. **組裝**：`[topic] snippet | [topic2] snippet2 ...`

---

## 14-7 Prompt 組裝方式

見 `services/prompt_builder.py`：

```
System: [角色設定 + 行為規則]
Context: [RAG 檢索結果] ← 本次新增
User Context: [持倉/風險偏好/市場情境] ← 本次新增
User Message: [使用者原始輸入]
Citation Hint: [參考資料標記] ← 本次新增
```

Token 預算控制：context 上限 ~600 tokens（約 1800 chars），總 prompt 控制在 ~2500 tokens 以內。

---

## 14-8 Citation / Source Attribution

- 每個檢索結果附帶 `source`（檔案名）和 `topic`（主題標籤）
- 在 AI 回覆末尾可選擇加入簡短來源提示（不破壞前端格式）
- 格式：`（參考資料：投資原則、市場情境）`

---

## 14-9 Fallback 設計

```
RAG 檢索開始
  ├─ KB 未載入 → 跳過檢索，使用原始 prompt
  ├─ 檢索失敗（exception） → 跳過，使用原始 prompt
  ├─ 檢索無結果 → 跳過，使用原始 prompt
  └─ 檢索成功 → 注入 RAG context → LLM call
       └─ LLM call 失敗 → 回傳 deterministic fallback 回應
```

所有 RAG 失敗都不影響原功能，保證 **graceful degradation**。

---

## 14-10 MVP 導入順序

1. ✅ 建立知識庫（7 個檔案）
2. ✅ 實作 `KnowledgeBase` + `RetrievalService`
3. ✅ 實作 `PromptBuilder` + `RAGService`
4. ✅ 接到 `/api/ai-chat`、`/api/agent-plan`、`/podcast/generate`
5. ✅ 接到 `/api/scam-scan`、`/portfolio/analyze-llm`（補充模式）
6. ✅ 加入 guardrails（輸入/輸出安全過濾）
7. Phase 2：導入 embedding + vector DB
8. Phase 2：知識庫自動更新 pipeline
9. Phase 2：RAG hit-rate 監控 + 評估

---

## 14-11 升級到 Vector DB 路徑

1. 選擇向量資料庫：ChromaDB（開源、輕量）或 Pinecone（託管）
2. 建立 embedding pipeline：
   - 讀取 knowledge files → 分段 → `text-embedding-3-small` → 寫入向量 DB
3. 修改 `RetrievalService.retrieve()` → 改用 hybrid search（dense + sparse）
4. 加入 reranker（cross-encoder）提升精確度
5. 加入 retrieval 評估：MRR、NDCG、hit-rate
