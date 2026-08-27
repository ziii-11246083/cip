#!/usr/bin/env python3
"""Static-only TASK 10 validator. Never connects to DB or provider."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    provider = (ROOT / "services/alchemy_asset_sync.py").read_text(encoding="utf-8")
    rpc = (ROOT / "supabase/migrations/20260820130000_asset_sync_commit_rpc.sql").read_text(encoding="utf-8")
    app = (ROOT / "app.py").read_text(encoding="utf-8")
    html = (ROOT / "templates/member.html").read_text(encoding="utf-8-sig")
    js = (ROOT / "static/js/member.js").read_text(encoding="utf-8")
    contract = (ROOT / "docs/ASSET_SYNC_DATA_CONTRACT.md").read_text(encoding="utf-8")
    executable_rpc = "\n".join(
        line for line in rpc.splitlines() if not line.lstrip().startswith("--"))

    checks = []

    def check(value, label):
        checks.append((bool(value), label))

    check("APPROVED_PROVIDER: Alchemy Portfolio API" in contract, "provider is approved")
    check("APPROVED_NETWORK: Ethereum Mainnet (eth-mainnet)" in contract, "single network is approved")
    check("assets/tokens/by-address" in provider, "adapter uses approved read-only portfolio endpoint")
    check('NETWORK_CODE = "eth-mainnet"' in provider, "adapter is single-network")
    check("pageKey" in provider and "range(10)" in provider, "pagination is bounded")
    check("provider_timeout" in provider and "provider_rate_limited" in provider, "provider failures use fixed codes")
    check("max_attempts" in provider and "initial_backoff_seconds" in provider, "retry/backoff is bounded")
    check("rate_limit_per_second" in provider and "_request_lock" in provider, "HTTP calls are rate limited")
    check("SUPABASE_SERVICE_ROLE_KEY" in provider, "writes require explicit service-role env")
    check("SUPABASE_ANON_KEY" in provider and "SUPABASE_KEY" in provider, "ambiguous write credentials are rejected")
    check("ASSET_SYNC_HMAC_SECRET" in provider, "public identifier has separate keyed HMAC secret")
    check("ASSET_SYNC_ENABLED" in provider, "entitlement is server feature flag")
    check("asset_sync_demo_denied" in provider, "demo entitlement fails closed")
    check("CREATE OR REPLACE FUNCTION public.asset_sync_commit_snapshot" in rpc, "atomic snapshot RPC exists")
    check("SECURITY DEFINER" in rpc and "SET search_path = ''" in rpc, "RPC pins safe search path")
    check("FOR UPDATE" in rpc, "RPC locks account and run")
    check("FROM PUBLIC, anon, authenticated" in rpc, "RPC execution revoked from clients")
    check("TO service_role" in rpc, "RPC execution granted only to service role")
    check("p_status = 'success'" in rpc and "is_last_good" in rpc, "only success switches last-good")
    check("sim_" not in executable_rpc, "RPC never writes simulated tables")
    check("eth_send" not in provider and "send_transaction" not in provider, "adapter has no transaction method")
    check("/api/asset-sync/accounts" in app and "/api/asset-sync/portfolio" in app, "protected API routes exist")
    check(app.count("@token_required\ndef asset_sync_") == 4, "all four asset routes require auth")
    check("真實資產" in html and "模擬資產完全分開" in html, "UI separates real and simulated assets")
    check("助記詞" in html and "私鑰" in html, "UI states secret safety boundary")
    check("不代表已收取訂閱費" in html, "UI does not claim paid entitlement")
    renderer = js.split("function renderRealAssets", 1)[1].split(
        "async function refreshRealAssets", 1)[0]
    check("innerHTML" not in renderer and "textContent" in js, "provider data renders without innerHTML")
    check("price_as_of" in js and "price_source" in js, "UI displays price source and time")

    failures = 0
    for passed, label in checks:
        print(f"[{'PASS' if passed else 'FAIL'}] {label}")
        failures += int(not passed)
    print("-" * 60)
    print(f"checks={len(checks)} failures={failures}")
    print("STATIC ONLY: no DB connection and no provider request")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
