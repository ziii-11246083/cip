-- =====================================================================
-- TASK 09 — real asset-sync foundation (provider-neutral, no API calls)
--
-- Creates four isolated REAL-asset tables. They do not reference or write
-- sim_* tables and do not represent manual holdings. This migration stores
-- public identifiers, never mnemonic/private-key/API-secret material.
--
-- Not executed by this task. Review docs/ASSET_SYNC_DATA_CONTRACT.md first.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. One user-owned public-address connection. TASK 09 only enables wallet
-- / public-address mode; exchange credentials require a future migration.
CREATE TABLE IF NOT EXISTS public.external_accounts (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  uuid NOT NULL REFERENCES public.user_profiles(user_id)
                             ON DELETE CASCADE,
    source_kind              text NOT NULL DEFAULT 'real'
                             CHECK (source_kind = 'real'),
    provider_type            text NOT NULL DEFAULT 'wallet'
                             CHECK (provider_type = 'wallet'),
    provider                 text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 50),
    network                  text NOT NULL CHECK (char_length(network) BETWEEN 1 AND 50),
    public_identifier        text NOT NULL
                             CHECK (char_length(public_identifier) BETWEEN 1 AND 512),
    -- keyed HMAC-SHA-256 over the canonical public identifier. The HMAC key
    -- stays server-side and is never stored in this table.
    identifier_hmac          text NOT NULL CHECK (identifier_hmac ~ '^[0-9a-f]{64}$'),
    label                    text CHECK (label IS NULL OR char_length(label) <= 100),
    entitlement_key          text NOT NULL DEFAULT 'asset_sync'
                             CHECK (entitlement_key = 'asset_sync'),
    -- Reserved as an opaque vault-reference slot. Deliberately forced NULL
    -- in TASK 09: no exchange credential or secret may be persisted yet.
    credential_reference     text CHECK (credential_reference IS NULL),
    status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','disconnected','disabled')),
    sync_state               text NOT NULL DEFAULT 'never'
                             CHECK (sync_state IN ('never','success','partial','failed','stale')),
    last_sync_at             timestamptz,
    last_success_at          timestamptz,
    last_error_code          text
                             CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 64),
    disconnected_at          timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (status = 'disconnected' AND disconnected_at IS NOT NULL)
        OR (status <> 'disconnected' AND disconnected_at IS NULL)
    ),
    CHECK (
        last_success_at IS NULL
        OR (last_sync_at IS NOT NULL AND last_success_at <= last_sync_at)
    ),
    UNIQUE (user_id, provider, network, identifier_hmac)
);

CREATE INDEX IF NOT EXISTS idx_external_accounts_user_status
    ON public.external_accounts (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_accounts_sync_state
    ON public.external_accounts (sync_state, last_sync_at);

-- 2. One idempotent synchronization attempt. The partial unique index is the
-- DB-side lock: at most one queued/running run exists per account.
CREATE TABLE IF NOT EXISTS public.asset_sync_runs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_account_id   uuid NOT NULL REFERENCES public.external_accounts(id)
                          ON DELETE CASCADE,
    idempotency_key       text NOT NULL
                          CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
    trigger_type          text NOT NULL
                          CHECK (trigger_type IN ('manual','scheduled','retry')),
    status                text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','running','success','partial','failed','stale')),
    attempt_count         integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 5),
    timeout_seconds       integer NOT NULL DEFAULT 10 CHECK (timeout_seconds BETWEEN 1 AND 60),
    fetched_count         integer NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
    normalized_count      integer NOT NULL DEFAULT 0 CHECK (normalized_count >= 0),
    persisted_count       integer NOT NULL DEFAULT 0 CHECK (persisted_count >= 0),
    error_code            text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
    retry_after_at        timestamptz,
    started_at            timestamptz,
    completed_at          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
    CHECK (
        (status IN ('queued','running') AND completed_at IS NULL)
        OR (status IN ('success','partial','failed','stale') AND completed_at IS NOT NULL)
    ),
    UNIQUE (external_account_id, idempotency_key),
    UNIQUE (id, external_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_sync_runs_one_active
    ON public.asset_sync_runs (external_account_id)
    WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_asset_sync_runs_account_created
    ON public.asset_sync_runs (external_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_sync_runs_retry
    ON public.asset_sync_runs (retry_after_at)
    WHERE status = 'failed' AND retry_after_at IS NOT NULL;

-- 3. Immutable normalized snapshot. Failed/stale runs create no new last-good
-- snapshot. A partial snapshot may become last-good only when the orchestration
-- policy explicitly accepts its completeness.
CREATE TABLE IF NOT EXISTS public.asset_snapshots (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_account_id   uuid NOT NULL REFERENCES public.external_accounts(id)
                          ON DELETE CASCADE,
    sync_run_id           uuid NOT NULL,
    source_kind           text NOT NULL DEFAULT 'real' CHECK (source_kind = 'real'),
    status                text NOT NULL CHECK (status IN ('success','partial')),
    provider              text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 50),
    network               text NOT NULL CHECK (char_length(network) BETWEEN 1 AND 50),
    balance_count         integer NOT NULL CHECK (balance_count >= 0),
    total_value_usd       numeric(38,12)
                          CHECK (total_value_usd IS NULL OR total_value_usd >= 0),
    price_source          text
                          CHECK (price_source IS NULL OR char_length(price_source) <= 80),
    price_as_of           timestamptz,
    captured_at           timestamptz NOT NULL,
    is_last_good          boolean NOT NULL DEFAULT false,
    created_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (sync_run_id, external_account_id)
        REFERENCES public.asset_sync_runs(id, external_account_id)
        ON DELETE CASCADE,
    UNIQUE (sync_run_id),
    UNIQUE (id, external_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_snapshots_one_last_good
    ON public.asset_snapshots (external_account_id)
    WHERE is_last_good;
CREATE INDEX IF NOT EXISTS idx_asset_snapshots_account_captured
    ON public.asset_snapshots (external_account_id, captured_at DESC);

-- 4. Snapshot line items. asset_key is adapter-canonical and avoids symbol-only
-- collisions (for example native ETH vs a token with a misleading symbol).
CREATE TABLE IF NOT EXISTS public.asset_balances (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id           uuid NOT NULL,
    external_account_id   uuid NOT NULL,
    source_kind           text NOT NULL DEFAULT 'real' CHECK (source_kind = 'real'),
    provider              text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 50),
    network               text NOT NULL CHECK (char_length(network) BETWEEN 1 AND 50),
    asset_key             text NOT NULL CHECK (char_length(asset_key) BETWEEN 1 AND 200),
    asset_symbol          text NOT NULL CHECK (char_length(asset_symbol) BETWEEN 1 AND 40),
    contract_address      text
                          CHECK (contract_address IS NULL OR char_length(contract_address) <= 512),
    quantity              numeric(38,18) NOT NULL CHECK (quantity >= 0),
    price_usd             numeric(38,12) CHECK (price_usd IS NULL OR price_usd >= 0),
    value_usd             numeric(38,12) CHECK (value_usd IS NULL OR value_usd >= 0),
    price_source          text
                          CHECK (price_source IS NULL OR char_length(price_source) <= 80),
    price_as_of           timestamptz,
    observed_at           timestamptz NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (snapshot_id, external_account_id)
        REFERENCES public.asset_snapshots(id, external_account_id)
        ON DELETE CASCADE,
    UNIQUE (snapshot_id, asset_key)
);

CREATE INDEX IF NOT EXISTS idx_asset_balances_account_asset
    ON public.asset_balances (external_account_id, asset_key);
CREATE INDEX IF NOT EXISTS idx_asset_balances_snapshot
    ON public.asset_balances (snapshot_id);

-- RLS: authenticated users can read only their own normalized records. No
-- authenticated INSERT/UPDATE/DELETE policies are created. A future server
-- route must verify JWT ownership + entitlement before service-role writes.
ALTER TABLE public.external_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS external_accounts_select_own ON public.external_accounts;
CREATE POLICY external_accounts_select_own ON public.external_accounts
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS asset_sync_runs_select_own ON public.asset_sync_runs;
CREATE POLICY asset_sync_runs_select_own ON public.asset_sync_runs
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.external_accounts account
        WHERE account.id = asset_sync_runs.external_account_id
          AND account.user_id = auth.uid()
    ));

DROP POLICY IF EXISTS asset_snapshots_select_own ON public.asset_snapshots;
CREATE POLICY asset_snapshots_select_own ON public.asset_snapshots
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.external_accounts account
        WHERE account.id = asset_snapshots.external_account_id
          AND account.user_id = auth.uid()
    ));

DROP POLICY IF EXISTS asset_balances_select_own ON public.asset_balances;
CREATE POLICY asset_balances_select_own ON public.asset_balances
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.external_accounts account
        WHERE account.id = asset_balances.external_account_id
          AND account.user_id = auth.uid()
    ));

-- Defense in depth: anon has no table privileges; authenticated is explicitly
-- read-only. Service-role privileges/RLS bypass are managed by Supabase.
REVOKE ALL ON public.external_accounts FROM anon, authenticated;
REVOKE ALL ON public.asset_sync_runs FROM anon, authenticated;
REVOKE ALL ON public.asset_snapshots FROM anon, authenticated;
REVOKE ALL ON public.asset_balances FROM anon, authenticated;

GRANT SELECT ON public.external_accounts TO authenticated;
GRANT SELECT ON public.asset_sync_runs TO authenticated;
GRANT SELECT ON public.asset_snapshots TO authenticated;
GRANT SELECT ON public.asset_balances TO authenticated;

COMMENT ON COLUMN public.external_accounts.public_identifier IS
    'Public blockchain identifier; private user data protected by RLS, never a mnemonic/private key.';
COMMENT ON COLUMN public.external_accounts.credential_reference IS
    'Reserved opaque vault reference; CHECK forces NULL in TASK 09.';
COMMENT ON COLUMN public.external_accounts.last_error_code IS
    'Fixed allowlisted code only; no provider exception or identifier.';
COMMENT ON TABLE public.asset_snapshots IS
    'Immutable normalized REAL-asset snapshot; failed/stale runs preserve previous last-good snapshot.';
