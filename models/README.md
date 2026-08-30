# ML / DL 模型架構規劃

> 目前正式版以 Rule-based + Quantitative + RAG + LLM 為主要 AI 架構。
> 以下目錄規劃為未來導入 ML/DL 模型的架構準備。

## 規劃方向

### sentiment/ — 文本情緒分析
- **目標**：對中文社群文本（PTT、新聞）做多分類情緒標記
- **候選模型**：
  - FinBERT (fine-tuned on Chinese financial text)
  - multilingual-BERT + sentiment classification head
  - LightGBM + TF-IDF（快速 baseline）
- **資料需求**：標記 2,000–5,000 筆中文加密社群文本
- **目前狀態**：架構就緒，尚未訓練。使用關鍵字規則（正面/負面詞典）作為 MVP 替代

### scam_classifier/ — 詐騙文本分類
- **目標**：對使用者輸入的內容做 scam / not-scam 二元分類
- **候選模型**：
  - TF-IDF + XGBoost（可解釋性高）
  - BERT fine-tune on scam dataset
  - Few-shot with GPT-4o-mini（目前 MVP 做法）
- **資料需求**：標記 500–2,000 筆台灣常見加密詐騙文本
- **目前狀態**：架構就緒。使用 GPT-4o-mini + 規則檢測（GMGN/WHOIS/社群交叉驗證）

### regime_detection/ — 市場狀態偵測
- **目標**：從價格序列自動分類市場狀態（牛市/熊市/震盪/黑天鵝）
- **候選模型**：
  - LSTM / Transformer for time-series regime classification
  - HMM (Hidden Markov Model) for regime switching
  - Temporal Fusion Transformer (TFT) for multi-horizon
- **資料需求**：BTC/ETH 歷史價格 + 總體經濟指標（VIX、利率、美元指數）
- **目前狀態**：架構就緒。使用 CoinGecko 價格 + MARKET_SCENARIOS 手動情境標記作為 MVP

## 訓練與部署流程（規劃）
1. 資料收集 → 2. 標記 → 3. 訓練/驗證 → 4. 模型匯出 → 5. API 封裝 → 6. A/B 測試 → 7. 上線

## 評估指標
- 分類任務：Accuracy, Precision, Recall, F1, AUC-ROC
- 回歸/預測：MAE, RMSE, Sharpe (for trading signals)
- 所有模型需通過 bias/fairness check
