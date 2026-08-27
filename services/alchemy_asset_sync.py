"""Alchemy Ethereum Mainnet read-only asset-sync MVP (TASK 10).

The module is inert at import time. It never signs, sends transactions, or
accepts wallet secrets. Network and persistence dependencies are injectable so
tests use fakes only. All externally visible failures are fixed codes.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import requests

from services.asset_sync_provider import (
    AccountValidation,
    AssetSyncProvider,
    ExternalAccountRef,
    NormalizedBalance,
    ProviderBalance,
    ProviderHealth,
    ProviderType,
    SyncPolicy,
    build_idempotency_key,
)


logger = logging.getLogger(__name__)

PROVIDER_CODE = "alchemy_portfolio"
NETWORK_CODE = "eth-mainnet"
PRICE_SOURCE = "alchemy_portfolio_usd"
ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
SAFE_ERROR_CODES = {
    "asset_sync_disabled",
    "asset_sync_demo_denied",
    "asset_sync_not_configured",
    "asset_sync_hmac_unavailable",
    "asset_sync_store_unavailable",
    "account_invalid",
    "account_not_found",
    "account_not_active",
    "sync_in_progress",
    "provider_timeout",
    "provider_rate_limited",
    "provider_unavailable",
    "provider_bad_response",
    "normalization_failed",
    "snapshot_write_failed",
}


class AssetSyncError(RuntimeError):
    def __init__(self, code: str, *, retryable: bool = False, http_status: int = 503):
        safe = code if code in SAFE_ERROR_CODES else "provider_unavailable"
        super().__init__(safe)
        self.code = safe
        self.retryable = retryable
        self.http_status = http_status


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_timestamp(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None else None
    except (TypeError, ValueError):
        return None


class ProviderBalanceBatch(list):
    """List-compatible result carrying completeness metadata."""

    def __init__(self, values=(), *, dropped_count: int = 0):
        super().__init__(values)
        self.dropped_count = dropped_count


class BetaFeatureFlagEntitlementChecker:
    """Trusted server-side beta entitlement; never reads client plan claims."""

    def __init__(self, enabled: Optional[bool] = None):
        self.enabled = (
            enabled if enabled is not None
            else os.getenv("ASSET_SYNC_ENABLED", "0").strip().lower() in {"1", "true", "yes"}
        )

    def check(self, *, user_id: str, is_demo: bool = False) -> Tuple[bool, str]:
        if is_demo:
            return False, "asset_sync_demo_denied"
        if not user_id or not self.enabled:
            return False, "asset_sync_disabled"
        return True, "beta_feature_flag"


class AlchemyEthereumProvider(AssetSyncProvider):
    provider_code = PROVIDER_CODE
    provider_type = ProviderType.WALLET

    def __init__(
        self,
        api_key: Optional[str] = None,
        session: Any = None,
        now: Callable[[], datetime] = _utc_now,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        rate_limit_per_second: int = 2,
    ):
        self._api_key = (api_key if api_key is not None else os.getenv("ALCHEMY_API_KEY", "")).strip()
        self._session = session or requests.Session()
        self._now = now
        self._sleep = sleep
        self._monotonic = monotonic
        self._minimum_interval = 1.0 / max(1, rate_limit_per_second)
        self._request_lock = threading.Lock()
        self._last_request_at = 0.0

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    def validate_account(self, account: ExternalAccountRef) -> AccountValidation:
        if (
            account.provider_type is not ProviderType.WALLET
            or account.provider != PROVIDER_CODE
            or account.network != NETWORK_CODE
            or not ADDRESS_RE.fullmatch(account.public_identifier)
        ):
            return AccountValidation(False, error_code="account_invalid")
        return AccountValidation(True, normalized_identifier=account.public_identifier.lower())

    def _endpoint(self) -> str:
        if not self.configured:
            raise AssetSyncError("asset_sync_not_configured", http_status=503)
        return f"https://api.g.alchemy.com/data/v1/{self._api_key}/assets/tokens/by-address"

    def _post_page(self, payload: Dict[str, Any], timeout_seconds: int):
        with self._request_lock:
            elapsed = self._monotonic() - self._last_request_at
            if self._last_request_at and elapsed < self._minimum_interval:
                self._sleep(self._minimum_interval - elapsed)
            try:
                response = self._session.post(
                    self._endpoint(), json=payload, timeout=timeout_seconds,
                    headers={"Accept": "application/json"},
                )
            except requests.Timeout as exc:
                raise AssetSyncError("provider_timeout", retryable=True, http_status=504) from exc
            except requests.RequestException as exc:
                raise AssetSyncError("provider_unavailable", retryable=True) from exc
            finally:
                self._last_request_at = self._monotonic()
        return response

    def fetch_balances(
        self,
        account: ExternalAccountRef,
        *,
        timeout_seconds: int,
    ) -> Sequence[ProviderBalance]:
        validation = self.validate_account(account)
        if not validation.valid:
            raise AssetSyncError("account_invalid", http_status=400)
        payload = {
            "addresses": [{"address": validation.normalized_identifier, "networks": [NETWORK_CODE]}],
            "withMetadata": True,
            "withPrices": True,
            "includeNativeTokens": True,
            "includeErc20Tokens": True,
        }
        tokens: List[Any] = []
        page_key: Optional[str] = None
        seen_page_keys = set()
        for _page in range(10):
            page_payload = dict(payload)
            if page_key:
                page_payload["pageKey"] = page_key
            response = self._post_page(page_payload, timeout_seconds)
            if response.status_code == 429:
                raise AssetSyncError("provider_rate_limited", retryable=True, http_status=429)
            if response.status_code >= 500:
                raise AssetSyncError("provider_unavailable", retryable=True)
            if response.status_code != 200:
                raise AssetSyncError("provider_bad_response", http_status=502)
            try:
                body = response.json()
            except Exception as exc:
                raise AssetSyncError("provider_bad_response", http_status=502) from exc
            if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
                raise AssetSyncError("provider_bad_response", http_status=502)
            top_error = body.get("error")
            if isinstance(top_error, dict) and top_error.get("partialErrors"):
                # Only one network is approved; its network-level failure cannot
                # be represented as an acceptable partial snapshot.
                raise AssetSyncError("provider_unavailable", retryable=True)
            page_tokens = body["data"].get("tokens")
            if not isinstance(page_tokens, list):
                raise AssetSyncError("provider_bad_response", http_status=502)
            tokens.extend(page_tokens)
            raw_page_key = body["data"].get("pageKey")
            page_key = raw_page_key if isinstance(raw_page_key, str) and raw_page_key else None
            if not page_key:
                break
            if page_key in seen_page_keys:
                raise AssetSyncError("provider_bad_response", http_status=502)
            seen_page_keys.add(page_key)
        else:
            raise AssetSyncError("provider_bad_response", http_status=502)

        observed_at = self._now()
        result: List[ProviderBalance] = []
        dropped_count = 0
        for token in tokens:
            if not isinstance(token, dict) or token.get("network") != NETWORK_CODE:
                dropped_count += 1
                continue
            metadata = token.get("tokenMetadata")
            if not isinstance(metadata, dict):
                dropped_count += 1
                continue
            symbol = str(metadata.get("symbol") or "").strip().upper()
            decimals = metadata.get("decimals")
            raw_balance = token.get("tokenBalance")
            if not symbol or not isinstance(decimals, int) or not 0 <= decimals <= 36:
                dropped_count += 1
                continue
            try:
                atomic = int(raw_balance, 16) if isinstance(raw_balance, str) and raw_balance.startswith("0x") else int(raw_balance)
                quantity = Decimal(atomic) / (Decimal(10) ** decimals)
            except (TypeError, ValueError, InvalidOperation):
                dropped_count += 1
                continue
            if quantity <= 0:
                continue

            contract = token.get("tokenAddress")
            if contract is not None:
                contract = str(contract).lower()
                if not ADDRESS_RE.fullmatch(contract):
                    dropped_count += 1
                    continue
            price_usd = None
            price_as_of = None
            prices = token.get("tokenPrices")
            if isinstance(prices, list):
                for price in prices:
                    if isinstance(price, dict) and str(price.get("currency", "")).lower() == "usd":
                        try:
                            candidate = Decimal(str(price.get("value")))
                            if candidate.is_finite() and candidate >= 0:
                                price_usd = candidate
                                price_as_of = _parse_timestamp(price.get("lastUpdatedAt"))
                        except (InvalidOperation, TypeError, ValueError):
                            pass
                        break
            result.append(ProviderBalance(
                asset=symbol,
                network=NETWORK_CODE,
                quantity=quantity,
                observed_at=observed_at,
                contract_address=contract,
                decimals=decimals,
                price_usd=price_usd,
                price_source=PRICE_SOURCE if price_usd is not None else None,
                price_as_of=price_as_of,
            ))
        return ProviderBalanceBatch(result, dropped_count=dropped_count)

    def normalize_balances(
        self,
        account: ExternalAccountRef,
        balances: Sequence[ProviderBalance],
    ) -> Sequence[NormalizedBalance]:
        if not self.validate_account(account).valid:
            raise AssetSyncError("account_invalid", http_status=400)
        normalized: Dict[str, NormalizedBalance] = {}
        for item in balances:
            contract = item.contract_address.lower() if item.contract_address else None
            asset_key = (
                f"eip155:1/erc20:{contract}" if contract
                else "eip155:1/native:ETH"
            )
            value = item.quantity * item.price_usd if item.price_usd is not None else None
            normalized[asset_key] = NormalizedBalance(
                asset_key=asset_key,
                asset=item.asset,
                network=NETWORK_CODE,
                quantity=item.quantity,
                observed_at=item.observed_at,
                contract_address=contract,
                price_usd=item.price_usd,
                value_usd=value,
                price_source=item.price_source,
                price_as_of=item.price_as_of,
            )
        return [normalized[key] for key in sorted(normalized)]

    def health_check(self, *, timeout_seconds: int) -> ProviderHealth:
        del timeout_seconds
        return ProviderHealth(self.configured, "ok" if self.configured else "asset_sync_not_configured", self._now())


class SupabaseAssetSyncStore:
    """Service-role-only persistence. No fallback to anon or generic DB key."""

    def __init__(self, url: Optional[str] = None, service_role_key: Optional[str] = None, client: Any = None):
        self._url = (url if url is not None else os.getenv("SUPABASE_URL", "")).strip()
        self._key = (
            service_role_key if service_role_key is not None
            else os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        ).strip()
        anon_key = os.getenv("SUPABASE_ANON_KEY", "").strip()
        generic_key = os.getenv("SUPABASE_KEY", "").strip()
        if self._key and (
            (anon_key and self._key == anon_key)
            or (generic_key and self._key == generic_key)
        ):
            self._key = ""
        self._client = client

    @property
    def available(self) -> bool:
        return bool(self._client or (self._url and self._key))

    def _db(self):
        if self._client is not None:
            return self._client
        if not self._url or not self._key:
            raise AssetSyncError("asset_sync_store_unavailable")
        try:
            from supabase import create_client
            self._client = create_client(self._url, self._key)
            return self._client
        except Exception as exc:
            logger.warning("asset sync store init failed (code=asset_sync_store_unavailable)")
            raise AssetSyncError("asset_sync_store_unavailable") from exc

    def upsert_account(self, *, user_id: str, public_identifier: str, identifier_hmac: str) -> Dict[str, Any]:
        payload = {
            "user_id": user_id,
            "source_kind": "real",
            "provider_type": "wallet",
            "provider": PROVIDER_CODE,
            "network": NETWORK_CODE,
            "public_identifier": public_identifier,
            "identifier_hmac": identifier_hmac,
            "entitlement_key": "asset_sync",
            "status": "active",
            "disconnected_at": None,
        }
        try:
            response = self._db().table("external_accounts").upsert(
                payload, on_conflict="user_id,provider,network,identifier_hmac"
            ).execute()
            rows = getattr(response, "data", None) or []
            if not rows:
                raise AssetSyncError("asset_sync_store_unavailable")
            return rows[0]
        except AssetSyncError:
            raise
        except Exception as exc:
            logger.warning("asset sync account write failed (code=asset_sync_store_unavailable)")
            raise AssetSyncError("asset_sync_store_unavailable") from exc

    def get_account(self, *, user_id: str, account_id: str) -> Optional[Dict[str, Any]]:
        try:
            response = self._db().table("external_accounts").select("*").eq(
                "id", account_id).eq("user_id", user_id).limit(1).execute()
            rows = getattr(response, "data", None) or []
            return rows[0] if rows else None
        except Exception as exc:
            logger.warning("asset sync account read failed (code=asset_sync_store_unavailable)")
            raise AssetSyncError("asset_sync_store_unavailable") from exc

    def claim_run(self, *, account_id: str, idempotency_key: str, trigger: str, timeout_seconds: int) -> Tuple[Dict[str, Any], bool]:
        table = self._db().table("asset_sync_runs")
        try:
            existing = table.select("*").eq("external_account_id", account_id).eq(
                "idempotency_key", idempotency_key).limit(1).execute()
            rows = getattr(existing, "data", None) or []
            if rows:
                return rows[0], False
            response = table.insert({
                "external_account_id": account_id,
                "idempotency_key": idempotency_key,
                "trigger_type": trigger,
                "status": "running",
                "started_at": _utc_now().isoformat(),
                "timeout_seconds": timeout_seconds,
            }).execute()
            rows = getattr(response, "data", None) or []
            if not rows:
                raise AssetSyncError("asset_sync_store_unavailable")
            return rows[0], True
        except AssetSyncError:
            raise
        except Exception as exc:
            # Distinguish a verified active-run collision from a DB outage
            # without logging the raw SDK/database exception.
            try:
                active = self._db().table("asset_sync_runs").select("id,status").eq(
                    "external_account_id", account_id
                ).in_("status", ["queued", "running"]).limit(1).execute()
                if getattr(active, "data", None):
                    logger.warning("asset sync claim rejected (code=sync_in_progress)")
                    raise AssetSyncError("sync_in_progress", http_status=409) from exc
            except AssetSyncError:
                raise
            except Exception:
                pass
            logger.warning("asset sync claim failed (code=asset_sync_store_unavailable)")
            raise AssetSyncError("asset_sync_store_unavailable") from exc

    def commit_snapshot(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            response = self._db().rpc("asset_sync_commit_snapshot", payload).execute()
            data = getattr(response, "data", None)
            if isinstance(data, list):
                data = data[0] if data else None
            if not isinstance(data, dict):
                raise AssetSyncError("snapshot_write_failed")
            return data
        except AssetSyncError:
            raise
        except Exception as exc:
            logger.warning("asset sync snapshot commit failed (code=snapshot_write_failed)")
            raise AssetSyncError("snapshot_write_failed") from exc

    def fail_run(self, *, account_id: str, run_id: str, code: str, stale: bool) -> None:
        status = "stale" if stale else "failed"
        now = _utc_now().isoformat()
        try:
            self._db().table("asset_sync_runs").update({
                "status": status, "error_code": code, "completed_at": now,
                "updated_at": now,
            }).eq("id", run_id).eq("external_account_id", account_id).execute()
            self._db().table("external_accounts").update({
                "sync_state": status, "last_error_code": code,
                "last_sync_at": now, "updated_at": now,
            }).eq("id", account_id).execute()
        except Exception:
            logger.warning("asset sync failure state write failed (code=asset_sync_store_unavailable)")

    def portfolio(self, *, user_id: str) -> List[Dict[str, Any]]:
        try:
            accounts_response = self._db().table("external_accounts").select("*").eq(
                "user_id", user_id).order("created_at").execute()
            accounts = getattr(accounts_response, "data", None) or []
            output = []
            for account in accounts:
                snapshots_response = self._db().table("asset_snapshots").select("*").eq(
                    "external_account_id", account["id"]
                ).order("is_last_good", desc=True).order("captured_at", desc=True).limit(1).execute()
                snapshots = getattr(snapshots_response, "data", None) or []
                snapshot = snapshots[0] if snapshots else None
                balances = []
                if snapshot:
                    balance_response = self._db().table("asset_balances").select("*").eq(
                        "snapshot_id", snapshot["id"]).order("value_usd", desc=True).execute()
                    balances = getattr(balance_response, "data", None) or []
                output.append({"account": account, "snapshot": snapshot, "balances": balances})
            return output
        except Exception as exc:
            logger.warning("asset sync portfolio read failed (code=asset_sync_store_unavailable)")
            raise AssetSyncError("asset_sync_store_unavailable") from exc

    def disconnect(self, *, user_id: str, account_id: str) -> bool:
        now = _utc_now().isoformat()
        try:
            response = self._db().table("external_accounts").update({
                "status": "disconnected", "disconnected_at": now, "updated_at": now,
            }).eq("id", account_id).eq("user_id", user_id).eq("status", "active").execute()
            return bool(getattr(response, "data", None) or [])
        except Exception as exc:
            logger.warning("asset sync disconnect failed (code=asset_sync_store_unavailable)")
            raise AssetSyncError("asset_sync_store_unavailable") from exc


class AssetSyncService:
    def __init__(
        self,
        provider: Optional[AssetSyncProvider] = None,
        store: Optional[SupabaseAssetSyncStore] = None,
        entitlement: Optional[BetaFeatureFlagEntitlementChecker] = None,
        policy: Optional[SyncPolicy] = None,
        hmac_secret: Optional[str] = None,
        now: Callable[[], datetime] = _utc_now,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.provider = provider or AlchemyEthereumProvider()
        self.store = store or SupabaseAssetSyncStore()
        self.entitlement = entitlement or BetaFeatureFlagEntitlementChecker()
        self.policy = policy or SyncPolicy()
        self._secret = (
            hmac_secret if hmac_secret is not None
            else os.getenv("ASSET_SYNC_HMAC_SECRET", "")
        )
        self._now = now
        self._sleep = sleep
        self._rate_lock = threading.Lock()
        self._last_request_at = 0.0

    def authorize(self, *, user_id: str, is_demo: bool = False) -> None:
        allowed, reason = self.entitlement.check(user_id=user_id, is_demo=is_demo)
        if not allowed:
            raise AssetSyncError(reason, http_status=403)

    def _identifier_hmac(self, address: str) -> str:
        if len(self._secret.encode("utf-8")) < 32:
            raise AssetSyncError("asset_sync_hmac_unavailable")
        return hmac.new(
            self._secret.encode("utf-8"), address.lower().encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def connect(self, *, user_id: str, public_identifier: str, is_demo: bool = False) -> Dict[str, Any]:
        self.authorize(user_id=user_id, is_demo=is_demo)
        account = ExternalAccountRef(
            account_id="pending",
            user_id=user_id,
            provider_type=ProviderType.WALLET,
            provider=PROVIDER_CODE,
            network=NETWORK_CODE,
            public_identifier=str(public_identifier or "").strip(),
        )
        validation = self.provider.validate_account(account)
        if not validation.valid or not validation.normalized_identifier:
            raise AssetSyncError("account_invalid", http_status=400)
        row = self.store.upsert_account(
            user_id=user_id,
            public_identifier=validation.normalized_identifier,
            identifier_hmac=self._identifier_hmac(validation.normalized_identifier),
        )
        return self._public_account(row)

    @staticmethod
    def _public_account(row: Dict[str, Any]) -> Dict[str, Any]:
        address = str(row.get("public_identifier") or "")
        masked = f"{address[:6]}…{address[-4:]}" if len(address) >= 12 else ""
        return {
            "id": row.get("id"), "provider": row.get("provider"),
            "network": row.get("network"), "address_masked": masked,
            "status": row.get("status"), "sync_state": row.get("sync_state"),
            "last_sync_at": row.get("last_sync_at"),
            "last_success_at": row.get("last_success_at"),
            "last_error_code": row.get("last_error_code"),
        }

    def _throttle(self) -> None:
        minimum = 1.0 / self.policy.rate_limit_per_second
        with self._rate_lock:
            elapsed = time.monotonic() - self._last_request_at
            if self._last_request_at and elapsed < minimum:
                self._sleep(minimum - elapsed)
            self._last_request_at = time.monotonic()

    def sync(self, *, user_id: str, account_id: str, is_demo: bool = False) -> Dict[str, Any]:
        self.authorize(user_id=user_id, is_demo=is_demo)
        account_row = self.store.get_account(user_id=user_id, account_id=account_id)
        if not account_row:
            raise AssetSyncError("account_not_found", http_status=404)
        if account_row.get("status") != "active":
            raise AssetSyncError("account_not_active", http_status=409)
        account = ExternalAccountRef(
            account_id=str(account_row["id"]), user_id=user_id,
            provider_type=ProviderType.WALLET, provider=str(account_row["provider"]),
            network=str(account_row["network"]),
            public_identifier=str(account_row["public_identifier"]),
        )
        now = self._now()
        bucket = now.replace(second=0, microsecond=0)
        key = build_idempotency_key(
            account_id=account.account_id, trigger="manual", bucket_started_at=bucket)
        run, created = self.store.claim_run(
            account_id=account.account_id, idempotency_key=key,
            trigger="manual", timeout_seconds=self.policy.timeout_seconds,
        )
        if not created:
            if run.get("status") in {"queued", "running"}:
                raise AssetSyncError("sync_in_progress", http_status=409)
            return {"run_id": run.get("id"), "status": run.get("status"), "idempotent": True}

        last_error: Optional[AssetSyncError] = None
        balances: Sequence[ProviderBalance] = []
        attempts_used = 0
        for attempt in range(1, self.policy.max_attempts + 1):
            attempts_used = attempt
            try:
                self._throttle()
                balances = self.provider.fetch_balances(
                    account, timeout_seconds=self.policy.timeout_seconds)
                last_error = None
                break
            except AssetSyncError as exc:
                last_error = exc
                if not exc.retryable or attempt >= self.policy.max_attempts:
                    break
                delay = min(
                    self.policy.initial_backoff_seconds * (2 ** (attempt - 1)),
                    self.policy.max_backoff_seconds,
                )
                self._sleep(delay)
            except Exception:
                last_error = AssetSyncError("provider_unavailable", retryable=False)
                break
        if last_error is not None:
            self.store.fail_run(
                account_id=account.account_id, run_id=str(run["id"]),
                code=last_error.code, stale=bool(account_row.get("last_success_at")),
            )
            raise last_error

        try:
            normalized = list(self.provider.normalize_balances(account, balances))
        except Exception as exc:
            self.store.fail_run(
                account_id=account.account_id, run_id=str(run["id"]),
                code="normalization_failed", stale=bool(account_row.get("last_success_at")),
            )
            raise AssetSyncError("normalization_failed") from exc

        missing_prices = any(item.price_usd is None for item in normalized)
        dropped_items = int(getattr(balances, "dropped_count", 0) or 0)
        duplicate_count = max(0, len(balances) - len(normalized))
        partial_reason = (
            "provider_item_invalid" if dropped_items
            else "provider_item_invalid" if duplicate_count
            else "price_unavailable" if missing_prices
            else None
        )
        status = "partial" if partial_reason else "success"
        captured_at = self._now()
        known_value = sum(
            (item.value_usd for item in normalized if item.value_usd is not None),
            Decimal("0"),
        )
        total_value = None if partial_reason else known_value
        payload_balances = []
        for item in normalized:
            raw = asdict(item)
            payload_balances.append({
                key: (str(value) if isinstance(value, Decimal) else value.isoformat() if isinstance(value, datetime) else value)
                for key, value in raw.items()
            })
        committed = self.store.commit_snapshot({
            "p_user_id": user_id,
            "p_account_id": account.account_id,
            "p_run_id": str(run["id"]),
            "p_status": status,
            "p_provider": PROVIDER_CODE,
            "p_network": NETWORK_CODE,
            "p_captured_at": captured_at.isoformat(),
            "p_total_value_usd": str(total_value) if total_value is not None else None,
            "p_price_source": PRICE_SOURCE if normalized and not missing_prices else None,
            "p_price_as_of": max(
                (item.price_as_of for item in normalized if item.price_as_of is not None),
                default=None,
            ).isoformat() if any(item.price_as_of for item in normalized) else None,
            "p_balances": payload_balances,
            "p_attempt_count": attempts_used,
            "p_partial_reason": partial_reason,
            "p_fetched_count": len(balances) + dropped_items,
            "p_normalized_count": len(normalized),
        })
        return {
            "run_id": run.get("id"), "status": status, "idempotent": False,
            "snapshot_id": committed.get("snapshot_id"),
            "balance_count": len(normalized),
        }

    def portfolio(self, *, user_id: str, is_demo: bool = False) -> Dict[str, Any]:
        self.authorize(user_id=user_id, is_demo=is_demo)
        groups = []
        for group in self.store.portfolio(user_id=user_id):
            snapshot = group.get("snapshot")
            balances = []
            for item in group.get("balances") or []:
                balances.append({
                    "asset_key": item.get("asset_key"),
                    "symbol": item.get("asset_symbol"),
                    "quantity": item.get("quantity"),
                    "price_usd": item.get("price_usd"),
                    "value_usd": item.get("value_usd"),
                    "price_source": item.get("price_source"),
                    "price_as_of": item.get("price_as_of"),
                })
            groups.append({
                "account": self._public_account(group.get("account") or {}),
                "snapshot": {
                    "status": snapshot.get("status"),
                    "total_value_usd": snapshot.get("total_value_usd"),
                    "captured_at": snapshot.get("captured_at"),
                    "price_source": snapshot.get("price_source"),
                    "price_as_of": snapshot.get("price_as_of"),
                    "is_last_good": snapshot.get("is_last_good"),
                } if snapshot else None,
                "balances": balances,
            })
        return {"source_kind": "real", "accounts": groups, "entitlement": "beta_feature_flag"}

    def disconnect(self, *, user_id: str, account_id: str, is_demo: bool = False) -> None:
        self.authorize(user_id=user_id, is_demo=is_demo)
        if not self.store.disconnect(user_id=user_id, account_id=account_id):
            raise AssetSyncError("account_not_found", http_status=404)


_asset_sync_service: Optional[AssetSyncService] = None


def get_asset_sync_service() -> AssetSyncService:
    global _asset_sync_service
    if _asset_sync_service is None:
        _asset_sync_service = AssetSyncService()
    return _asset_sync_service
