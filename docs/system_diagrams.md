# 專題系統架構圖表 (Mermaid 原始碼)

本檔案包含第 6 至 8 章的所有系統圖表。在 GitHub 上檢視本檔案時，Mermaid 區塊會自動渲染成視覺化圖表。

## 6-1-1 AI 投資教練對話流程
```mermaid
sequenceDiagram
    participant U as 使用者
    participant B as 瀏覽器
    participant F as Flask
    participant DB as Supabase
    participant AI as OpenAI

    U->>B: 輸入問題
    B->>F: POST /api/ai-chat
    F->>F: 驗證 JWT 與建立 RAG 脈絡
    F->>DB: 取得對話歷史
    DB-->>F: 歷史訊息
    F->>AI: 問題、脈絡與對話紀錄
    AI-->>F: 回答與引用資訊
    F->>DB: 儲存訊息與 trace
    F-->>B: reply、citations、conversation_id
    B-->>U: 顯示回答與來源
```

## 6-1-2 模擬交易下單流程
```mermaid
sequenceDiagram
    participant U as 使用者
    participant B as 瀏覽器
    participant F as Flask
    participant CG as CoinGecko
    participant DB as Supabase 或本機備援

    U->>B: 輸入幣種、方向與數量
    B->>F: POST /api/sim-trade/order
    F->>F: 驗證 JWT 與輸入資料
    F->>CG: 取得即時價格
    CG-->>F: 當前報價
    alt Supabase 可用
        F->>DB: RPC 寫入交易與持倉
    else Supabase 不可用
        F->>DB: 寫入本機 JSON 帳本
    end
    DB-->>F: cash、positions、trade
    F-->>B: 交易結果
    B-->>U: 更新模擬投資組合
```

## 6-1-3 可疑文案辨識流程
```mermaid
sequenceDiagram
    participant U as 使用者
    participant B as 瀏覽器
    participant F as Flask
    participant R as 規則與 RAG
    participant AI as OpenAI

    U->>B: 貼上可疑投資訊息
    B->>F: POST /api/scam-scan
    F->>R: 檢查文字紅旗規則與知識庫
    R-->>F: 觸發規則、證據與引用
    F->>AI: 文案、規則與檢索脈絡
    AI-->>F: 結構化風險說明
    F-->>B: risk_level、reasons、uncertainty
    B-->>U: 顯示限制與防範建議
```

## 6-2 設計類別圖
```mermaid
classDiagram
    class FlaskApp {
        +routes
        +JWT 驗證
        +快取與錯誤處理
    }
    class DataManager {
        +get_market_tickers()
        +build_historical_df()
    }
    class RiskModel {
        +calculate_copula_risk()
        +paper_stress_test()
    }
    class SocialMediaEngine {
        +scrape_ptt()
        +scrape_rss_for_signals()
    }
    class SimulationStore {
        +sim_execute_order()
        +local_execute_sim_order()
    }
    class SupabaseDB {
        +Auth 與資料表存取
        +RAG trace 與 feedback
    }

    FlaskApp --> DataManager : 呼叫
    FlaskApp --> RiskModel : 呼叫
    FlaskApp --> SocialMediaEngine : 呼叫
    FlaskApp --> SimulationStore : 呼叫
    FlaskApp --> SupabaseDB : 資料存取
    SimulationStore --> SupabaseDB : 優先使用
```

## 7-1 部署圖
```mermaid
flowchart TB
    Browser[使用者瀏覽器\nHTML CSS JavaScript]
    Flask[Flask Web Service\nGunicorn Routes JWT Cache]
    Supabase[Supabase\nAuth PostgreSQL RLS RPC]
    OpenAI[OpenAI\n對話 RAG 回答 Podcast TTS]
    Data[外部資料來源\nCoinGecko yfinance PTT RSS]

    Browser -->|HTTPS| Flask
    Flask -->|SQL / REST| Supabase
    Flask -->|API| OpenAI
    Flask -->|API| Data
```

## 7-2 套件圖
```mermaid
flowchart TB
    subgraph Presentation_Layer [表現層套件]
        UI[templates / static CSS & JS]
    end

    subgraph Application_Layer [應用層套件]
        App[app.py / routes]
        Auth[JWT 驗證模組]
    end

    subgraph Domain_Layer [領域服務層套件]
        RAG[RAG 檢索服務]
        Trade[模擬交易服務]
        Scam[防詐騙分析服務]
    end

    subgraph Infrastructure_Layer [基礎設施層套件]
        DBClient[supabase_client]
        ExtAPI[外部 API 請求模組]
    end

    Presentation_Layer --> Application_Layer
    Application_Layer --> Domain_Layer
    Domain_Layer --> Infrastructure_Layer
```

## 7-3 元件圖
```mermaid
flowchart LR
    component1[交易請求元件\n(Trade Request Component)]
    component2[價格獲取元件\n(Price Fetcher Component)]
    component3[餘額驗證元件\n(Balance Validator Component)]
    component4[資料庫寫入元件\n(DB Access Component)]
    
    interface1((REST API 介面))
    interface2((CoinGecko API 介面))

    interface1 --> component1
    component1 --> component2
    component2 -- 請求最新報價 --> interface2
    component1 --> component3
    component3 --> component4
```

## 7-4 狀態機
```mermaid
stateDiagram-v2
    [*] --> 訂單建立 (Created)
    訂單建立 (Created) --> 處理中 (Processing) : 系統接收訂單
    處理中 (Processing) --> 交易成功 (Executed) : 價格更新且餘額充足
    處理中 (Processing) --> 交易失敗 (Failed) : 餘額不足或網路錯誤
    處理中 (Processing) --> 取消 (Cancelled) : 使用者中斷連線
    交易成功 (Executed) --> [*]
    交易失敗 (Failed) --> [*]
    取消 (Cancelled) --> [*]
```

## 8-1 核心資料庫實體關係圖
```mermaid
erDiagram
    user_profiles ||--o{ sim_portfolios : owns
    user_profiles ||--o{ ai_conversations : creates
    sim_portfolios ||--o{ sim_positions : holds
    sim_portfolios ||--o{ sim_transactions : records
    ai_conversations ||--o{ ai_messages : contains
    ai_messages ||--o{ rag_runs : traces
    rag_runs ||--o{ rag_run_sources : cites
    rag_runs ||--o{ rag_feedback : receives

    user_profiles {
        uuid user_id PK
        varchar full_name
        timestamptz created_at
    }
    sim_portfolios {
        uuid id PK
        uuid user_id FK
        numeric cash_balance
    }
    sim_positions {
        uuid id PK
        uuid portfolio_id FK
        varchar symbol
        numeric quantity
    }
    sim_transactions {
        uuid id PK
        uuid portfolio_id FK
        varchar symbol
        numeric quantity
        numeric price
    }
    ai_conversations {
        uuid id PK
        uuid user_id FK
        varchar title
    }
    ai_messages {
        uuid id PK
        uuid conversation_id FK
        varchar role
        text content
    }
    rag_runs {
        uuid id PK
        uuid user_id FK
        uuid conversation_id FK
        uuid message_id FK
        varchar trace_id
    }
    rag_run_sources {
        uuid id PK
        uuid run_id FK
        varchar source
        int rank
    }
    rag_feedback {
        uuid id PK
        uuid run_id FK
        uuid user_id FK
        varchar vote
    }
```
