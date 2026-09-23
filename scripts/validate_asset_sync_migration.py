#!/usr/bin/env python3
"""Static, stdlib-only validation for the TASK 09 asset-sync foundation.

This script never connects to a database and never executes SQL.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Iterable, List, Tuple


PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATION = PROJECT_ROOT / "supabase/migrations/20260820120000_asset_sync_foundation.sql"
CONTRACT = PROJECT_ROOT / "docs/ASSET_SYNC_DATA_CONTRACT.md"
INTERFACE = PROJECT_ROOT / "services/asset_sync_provider.py"
TABLES = (
    "external_accounts",
    "asset_sync_runs",
    "asset_snapshots",
    "asset_balances",
)


def _has(pattern: str, text: str, flags: int = re.IGNORECASE | re.DOTALL) -> bool:
    return re.search(pattern, text, flags) is not None


def validate() -> List[Tuple[bool, str]]:
    sql = MIGRATION.read_text(encoding="utf-8")
    executable_sql = re.sub(r"--[^\n]*", "", sql)
    contract = CONTRACT.read_text(encoding="utf-8")
    interface = INTERFACE.read_text(encoding="utf-8")
    checks: List[Tuple[bool, str]] = []

    def check(condition: bool, label: str) -> None:
        checks.append((bool(condition), label))

    for table in TABLES:
        check(
            _has(rf"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.{table}\s*\(", sql),
            f"table {table} uses CREATE TABLE IF NOT EXISTS",
        )
        check(
            _has(rf"ALTER\s+TABLE\s+public\.{table}\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY", sql),
            f"table {table} enables RLS",
        )
        check(
            _has(rf"GRANT\s+SELECT\s+ON\s+public\.{table}\s+TO\s+authenticated", sql),
            f"table {table} grants authenticated SELECT only",
        )
        check(
            not _has(rf"GRANT\s+(?:INSERT|UPDATE|DELETE).*public\.{table}.*authenticated", sql),
            f"table {table} has no authenticated write grant",
        )

    required_columns = {
        "external_accounts": (
            "user_id", "source_kind", "provider_type", "provider", "network",
            "public_identifier", "identifier_hmac", "entitlement_key",
            "credential_reference", "status", "sync_state", "last_sync_at",
            "last_success_at", "last_error_code", "created_at", "updated_at",
        ),
        "asset_sync_runs": (
            "external_account_id", "idempotency_key", "trigger_type", "status",
            "attempt_count", "timeout_seconds", "fetched_count", "normalized_count",
            "persisted_count", "error_code", "started_at", "completed_at",
        ),
        "asset_snapshots": (
            "external_account_id", "sync_run_id", "source_kind", "status",
            "provider", "network", "balance_count", "total_value_usd",
            "price_source", "price_as_of", "captured_at", "is_last_good",
        ),
        "asset_balances": (
            "snapshot_id", "external_account_id", "source_kind", "provider",
            "network", "asset_key", "asset_symbol", "contract_address",
            "quantity", "price_usd", "value_usd", "price_source", "price_as_of",
            "observed_at",
        ),
    }
    for table, columns in required_columns.items():
        body_match = re.search(
            rf"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.{table}\s*\((.*?)\n\);",
            sql,
            re.IGNORECASE | re.DOTALL,
        )
        body = body_match.group(1) if body_match else ""
        for column in columns:
            check(_has(rf"^\s*{column}\s+", body, re.IGNORECASE | re.MULTILINE), f"{table}.{column} exists")

    check("REFERENCES public.user_profiles(user_id)" in sql, "ownership FK uses user_profiles.user_id")
    check("ON DELETE CASCADE" in sql, "ownership and child records define cascade deletion")
    check("CHECK (source_kind = 'real')" in sql, "real source is isolated from manual/simulated")
    check("CHECK (provider_type = 'wallet')" in sql, "TASK 09 enables public wallet concept only")
    check("CHECK (credential_reference IS NULL)" in sql, "credential reference is forced NULL")
    check("identifier_hmac ~ '^[0-9a-f]{64}$'" in sql, "identifier HMAC is 64-hex")
    check("UNIQUE (external_account_id, idempotency_key)" in sql, "idempotency key is unique per account")
    check("idx_asset_sync_runs_one_active" in sql and "WHERE status IN ('queued','running')" in sql, "one active sync lock per account")
    check("idx_asset_snapshots_one_last_good" in sql and "WHERE is_last_good" in sql, "one last-good snapshot per account")
    check("FOREIGN KEY (snapshot_id, external_account_id)" in sql, "balance composite FK prevents cross-account snapshot")
    check("FOREIGN KEY (sync_run_id, external_account_id)" in sql, "snapshot composite FK prevents cross-account run")
    check("UNIQUE (id, external_account_id)" in sql, "composite ownership targets are unique")
    check("status IN ('queued','running','success','partial','failed','stale')" in sql, "sync run status contract is complete")
    check("status IN ('success','partial')" in sql, "snapshot accepts only persisted result states")
    check(not _has(r"\bDROP\s+TABLE\b", sql), "migration has no DROP TABLE")
    check(not _has(r"\bTRUNCATE\b", sql), "migration has no TRUNCATE")
    check("sim_" not in executable_sql, "real asset migration does not reference sim tables")
    check("subscriptions" not in executable_sql, "migration does not depend on planned subscriptions table")

    identifiers = set(re.findall(r"^\s*([a-z][a-z0-9_]*)\s+", sql, re.MULTILINE))
    forbidden = {"api_key", "api_secret", "secret", "private_key", "mnemonic", "seed_phrase"}
    check(not (identifiers & forbidden), "no mnemonic/private-key/API-secret column")

    select_policies = re.findall(
        r"CREATE\s+POLICY\s+\w+\s+ON\s+public\.(\w+)\s+FOR\s+(\w+)",
        sql,
        re.IGNORECASE,
    )
    check(len(select_policies) == 4, "exactly four authenticated ownership policies exist")
    check(all(command.upper() == "SELECT" for _, command in select_policies), "all asset policies are SELECT-only")
    check(all(table in TABLES for table, _ in select_policies), "policies target only TASK 09 tables")
    check("TO anon" not in sql, "no anon policy")
    for table in TABLES[1:]:
        check(
            f"account.id = {table}.external_account_id" in sql,
            f"{table} RLS ownership reference is unambiguous",
        )

    for method in ("validate_account", "fetch_balances", "normalize_balances", "health_check"):
        check(_has(rf"def\s+{method}\s*\(", interface), f"provider interface defines {method}()")
    check("requests" not in interface and "httpx" not in interface and "urllib" not in interface, "provider contract has no network client")
    check("DenyByDefaultEntitlementChecker" in interface, "entitlement abstraction fails closed")
    check(
        "APPROVED_PROVIDER: Alchemy Portfolio API" in contract,
        "post-review provider decision is explicit",
    )
    check(
        "APPROVED_NETWORK: Ethereum Mainnet (eth-mainnet)" in contract,
        "post-review network decision is explicit and single-network",
    )
    check("PROVIDER_DECISION_REVIEWED: 2026-08-20" in contract, "provider decision records review gate")
    check("failed/stale" in contract and "last-good" in contract, "contract documents last-good preservation")
    check("Disconnect" in contract, "contract documents disconnect semantics")
    check("timeout 10s" in contract and "backoff 1s" in contract, "contract documents bounded timeout/backoff")
    return checks


def main() -> int:
    checks = validate()
    failures = 0
    for passed, label in checks:
        print(f"[{'PASS' if passed else 'FAIL'}] {label}")
        failures += int(not passed)
    print("-" * 60)
    print(f"checks={len(checks)} failures={failures}")
    print("STATIC ONLY: no DB connection and no migration execution")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
