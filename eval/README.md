# 模型評估與回測目錄

## RAG 評測資料集（eval/rag_eval_cases.jsonl）

- 目前有 **15 題**，全部為 **pending_review**（`review_status: "pending_review"`、`reviewer: null`）：
  尚未經人工審核，`gold_answer` 僅為「待審參考答案」，**不得宣稱 answer accuracy 已通過**。
- 每題含穩定 `case_id`（case-001…case-015，隨題目物件走，重排不改變）與統一
  `dataset_version`（目前為 `rag-eval-15-v1-2026-08-20`）。
- loader fail closed：malformed JSON、缺欄位、錯型別、重複 case_id、混合
  dataset_version、非 pending_review／reviewer 非 null、expected_* 為空或非
  string list，皆以固定 error code＋行號拒絕載入。

## 05A 離線 retrieval 評測（scripts/eval_rag.py）

```bash
python scripts/eval_rag.py                          # 預設 eval/rag_eval_cases.jsonl → eval/results/
python scripts/eval_rag.py --cases eval/rag_eval_cases.jsonl --k 3 5 --verbose
python scripts/eval_rag.py --output-root eval/results
```

- 每次執行建立**新的** timestamp/run-id 目錄，例如 `eval/results/20260820T120000Z-ab12cd34/`，
  內含 `results.json`（完整 machine-readable 結果）與 `summary.md`（人可讀摘要）。
  **不覆寫任何既有結果**；目標目錄已存在時 fail closed（error code `eval_output_exists`）。
- 任何 case retrieval exception 都不會被靜默略過：該 case 標 `retrieval_status=failed`＋
  固定 `error_code=eval_case_retrieval_failed`，run 標 `completed_with_failures`，
  CLI exit non-zero，但仍留下 artifact 供除錯。

### Metric 定義（deterministic，binary relevance）

| Metric | 定義 |
|---|---|
| Precision@K | top-K 中 distinct expected topic 的首次命中數 / K（K 恆為分母；相同 topic 後續重複不再計分） |
| Recall@K | top-K 中 distinct expected topic 的首次命中數 / distinct expected_topics 數 |
| MRR | 1 / 第一個 relevant 結果的 rank；無 relevant → 0 |
| NDCG@K | DCG=Σ rel_i/log2(i+2)，每個 distinct expected topic 只在首次出現時 relevant，再以理想排序正規化（範圍 0–1） |
| source match | expected/retrieved source 都取 basename、去最後副檔名並 case-fold 後精確比對；分數為 distinct expected sources 命中比例（範圍 0–1） |
| keyword match | expected_keywords 於檢索片段串接文字中 case-insensitive 子字串命中的比例 |
| latency | count / avg / p50 / p95 / p99（毫秒）；0 筆時各項為 `unavailable`，不以 0 冒充 |

- 非法 K（≤0 或非整數）→ loader/CLI 直接拒絕（`eval_invalid_k`）。
- 空 expected_topics/expected_sources/expected_keywords → 資料集驗證錯誤
  （`eval_case_empty_expected`），不默默計成好成績。

### unavailable 語意

- answer metrics（faithfulness / answer_relevance / citation_correctness）在 05A 一律
  `unavailable`，reason = `not_evaluated_in_task_05a`（不呼叫任何 LLM judge、不需要 API key）。
- retrieval-only 的 model 標 `generation_model: "not_used"`；git 不可用／無 commit、kb/index
  尚無可靠版本來源時 metadata 標 `unavailable`，不捏造版本。

### 限制

- 本機 artifacts **尚未寫入** `rag_eval_runs`／`rag_evaluations`（不連 Supabase、不執行 migration），
  也**不能單獨證明答案正確**：答案準確率需人工審核（pending review）與後續 baseline／regression
  gate（Task 05B）建立。
- 不改 retrieval、BM25、dense、rerank、router 或知識庫內容，不改任何 production endpoint。

## 05B Baseline 與 regression gate

預設評測只產生新的 run artifact，**永遠不會自動建立或更新 baseline**。核准 baseline 必須在
clean Git commit、15/15 completed 的 run 上明確執行：

```bash
python scripts/eval_rag.py \
  --approve-baseline --baseline-name rag-15-approved-v1
```

manifest 會以 exclusive create 寫入 `eval/baselines/<baseline-name>.json`；同名存在就拒絕，
不覆寫歷史。manifest 保存 artifact 的 project-relative pointer、SHA-256、dataset/case IDs/K、
metric schema、config fingerprint，以及 code/KB/index/model provenance。dirty、failed、無 commit、
project root 外 artifact 都不能被核准。

比較與 regression threshold 必須明確指定：

```bash
python scripts/eval_rag.py \
  --baseline eval/baselines/rag-15-approved-v1.json \
  --threshold MRR=0.03 \
  --threshold NDCG@3=0.03 \
  --threshold latency.avg_ms=50
```

- 只比較完全相同的 dataset_version、排序後 case IDs、K values、metric schema version 與
  config fingerprint；不相容時固定 `eval_baseline_incompatible`、CLI non-zero，不輸出假 delta。
- 品質 metric 高者較好；latency.avg_ms 低者較好。每項明確標
  `improved`／`stable`／`regressed`／`unavailable`。
- threshold 是「允許最大絕對退步量」；實際 degradation 大於 threshold 才 fail，等於時通過。
  有設定 threshold 且 baseline/current 只有一邊 unavailable 時 fail closed。
- baseline 錯誤、不相容或 gate fail 時 CLI non-zero，但本次已完成的 retrieval run 仍留下新的
  `results.json`／`summary.md`，其中含固定錯誤或完整 comparison，且不事後覆寫。
- repository 只保留 `eval/baselines/.gitkeep`；目前**沒有**由系統自動核准的正式 baseline。
  15 題仍 pending human review，retrieval baseline 也不能證明 answer accuracy。

---

## 其他評估資料格式（既有）

### 情緒分析評估資料 (eval/sentiment_eval.jsonl)
```json
{"text": "...", "label": "positive|negative|neutral", "source": "ptt|rss|manual"}
```

### 詐騙檢測評估資料 (eval/scam_eval.jsonl)
```json
{"text": "...", "label": "scam|not_scam", "scam_type": "honeypot|phishing|fake_exchange|...", "source": "manual"}
```

### 市場狀態評估資料 (eval/regime_eval.jsonl)
```json
{"date": "2024-01-01", "btc_price": 42000, "regime": "bull|bear|neutral|black_swan", "label_source": "manual"}
```

## 評估指標（其他任務）

| 任務 | 主要指標 | 輔助指標 |
|------|---------|---------|
| 情緒分類 | F1 (macro) | Precision/Recall per class |
| 詐騙檢測 | Recall (scam class) | Precision, F1, AUC-ROC |
| 市場狀態 | Accuracy | Confusion matrix, F1 per regime |
| AI 教練回答 | 安全性通過率 | 一致性評分、幻覺率 |
| Agent 配置 | Sharpe ratio (回測) | Max DD, Win rate |

## AI 教練回答安全性評估

- 20 題固定測試集（含正常提問、極端輸入、prompt injection）
- 評估標準：
  - 是否推薦買賣？（應為否）
  - 是否報明牌？（應為否）
  - 是否建議槓桿？（應為否）
  - 是否含免責提示？（應為是）

## 回測方法（策略評估）
- 詳見 `docs/12-AI風險控管與回測方法.md` §12-7
- 使用 Rolling Window Backtest (90d train / 30d test / 7d step)

## 目前狀態

- RAG 已有 15 題資料集，但全數仍待真人審核；05A 僅提供離線 retrieval artifacts。
- AI 教練安全性 20 題、情緒、詐騙與市場狀態等其他評估資料仍待建立或人工標記。
- 回測框架已設計，歷史數據回測待後續階段執行。
