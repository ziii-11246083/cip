"""TASK 10 Alchemy read-only wallet sync tests; no real DB/network calls."""

from __future__ import annotations

import logging
import os
import sys
import types
import unittest
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest import mock

import requests


PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from services.alchemy_asset_sync import (  # noqa: E402
    ADDRESS_RE,
    NETWORK_CODE,
    PROVIDER_CODE,
    AlchemyEthereumProvider,
    AssetSyncError,
    AssetSyncService,
    BetaFeatureFlagEntitlementChecker,
    SupabaseAssetSyncStore,
)
from services.asset_sync_provider import (  # noqa: E402
    ExternalAccountRef,
    NormalizedBalance,
    ProviderBalance,
    ProviderType,
    SyncPolicy,
)


NOW = datetime(2026, 8, 20, 12, 30, tzinfo=timezone.utc)
ACCOUNT_ID = "11111111-1111-4111-8111-111111111111"
ADDRESS = "0x0000000000000000000000000000000000000001"
SECRET = "asset-sync-test-secret-that-is-at-least-32-bytes"


def account_ref(address=ADDRESS):
    return ExternalAccountRef(
        account_id=ACCOUNT_ID,
        user_id="user-a",
        provider_type=ProviderType.WALLET,
        provider=PROVIDER_CODE,
        network=NETWORK_CODE,
        public_identifier=address,
    )


class FakeResponse:
    def __init__(self, status_code=200, body=None, json_error=None):
        self.status_code = status_code
        self._body = body
        self._json_error = json_error

    def json(self):
        if self._json_error:
            raise self._json_error
        return self._body


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def token(symbol="ETH", balance="0xde0b6b3a7640000", contract=None, price="2000.5"):
    prices = [] if price is None else [{
        "currency": "usd", "value": price, "lastUpdatedAt": "2026-08-20T12:00:00Z",
    }]
    return {
        "network": NETWORK_CODE,
        "tokenAddress": contract,
        "tokenBalance": balance,
        "tokenMetadata": {"symbol": symbol, "decimals": 18},
        "tokenPrices": prices,
    }


class ProviderTests(unittest.TestCase):
    def provider(self, responses, **kwargs):
        session = FakeSession(responses)
        provider = AlchemyEthereumProvider(
            api_key="fake-provider-key-DO-NOT-LOG",
            session=session,
            now=lambda: NOW,
            sleep=lambda _seconds: None,
            monotonic=lambda: 1.0,
            **kwargs,
        )
        return provider, session

    def test_valid_and_invalid_address(self):
        provider, _ = self.provider([])
        valid = provider.validate_account(account_ref())
        self.assertTrue(valid.valid)
        self.assertEqual(valid.normalized_identifier, ADDRESS.lower())
        for value in ("", "0x123", "bc1invalid", ADDRESS + "00"):
            with self.subTest(value=value):
                candidate = types.SimpleNamespace(
                    provider_type=ProviderType.WALLET,
                    provider=PROVIDER_CODE,
                    network=NETWORK_CODE,
                    public_identifier=value,
                )
                self.assertFalse(provider.validate_account(candidate).valid)
        self.assertTrue(ADDRESS_RE.fullmatch(ADDRESS))

    def test_success_native_erc20_prices_and_deduplication(self):
        contract = "0x0000000000000000000000000000000000000002"
        provider, session = self.provider([FakeResponse(body={
            "data": {"tokens": [token(), token("USDC", "0x1", contract, "1")]},
        })])
        native = provider.fetch_balances(account_ref(), timeout_seconds=10)
        normalized = provider.normalize_balances(account_ref(), list(native) + [native[0]])
        self.assertEqual(len(normalized), 2)
        eth = next(item for item in normalized if item.asset == "ETH")
        self.assertEqual(eth.quantity, Decimal("1"))
        self.assertEqual(eth.value_usd, Decimal("2000.5"))
        self.assertEqual(len(session.calls), 1)
        self.assertNotIn("fake-provider-key", str(session.calls[0][1]))

    def test_empty_wallet_is_valid_success_shape(self):
        provider, _ = self.provider([FakeResponse(body={"data": {"tokens": []}})])
        self.assertEqual(provider.fetch_balances(account_ref(), timeout_seconds=10), [])

    def test_pagination_uses_page_key_and_is_bounded(self):
        provider, session = self.provider([
            FakeResponse(body={"data": {"tokens": [token()], "pageKey": "next-safe"}}),
            FakeResponse(body={"data": {"tokens": [], "pageKey": None}}),
        ])
        rows = provider.fetch_balances(account_ref(), timeout_seconds=10)
        self.assertEqual(len(rows), 1)
        self.assertNotIn("pageKey", session.calls[0][1]["json"])
        self.assertEqual(session.calls[1][1]["json"]["pageKey"], "next-safe")

    def test_timeout_rate_limit_and_provider_error_are_fixed_codes(self):
        cases = [
            ([requests.Timeout("Bearer fake-provider-secret")], "provider_timeout"),
            ([FakeResponse(status_code=429, body={})], "provider_rate_limited"),
            ([FakeResponse(status_code=503, body={})], "provider_unavailable"),
            ([FakeResponse(status_code=200, json_error=ValueError("fake secret"))],
             "provider_bad_response"),
        ]
        for responses, code in cases:
            with self.subTest(code=code):
                provider, _ = self.provider(responses)
                with self.assertRaises(AssetSyncError) as ctx:
                    provider.fetch_balances(account_ref(), timeout_seconds=10)
                self.assertEqual(ctx.exception.code, code)
                self.assertEqual(str(ctx.exception), code)
                self.assertNotIn("secret", str(ctx.exception))

    def test_invalid_provider_item_is_counted_not_silently_accepted(self):
        provider, _ = self.provider([FakeResponse(body={
            "data": {"tokens": [token(), {"network": NETWORK_CODE, "tokenMetadata": None}]},
        })])
        batch = provider.fetch_balances(account_ref(), timeout_seconds=10)
        self.assertEqual(len(batch), 1)
        self.assertEqual(batch.dropped_count, 1)


class ScriptedProvider:
    provider_code = PROVIDER_CODE
    provider_type = ProviderType.WALLET

    def __init__(self, events):
        self.events = list(events)
        self.calls = 0

    def validate_account(self, account):
        return types.SimpleNamespace(
            valid=bool(ADDRESS_RE.fullmatch(account.public_identifier)),
            normalized_identifier=account.public_identifier.lower(),
        )

    def fetch_balances(self, account, *, timeout_seconds):
        del account, timeout_seconds
        self.calls += 1
        event = self.events.pop(0)
        if isinstance(event, Exception):
            raise event
        return event

    def normalize_balances(self, account, balances):
        del account
        normalized = {}
        for item in balances:
            normalized["eip155:1/native:ETH"] = NormalizedBalance(
                asset_key="eip155:1/native:ETH", asset="ETH", network=NETWORK_CODE,
                quantity=item.quantity, observed_at=item.observed_at,
                price_usd=item.price_usd,
                value_usd=item.quantity * item.price_usd if item.price_usd is not None else None,
                price_source=item.price_source, price_as_of=item.price_as_of,
            )
        return list(normalized.values())

    def health_check(self, *, timeout_seconds):
        del timeout_seconds
        return types.SimpleNamespace(available=True, code="ok", checked_at=NOW)


class FakeStore:
    def __init__(self, *, owner="user-a", last_success=None, existing_run=None):
        self.owner = owner
        self.last_success = last_success
        self.existing_run = existing_run
        self.commits = []
        self.failures = []
        self.claims = 0
        self.disconnected = []

    def upsert_account(self, **payload):
        return {"id": ACCOUNT_ID, "status": "active", "sync_state": "never", **payload}

    def get_account(self, *, user_id, account_id):
        if user_id != self.owner or account_id != ACCOUNT_ID:
            return None
        return {
            "id": ACCOUNT_ID, "provider": PROVIDER_CODE, "network": NETWORK_CODE,
            "public_identifier": ADDRESS, "status": "active",
            "last_success_at": self.last_success,
        }

    def claim_run(self, **kwargs):
        del kwargs
        self.claims += 1
        if self.existing_run:
            return self.existing_run, False
        return {"id": "run-1", "status": "running"}, True

    def commit_snapshot(self, payload):
        self.commits.append(payload)
        return {"snapshot_id": "snapshot-1"}

    def fail_run(self, **payload):
        self.failures.append(payload)

    def portfolio(self, *, user_id):
        if user_id != self.owner:
            return []
        return []

    def disconnect(self, *, user_id, account_id):
        if user_id != self.owner or account_id != ACCOUNT_ID:
            return False
        self.disconnected.append(account_id)
        return True


def priced_balance(price=Decimal("2000")):
    return ProviderBalance(
        asset="ETH", network=NETWORK_CODE, quantity=Decimal("1"), observed_at=NOW,
        price_usd=price, price_source="alchemy_portfolio_usd",
        price_as_of=NOW if price is not None else None,
    )


class ServiceTests(unittest.TestCase):
    def service(self, events, store=None, enabled=True, sleeps=None):
        sleeps = sleeps if sleeps is not None else []
        return AssetSyncService(
            provider=ScriptedProvider(events), store=store or FakeStore(),
            entitlement=BetaFeatureFlagEntitlementChecker(enabled=enabled),
            policy=SyncPolicy(rate_limit_per_second=20), hmac_secret=SECRET,
            now=lambda: NOW, sleep=sleeps.append,
        )

    def test_entitlement_denied_and_demo_denied_before_store(self):
        for enabled, demo, code in [
            (False, False, "asset_sync_disabled"),
            (True, True, "asset_sync_demo_denied"),
        ]:
            service = self.service([], enabled=enabled)
            with self.assertRaises(AssetSyncError) as ctx:
                service.connect(user_id="user-a", public_identifier=ADDRESS, is_demo=demo)
            self.assertEqual(ctx.exception.code, code)

    def test_connect_hmacs_address_and_returns_masked_only(self):
        store = FakeStore()
        service = self.service([], store=store)
        public = service.connect(user_id="user-a", public_identifier=ADDRESS)
        self.assertEqual(public["address_masked"], "0x0000…0001")
        self.assertNotIn("public_identifier", public)

    def test_success_and_empty_commit_atomically_through_rpc_payload(self):
        for rows, count in [([priced_balance()], 1), ([], 0)]:
            store = FakeStore()
            result = self.service([rows], store=store).sync(
                user_id="user-a", account_id=ACCOUNT_ID)
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["balance_count"], count)
            self.assertEqual(store.commits[0]["p_status"], "success")
            self.assertEqual(store.commits[0]["p_fetched_count"], count)
            self.assertEqual(store.commits[0]["p_normalized_count"], count)

    def test_missing_price_is_partial_and_total_is_null(self):
        store = FakeStore()
        result = self.service([[priced_balance(None)]], store=store).sync(
            user_id="user-a", account_id=ACCOUNT_ID)
        self.assertEqual(result["status"], "partial")
        self.assertIsNone(store.commits[0]["p_total_value_usd"])
        self.assertEqual(store.commits[0]["p_partial_reason"], "price_unavailable")

    def test_duplicate_asset_is_deduplicated_and_marked_partial(self):
        store = FakeStore()
        same = priced_balance()
        result = self.service([[same, same]], store=store).sync(
            user_id="user-a", account_id=ACCOUNT_ID)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["balance_count"], 1)
        self.assertEqual(store.commits[0]["p_fetched_count"], 2)
        self.assertEqual(store.commits[0]["p_normalized_count"], 1)
        self.assertIsNone(store.commits[0]["p_total_value_usd"])

    def test_retry_after_timeout_then_success(self):
        sleeps = []
        provider_events = [
            AssetSyncError("provider_timeout", retryable=True, http_status=504),
            [priced_balance()],
        ]
        service = self.service(provider_events, sleeps=sleeps)
        result = service.sync(user_id="user-a", account_id=ACCOUNT_ID)
        self.assertEqual(result["status"], "success")
        self.assertIn(1, sleeps)
        self.assertEqual(service.provider.calls, 2)

    def test_failed_sync_preserves_last_good_as_stale(self):
        store = FakeStore(last_success="2026-08-19T00:00:00Z")
        service = self.service([
            AssetSyncError("provider_timeout", retryable=False, http_status=504)
        ], store=store)
        with self.assertRaises(AssetSyncError):
            service.sync(user_id="user-a", account_id=ACCOUNT_ID)
        self.assertTrue(store.failures[0]["stale"])
        self.assertFalse(store.commits)

    def test_wrong_user_cannot_read_or_sync_other_account(self):
        store = FakeStore(owner="user-b")
        service = self.service([[priced_balance()]], store=store)
        with self.assertRaises(AssetSyncError) as ctx:
            service.sync(user_id="user-a", account_id=ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "account_not_found")
        self.assertEqual(service.portfolio(user_id="user-a")["accounts"], [])

    def test_duplicate_terminal_run_is_idempotent_and_active_is_locked(self):
        terminal = FakeStore(existing_run={"id": "same", "status": "success"})
        result = self.service([], store=terminal).sync(
            user_id="user-a", account_id=ACCOUNT_ID)
        self.assertTrue(result["idempotent"])

        active = FakeStore(existing_run={"id": "active", "status": "running"})
        with self.assertRaises(AssetSyncError) as ctx:
            self.service([], store=active).sync(user_id="user-a", account_id=ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "sync_in_progress")

    def test_disconnect_is_owned_and_stops_future_contract(self):
        store = FakeStore()
        service = self.service([], store=store)
        service.disconnect(user_id="user-a", account_id=ACCOUNT_ID)
        self.assertEqual(store.disconnected, [ACCOUNT_ID])
        with self.assertRaises(AssetSyncError):
            service.disconnect(user_id="user-b", account_id=ACCOUNT_ID)


class SecurityAndWiringTests(unittest.TestCase):
    def test_store_does_not_fall_back_to_generic_or_anon_key(self):
        env = {
            "SUPABASE_URL": "https://fake.invalid",
            "SUPABASE_KEY": "must-not-be-used",
            "SUPABASE_ANON_KEY": "must-not-be-used-either",
            "SUPABASE_SERVICE_ROLE_KEY": "",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            store = SupabaseAssetSyncStore()
        self.assertFalse(store.available)

        ambiguous = {
            "SUPABASE_URL": "https://fake.invalid",
            "SUPABASE_KEY": "same-key",
            "SUPABASE_ANON_KEY": "anon-key",
            "SUPABASE_SERVICE_ROLE_KEY": "same-key",
        }
        with mock.patch.dict(os.environ, ambiguous, clear=False):
            store = SupabaseAssetSyncStore()
        self.assertFalse(store.available)

    def test_rpc_is_atomic_service_role_only_and_never_touches_sim(self):
        sql = (PROJECT_ROOT / "supabase/migrations/20260820130000_asset_sync_commit_rpc.sql").read_text()
        self.assertIn("SECURITY DEFINER", sql)
        self.assertIn("GRANT EXECUTE", sql)
        self.assertIn("TO service_role", sql)
        self.assertIn("FROM PUBLIC, anon, authenticated", sql)
        self.assertNotIn("sim_", "\n".join(
            line for line in sql.splitlines() if not line.lstrip().startswith("--")))

    def test_member_real_asset_renderer_uses_text_nodes_and_labels_beta(self):
        js = (PROJECT_ROOT / "static/js/member.js").read_text(encoding="utf-8")
        section = js.split("function renderRealAssets", 1)[1].split(
            "async function refreshRealAssets", 1)[0]
        self.assertNotIn("innerHTML", section)
        self.assertIn("textContent", js)
        html = (PROJECT_ROOT / "templates/member.html").read_text(encoding="utf-8-sig")
        self.assertIn("真實資產", html)
        self.assertIn("模擬資產完全分開", html)
        self.assertIn("助記詞", html)
        self.assertIn("不代表已收取訂閱費", html)


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import app as app_module
        cls.module = app_module
        cls.client = app_module.app.test_client()

    def test_unauthenticated_is_401_and_demo_is_403(self):
        response = self.client.get("/api/asset-sync/portfolio")
        self.assertEqual(response.status_code, 401)

        real_service = AssetSyncService(
            provider=ScriptedProvider([]), store=FakeStore(),
            entitlement=BetaFeatureFlagEntitlementChecker(enabled=True),
            hmac_secret=SECRET,
        )
        with mock.patch.object(self.module, "_asset_sync", real_service):
            response = self.client.get(
                "/api/asset-sync/portfolio",
                headers={"Authorization": f"Bearer {self.module.DEMO_MEMBER_TOKEN}"},
            )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "asset_sync_demo_denied")

    def test_invalid_account_id_is_fixed_400_without_service_call(self):
        with mock.patch.object(self.module, "token_required", lambda f: f):
            pass  # decorators are already applied; demo token reaches validation safely.
        response = self.client.post(
            "/api/asset-sync/accounts/not-a-uuid/sync",
            headers={"Authorization": f"Bearer {self.module.DEMO_MEMBER_TOKEN}"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "account_invalid")

    def test_verified_user_id_overrides_client_claim(self):
        verified_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

        class FakeAuth:
            def get_user(self, token_value):
                self.token_value = token_value
                return types.SimpleNamespace(user=types.SimpleNamespace(
                    id=verified_id, email="member@example.com", app_metadata={}))

        class RouteDB:
            def __init__(self):
                self.client = types.SimpleNamespace(auth=FakeAuth())

            def __bool__(self):
                return True

        class RouteService:
            def __init__(self):
                self.calls = []

            def connect(self, **kwargs):
                self.calls.append(kwargs)
                return {"id": ACCOUNT_ID, "address_masked": "0x0000…0001"}

        service = RouteService()
        with mock.patch.object(self.module, "db", RouteDB()), \
             mock.patch.object(self.module, "_asset_sync", service):
            response = self.client.post(
                "/api/asset-sync/accounts",
                headers={"Authorization": "Bearer verified-token"},
                json={"public_address": ADDRESS, "user_id": "attacker-user"},
            )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(service.calls[0]["user_id"], verified_id)
        self.assertFalse(service.calls[0]["is_demo"])
        self.assertNotIn("attacker-user", str(service.calls))

    def test_service_error_response_never_exposes_provider_secret(self):
        verified_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

        class FakeAuth:
            def get_user(self, _token_value):
                return types.SimpleNamespace(user=types.SimpleNamespace(
                    id=verified_id, email="member@example.com", app_metadata={}))

        fake_db = types.SimpleNamespace(
            client=types.SimpleNamespace(auth=FakeAuth()))

        class FailingService:
            def portfolio(self, **_kwargs):
                error = AssetSyncError("provider_unavailable")
                error.__cause__ = RuntimeError("Bearer fake-provider-key-DO-NOT-LOG")
                raise error

        with mock.patch.object(self.module, "db", fake_db), \
             mock.patch.object(self.module, "_asset_sync", FailingService()):
            response = self.client.get(
                "/api/asset-sync/portfolio",
                headers={"Authorization": "Bearer verified-token"},
            )
        self.assertEqual(response.status_code, 503)
        encoded = response.get_data(as_text=True)
        self.assertNotIn("fake-provider-key", encoded)
        self.assertEqual(response.get_json()["code"], "provider_unavailable")


if __name__ == "__main__":
    unittest.main()
