-- =====================================================================
-- 20260814120000_rag_trace.sql
-- TASK 01 — RAG Trace 資料契約 migration
--
-- 目的：建立 RAG 回答可追溯（traceability）所需的 5 張新表：
--   rag_runs / rag_run_sources / rag_feedback / rag_evaluations / rag_eval_runs
--
-- 性質：
--   - 只「新增」資料表、index 與 RLS policy；不修改、不 DROP、不 TRUNCATE
--     任何既有資料表。
--   - 可重複執行（idempotent）：所有 CREATE 均帶 IF NOT EXISTS，
--     policy 先 DROP POLICY IF EXISTS 再 CREATE（僅限本 migration 管理的
--     同名 policy，用於重跑安全）。
--   - 不保存 API Key、token、私鑰、助記詞；無任何密文欄位。
--
-- 使用者鍵（依 docs/08-資料庫設計.md 8-2-1）：
--   user_profiles.user_id（PK）即 Supabase Auth UID（auth.users.id）。
--   本 migration 不使用也不假定 user_profiles.id 存在。
--
-- 授權總原則：
--   - authenticated 對 rag_runs / rag_run_sources 只能 SELECT 自己的資料，
--     不得 INSERT / UPDATE / DELETE；所有寫入由後端 service role 執行
--     （service role bypasses RLS，不需要另建 policy）。
--   - authenticated 唯一允許的寫入是 rag_feedback，且 run 必須屬於自己。
--
-- 完整契約說明見 docs/RAG_TRACE_DATA_CONTRACT.md。
-- =====================================================================

-- PostgreSQL 13 以下需 pgcrypto 提供 gen_random_uuid()；
-- PostgreSQL 14+ 為內建。IF NOT EXISTS 保證可重複執行。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================
-- 1. rag_runs — 每次 RAG 管線執行的主紀錄
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.rag_runs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 追溯識別：由寫入方（後端）產生的 trace id（建議 UUIDv4 / 32-hex）
    trace_id              text NOT NULL UNIQUE
                          CHECK (char_length(trace_id) BETWEEN 8 AND 128),
    -- 使用者鍵 = Supabase Auth UID；允許 NULL：離線評估/背景執行無使用者。
    -- ON DELETE CASCADE：帳號資料列刪除時連帶清除高敏感 trace
    -- （source/feedback/evaluation 經下游 FK cascade 一併清除）
    user_id               uuid REFERENCES public.user_profiles(user_id)
                          ON DELETE CASCADE,
    -- 對話關聯；允許 NULL：podcast / scam / health / agent 不屬於對話
    conversation_id       uuid REFERENCES public.ai_conversations(id)
                          ON DELETE SET NULL,
    message_id            uuid REFERENCES public.ai_messages(id)
                          ON DELETE SET NULL,
    endpoint              text NOT NULL
                          CHECK (endpoint IN ('chat','agent','podcast','scam','health')),
    -- 已遮罩（PII masking）後的 query；原始 query 永不入庫
    sanitized_query       text NOT NULL
                          CHECK (char_length(sanitized_query) BETWEEN 1 AND 4000),
    -- keyed HMAC-SHA-256(server_secret, normalized sanitized_query)，64-hex。
    -- secret 不得寫入 DB / log / repository / 前端；此欄位非匿名化保證
    -- （低熵查詢仍可能被字典猜測），說明見契約文件 §6.1
    query_hash            text NOT NULL CHECK (query_hash ~ '^[0-9a-f]{64}$'),
    -- 最終回答（寫入前需經相同 PII 遮罩處理）；NULL：失敗或 abstain 無回答
    answer                text,
    -- LLM 模型識別（如 gpt-4o-mini）
    model                 text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
    -- 各版本識別；目前 pipeline 尚未實作版本追蹤，欄位為 planned，允許 NULL
    prompt_version        text,
    kb_version            text,
    index_version         text,
    config_version        text,
    -- 路由決策；'unknown' 為 router 不可用時（見 rag_service.py L123）
    route                 text CHECK (route IN ('fast','deep','unknown')),
    -- 信心分數 0.0–1.0；NULL：未計算
    confidence            numeric(5,2) CHECK (confidence >= 0 AND confidence <= 1),
    -- 系統選擇不回答（低信心/資料不足）
    abstained             boolean NOT NULL DEFAULT false,
    -- 任一 fallback 路徑被使用（檢索降級或 deterministic fallback 回應）
    fallback              boolean NOT NULL DEFAULT false,
    fallback_reason       text,
    status                text NOT NULL DEFAULT 'success'
                          CHECK (status IN ('success','degraded','abstained','error')),
    -- 錯誤類別/訊息（截斷至 500 chars，禁止寫入任何 secret）
    error                 text CHECK (error IS NULL OR char_length(error) <= 500),
    -- ── 對應 services/rag_metrics_service.py build_record() 的欄位 ──
    rewrite_used          boolean,
    rewrite_rejected      boolean,
    rewrite_similarity    numeric(5,4)
                          CHECK (rewrite_similarity >= 0 AND rewrite_similarity <= 1),
    sparse_hit_count      integer CHECK (sparse_hit_count >= 0),
    dense_hit_count       integer CHECK (dense_hit_count >= 0),
    final_context_count   integer CHECK (final_context_count >= 0),
    empty_context         boolean,
    -- ── token 與延遲 ──
    prompt_tokens         integer CHECK (prompt_tokens >= 0),
    completion_tokens     integer CHECK (completion_tokens >= 0),
    retrieval_latency_ms  integer CHECK (retrieval_latency_ms >= 0),
    rerank_latency_ms     integer CHECK (rerank_latency_ms >= 0),
    total_latency_ms      integer NOT NULL CHECK (total_latency_ms >= 0),
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_runs_user_created
    ON public.rag_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_runs_conversation
    ON public.rag_runs (conversation_id);
CREATE INDEX IF NOT EXISTS idx_rag_runs_message
    ON public.rag_runs (message_id);
CREATE INDEX IF NOT EXISTS idx_rag_runs_endpoint_created
    ON public.rag_runs (endpoint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_runs_query_hash
    ON public.rag_runs (query_hash);

-- =====================================================================
-- 2. rag_run_sources — 每次 run 檢索到的來源 chunk
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.rag_run_sources (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id             uuid NOT NULL REFERENCES public.rag_runs(id)
                       ON DELETE CASCADE,
    -- chunk id（如 "investment_rules#3"）；NULL：keyword fallback 無 chunk id
    chunk_id           text,
    -- 來源檔（如 data/knowledge/investment_rules.md）
    source             text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
    topic              text,
    section            text,
    -- 最終結果排序（1-based）
    rank               integer NOT NULL CHECK (rank >= 1),
    -- rerank 後分數，reranker 已 clamp 至 1.0（reranker_service.py L97）
    score              numeric(8,6) CHECK (score >= 0 AND score <= 1),
    content_hash       text,
    -- 實際檢索到的片段文字（知識庫內容，非使用者資料）
    excerpt            text NOT NULL CHECK (char_length(excerpt) BETWEEN 1 AND 4000),
    -- 是否真的被注入 prompt
    actually_injected  boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, rank)
);

CREATE INDEX IF NOT EXISTS idx_rag_run_sources_source
    ON public.rag_run_sources (source);
CREATE INDEX IF NOT EXISTS idx_rag_run_sources_content_hash
    ON public.rag_run_sources (content_hash);

-- =====================================================================
-- 3. rag_feedback — 使用者對回答的 up/down 回饋
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.rag_feedback (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id     uuid NOT NULL REFERENCES public.rag_runs(id)
               ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES public.user_profiles(user_id)
               ON DELETE CASCADE,
    vote       text NOT NULL CHECK (vote IN ('up','down')),
    -- 結構化原因代碼（planned：如 not_grounded / off_topic / too_short）
    reason     text,
    comment    text CHECK (comment IS NULL OR char_length(comment) <= 2000),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- 每位使用者對同一個 run 僅一筆；改票以 upsert/update 處理
    UNIQUE (run_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_created
    ON public.rag_feedback (user_id, created_at DESC);

-- =====================================================================
-- 4. rag_eval_runs — 離線評估批次（dataset / config / code 版本與彙總）
--    （先於 rag_evaluations 建立，供其 eval_run_id FK 參照）
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.rag_eval_runs (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_version      text,
    config_version       text,
    code_version         text,
    case_count           integer NOT NULL DEFAULT 0 CHECK (case_count >= 0),
    -- 彙總指標（aggregate only，不得包含原始 query/answer）
    overall_metrics      jsonb,
    per_endpoint_metrics jsonb,
    -- 評估結果 artifact（檔名/URI）
    artifact_path        text,
    status               text NOT NULL DEFAULT 'completed'
                         CHECK (status IN ('running','completed','failed')),
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_eval_runs_created
    ON public.rag_eval_runs (created_at DESC);

-- =====================================================================
-- 5. rag_evaluations — 單筆評估（LLM judge / 人工 / heuristic）
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.rag_evaluations (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL：離線 eval case 評估，無對應線上 run
    run_id               uuid REFERENCES public.rag_runs(id)
                         ON DELETE CASCADE,
    -- 離線評估批次關聯；NULL：線上單一 run 的即時／人工評估不屬於批次
    eval_run_id          uuid REFERENCES public.rag_eval_runs(id)
                         ON DELETE CASCADE,
    -- eval case 識別（eval/rag_eval_cases.jsonl）；NULL：線上 run 評估
    case_id              text,
    -- llm_judge / human / heuristic；LLM judge 不是唯一真相（見契約文件）
    evaluator_type       text NOT NULL
                         CHECK (evaluator_type IN ('llm_judge','human','heuristic')),
    evaluator_version    text,
    faithfulness         numeric(5,2) CHECK (faithfulness >= 0 AND faithfulness <= 1),
    relevance            numeric(5,2) CHECK (relevance >= 0 AND relevance <= 1),
    citation_correctness numeric(5,2)
                         CHECK (citation_correctness >= 0 AND citation_correctness <= 1),
    completeness         numeric(5,2) CHECK (completeness >= 0 AND completeness <= 1),
    safety_score         numeric(5,2) CHECK (safety_score >= 0 AND safety_score <= 1),
    total_score          numeric(5,2) CHECK (total_score >= 0 AND total_score <= 1),
    -- NULL：未做通過判定（如人工評估尚未結案）
    passed               boolean,
    reviewer             text,
    notes                text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    -- 至少關聯 run 或 case 其中一方
    CHECK (run_id IS NOT NULL OR case_id IS NOT NULL),
    -- 離線 dataset case（case_id 非 NULL）必須能追溯到評測批次
    CHECK (case_id IS NULL OR eval_run_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_rag_evaluations_run
    ON public.rag_evaluations (run_id);
CREATE INDEX IF NOT EXISTS idx_rag_evaluations_eval_run
    ON public.rag_evaluations (eval_run_id);
CREATE INDEX IF NOT EXISTS idx_rag_evaluations_case
    ON public.rag_evaluations (case_id);

-- =====================================================================
-- RLS（Row Level Security）
--
-- 原則（詳見 docs/RAG_TRACE_DATA_CONTRACT.md §5）：
--   - authenticated 對 rag_runs / rag_run_sources 只能 SELECT 自己的資料，
--     不得 INSERT / UPDATE / DELETE（防偽造稽核紀錄與來源）。
--   - authenticated 唯一允許的寫入是 rag_feedback，且 parent run
--     必須屬於自己（INSERT、UPDATE 的新舊 run 都驗證）。
--   - 所有 runs / sources / evaluations 寫入一律由後端 service role
--     執行（service role bypasses RLS，不需要另建 policy）。
--   - rag_eval_runs 為內部離線紀錄，不建立任何 policy → 對
--     authenticated / anon 全部拒絕，僅 service role 可存取。
--   - user_id 為 NULL 的 runs（離線/背景）對一般使用者不可見。
-- =====================================================================

-- ── rag_runs：僅 SELECT 自己的資料 ──────────────────────────────────
ALTER TABLE public.rag_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rag_runs_select_own ON public.rag_runs;
CREATE POLICY rag_runs_select_own ON public.rag_runs
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());
-- 刻意不建立 INSERT / UPDATE / DELETE policy：
-- authenticated 不得寫入 rag_runs，寫入僅由 service role 執行。

-- ── rag_run_sources：僅經 parent run SELECT 自己的來源 ──────────────
ALTER TABLE public.rag_run_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rag_run_sources_select_via_own_run ON public.rag_run_sources;
CREATE POLICY rag_run_sources_select_via_own_run ON public.rag_run_sources
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.rag_runs r
        WHERE r.id = rag_run_sources.run_id
          AND r.user_id = auth.uid()
    ));
-- 刻意不建立 INSERT / UPDATE / DELETE policy：
-- authenticated 不得寫入 rag_run_sources，寫入僅由 service role 執行。

-- ── rag_feedback：只能對「自己的 run」投票，且只能管理自己的票 ──────
ALTER TABLE public.rag_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rag_feedback_select_own ON public.rag_feedback;
CREATE POLICY rag_feedback_select_own ON public.rag_feedback
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS rag_feedback_insert_own ON public.rag_feedback;
CREATE POLICY rag_feedback_insert_own ON public.rag_feedback
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.rag_runs r
            WHERE r.id = rag_feedback.run_id
              AND r.user_id = auth.uid()
        )
    );

-- UPDATE：USING 驗證「目前」parent run 屬於本人、
--         WITH CHECK 驗證「更新後」的 run_id 仍屬於本人
--         （防止把自己的 feedback 改掛到別人的 run）
DROP POLICY IF EXISTS rag_feedback_update_own ON public.rag_feedback;
CREATE POLICY rag_feedback_update_own ON public.rag_feedback
    FOR UPDATE TO authenticated
    USING (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.rag_runs r
            WHERE r.id = rag_feedback.run_id
              AND r.user_id = auth.uid()
        )
    )
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.rag_runs r
            WHERE r.id = rag_feedback.run_id
              AND r.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS rag_feedback_delete_own ON public.rag_feedback;
CREATE POLICY rag_feedback_delete_own ON public.rag_feedback
    FOR DELETE TO authenticated
    USING (user_id = auth.uid());

-- ── rag_evaluations：使用者僅能讀自己 run 的評估；寫入僅 service role ──
ALTER TABLE public.rag_evaluations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rag_evaluations_select_own_run ON public.rag_evaluations;
CREATE POLICY rag_evaluations_select_own_run ON public.rag_evaluations
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.rag_runs r
        WHERE r.id = rag_evaluations.run_id
          AND r.user_id = auth.uid()
    ));
-- 刻意不建立 INSERT / UPDATE / DELETE policy：
-- 一般使用者不能任意寫入 evaluation。

-- ── rag_eval_runs：內部離線評估，僅 service role ────────────────────
ALTER TABLE public.rag_eval_runs ENABLE ROW LEVEL SECURITY;
-- 不建立任何 policy → authenticated / anon 全部拒絕。
