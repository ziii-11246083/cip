-- TASK 10 — atomic commit for one reviewed real-asset sync result.
-- Not executed by this task. The function is service-role only and performs
-- no provider/network action. It cannot write simulated/manual asset tables.

CREATE OR REPLACE FUNCTION public.asset_sync_commit_snapshot(
    p_user_id uuid,
    p_account_id uuid,
    p_run_id uuid,
    p_status text,
    p_provider text,
    p_network text,
    p_captured_at timestamptz,
    p_total_value_usd numeric,
    p_price_source text,
    p_price_as_of timestamptz,
    p_balances jsonb,
    p_attempt_count integer DEFAULT 1,
    p_partial_reason text DEFAULT NULL,
    p_fetched_count integer DEFAULT 0,
    p_normalized_count integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_account public.external_accounts%ROWTYPE;
    v_run public.asset_sync_runs%ROWTYPE;
    v_snapshot_id uuid;
    v_balance_count integer;
BEGIN
    IF p_status NOT IN ('success', 'partial') THEN
        RAISE EXCEPTION 'asset_sync_status_invalid';
    END IF;
    IF p_provider <> 'alchemy_portfolio' OR p_network <> 'eth-mainnet' THEN
        RAISE EXCEPTION 'asset_sync_provider_invalid';
    END IF;
    IF p_captured_at IS NULL OR p_balances IS NULL
       OR jsonb_typeof(p_balances) <> 'array' THEN
        RAISE EXCEPTION 'asset_sync_payload_invalid';
    END IF;
    IF p_attempt_count < 1 OR p_attempt_count > 5 THEN
        RAISE EXCEPTION 'asset_sync_attempt_invalid';
    END IF;
    IF p_fetched_count < 0 OR p_normalized_count < 0
       OR p_normalized_count <> jsonb_array_length(p_balances)
       OR p_fetched_count < p_normalized_count THEN
        RAISE EXCEPTION 'asset_sync_count_invalid';
    END IF;
    IF p_status = 'partial'
       AND p_partial_reason NOT IN ('price_unavailable', 'provider_item_invalid') THEN
        RAISE EXCEPTION 'asset_sync_partial_reason_invalid';
    END IF;
    IF p_status = 'success' AND p_partial_reason IS NOT NULL THEN
        RAISE EXCEPTION 'asset_sync_partial_reason_invalid';
    END IF;

    SELECT * INTO v_account
    FROM public.external_accounts
    WHERE id = p_account_id AND user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'asset_sync_account_not_found';
    END IF;
    IF v_account.status <> 'active'
       OR v_account.provider <> p_provider
       OR v_account.network <> p_network
       OR v_account.source_kind <> 'real' THEN
        RAISE EXCEPTION 'asset_sync_account_not_active';
    END IF;

    SELECT * INTO v_run
    FROM public.asset_sync_runs
    WHERE id = p_run_id AND external_account_id = p_account_id
    FOR UPDATE;
    IF NOT FOUND OR v_run.status NOT IN ('queued', 'running') THEN
        RAISE EXCEPTION 'asset_sync_run_invalid';
    END IF;

    v_balance_count := jsonb_array_length(p_balances);

    -- Only a complete success may replace last-good. The account row lock
    -- serializes this pointer switch for the account.
    IF p_status = 'success' THEN
        UPDATE public.asset_snapshots
        SET is_last_good = false
        WHERE external_account_id = p_account_id AND is_last_good;
    END IF;

    INSERT INTO public.asset_snapshots (
        external_account_id, sync_run_id, source_kind, status,
        provider, network, balance_count, total_value_usd,
        price_source, price_as_of, captured_at, is_last_good
    ) VALUES (
        p_account_id, p_run_id, 'real', p_status,
        p_provider, p_network, v_balance_count, p_total_value_usd,
        p_price_source, p_price_as_of, p_captured_at, p_status = 'success'
    ) RETURNING id INTO v_snapshot_id;

    INSERT INTO public.asset_balances (
        snapshot_id, external_account_id, source_kind, provider, network,
        asset_key, asset_symbol, contract_address, quantity,
        price_usd, value_usd, price_source, price_as_of, observed_at
    )
    SELECT
        v_snapshot_id, p_account_id, 'real', p_provider, p_network,
        item.asset_key, item.asset, item.contract_address, item.quantity,
        item.price_usd, item.value_usd, item.price_source,
        item.price_as_of, item.observed_at
    FROM jsonb_to_recordset(p_balances) AS item(
        asset_key text,
        asset text,
        network text,
        quantity numeric,
        observed_at timestamptz,
        contract_address text,
        price_usd numeric,
        value_usd numeric,
        price_source text,
        price_as_of timestamptz
    );

    IF (SELECT count(*) FROM public.asset_balances WHERE snapshot_id = v_snapshot_id)
       <> v_balance_count THEN
        RAISE EXCEPTION 'asset_sync_balance_count_mismatch';
    END IF;

    UPDATE public.asset_sync_runs
    SET status = p_status,
        attempt_count = p_attempt_count,
        fetched_count = p_fetched_count,
        normalized_count = p_normalized_count,
        persisted_count = v_balance_count,
        error_code = p_partial_reason,
        completed_at = now(),
        updated_at = now()
    WHERE id = p_run_id AND external_account_id = p_account_id;

    UPDATE public.external_accounts
    SET sync_state = p_status,
        last_sync_at = now(),
        last_success_at = CASE WHEN p_status = 'success' THEN now() ELSE last_success_at END,
        last_error_code = p_partial_reason,
        updated_at = now()
    WHERE id = p_account_id AND user_id = p_user_id;

    RETURN jsonb_build_object(
        'snapshot_id', v_snapshot_id,
        'status', p_status,
        'balance_count', v_balance_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.asset_sync_commit_snapshot(
    uuid, uuid, uuid, text, text, text, timestamptz,
    numeric, text, timestamptz, jsonb, integer, text, integer, integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.asset_sync_commit_snapshot(
    uuid, uuid, uuid, text, text, text, timestamptz,
    numeric, text, timestamptz, jsonb, integer, text, integer, integer
) TO service_role;
