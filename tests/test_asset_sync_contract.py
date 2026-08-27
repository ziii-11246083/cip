"""TASK 09 asset-sync contract tests (no DB and no network)."""

from __future__ import annotations

import subprocess
import sys
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from services.asset_sync_provider import (  # noqa: E402
    AccountValidation,
    AssetSourceKind,
    AssetSyncProvider,
    DenyByDefaultEntitlementChecker,
    ExternalAccountRef,
    NormalizedBalance,
    ProviderBalance,
    ProviderHealth,
    ProviderType,
    SyncPolicy,
    SyncStatus,
    build_idempotency_key,
    can_transition,
)


NOW = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)


def valid_account(**overrides):
    values = {
        "account_id": "account-1",
        "user_id": "user-1",
        "provider_type": ProviderType.WALLET,
        "provider": "provider-under-review",
        "network": "network-under-review",
        "public_identifier": "0x0000000000000000000000000000000000000001",
    }
    values.update(overrides)
    return ExternalAccountRef(**values)


class FakeProvider(AssetSyncProvider):
    provider_code = "fake"
    provider_type = ProviderType.WALLET

    def validate_account(self, account):
        return AccountValidation(True, account.public_identifier.lower())

    def fetch_balances(self, account, *, timeout_seconds):
        del account, timeout_seconds
        return [ProviderBalance("ETH", "test", Decimal("1"), NOW)]

    def normalize_balances(self, account, balances):
        del account
        return [
            NormalizedBalance(
                asset_key="test/native:ETH",
                asset=item.asset,
                network=item.network,
                quantity=item.quantity,
                observed_at=item.observed_at,
            )
            for item in balances
        ]

    def health_check(self, *, timeout_seconds):
        del timeout_seconds
        return ProviderHealth(True, "ok", NOW)


class ProviderContractTests(unittest.TestCase):
    def test_abstract_provider_cannot_be_instantiated(self):
        with self.assertRaises(TypeError):
            AssetSyncProvider()

    def test_exact_contract_can_be_implemented_without_network(self):
        provider = FakeProvider()
        account = valid_account()
        self.assertTrue(provider.validate_account(account).valid)
        native = provider.fetch_balances(account, timeout_seconds=10)
        normalized = provider.normalize_balances(account, native)
        self.assertEqual(normalized[0].asset_key, "test/native:ETH")
        self.assertEqual(provider.health_check(timeout_seconds=10).code, "ok")

    def test_account_accepts_real_public_identifier_only(self):
        self.assertEqual(valid_account().source_kind, AssetSourceKind.REAL)
        for source in (AssetSourceKind.MANUAL, AssetSourceKind.SIMULATED):
            with self.assertRaisesRegex(ValueError, "asset_source_not_real"):
                valid_account(source_kind=source)
        with self.assertRaisesRegex(ValueError, "provider_type_not_enabled"):
            valid_account(provider_type=ProviderType.EXCHANGE)
        with self.assertRaisesRegex(ValueError, "credential_reference_not_enabled"):
            valid_account(credential_reference="vault://not-enabled")

    def test_normalized_balance_rejects_negative_or_naive_values(self):
        kwargs = {
            "asset_key": "test/native:ETH",
            "asset": "ETH",
            "network": "test",
            "quantity": Decimal("1"),
            "observed_at": NOW,
        }
        with self.assertRaisesRegex(ValueError, "quantity_negative"):
            NormalizedBalance(**{**kwargs, "quantity": Decimal("-0.1")})
        with self.assertRaisesRegex(ValueError, "timestamp_naive"):
            NormalizedBalance(**{**kwargs, "observed_at": NOW.replace(tzinfo=None)})

    def test_sync_policy_is_bounded(self):
        self.assertEqual(SyncPolicy().max_attempts, 3)
        invalid = (
            {"timeout_seconds": 0},
            {"max_attempts": 6},
            {"initial_backoff_seconds": -1},
            {"initial_backoff_seconds": 9, "max_backoff_seconds": 8},
            {"rate_limit_per_second": 0},
            {"rate_limit_per_second": 21},
            {"stale_after_seconds": 59},
        )
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                SyncPolicy(**kwargs)

    def test_state_machine_rejects_terminal_or_skipped_transitions(self):
        self.assertTrue(can_transition(SyncStatus.QUEUED, SyncStatus.RUNNING))
        self.assertTrue(can_transition(SyncStatus.RUNNING, SyncStatus.PARTIAL))
        self.assertFalse(can_transition(SyncStatus.QUEUED, SyncStatus.SUCCESS))
        for terminal in (
            SyncStatus.SUCCESS,
            SyncStatus.PARTIAL,
            SyncStatus.FAILED,
            SyncStatus.STALE,
        ):
            self.assertFalse(can_transition(terminal, SyncStatus.RUNNING))

    def test_idempotency_key_is_deterministic_and_scoped(self):
        first = build_idempotency_key(
            account_id="account-1", trigger="manual", bucket_started_at=NOW)
        same = build_idempotency_key(
            account_id="account-1", trigger="manual", bucket_started_at=NOW)
        self.assertEqual(first, same)
        self.assertEqual(len(first), 64)
        self.assertNotEqual(
            first,
            build_idempotency_key(
                account_id="account-2", trigger="manual", bucket_started_at=NOW),
        )
        self.assertNotEqual(
            first,
            build_idempotency_key(
                account_id="account-1", trigger="retry", bucket_started_at=NOW),
        )
        with self.assertRaisesRegex(ValueError, "timestamp_naive"):
            build_idempotency_key(
                account_id="account-1",
                trigger="manual",
                bucket_started_at=NOW.replace(tzinfo=None),
            )

    def test_entitlement_placeholder_fails_closed(self):
        decision = DenyByDefaultEntitlementChecker().check(
            user_id="user-1", entitlement_key="asset_sync")
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reason_code, "entitlement_backend_unavailable")


class StaticContractTests(unittest.TestCase):
    def test_static_validator_passes_without_database(self):
        result = subprocess.run(
            [sys.executable, "scripts/validate_asset_sync_migration.py"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("STATIC ONLY", result.stdout)


if __name__ == "__main__":
    unittest.main()
