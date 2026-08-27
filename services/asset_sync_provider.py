"""Provider-neutral contracts for future real-asset synchronization.

TASK 09 deliberately contains no provider implementation and performs no network
I/O.  Runtime routes must not instantiate a provider until the provider/network
decision gate has been approved and an adapter has its own reviewed task.
"""

from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Optional, Protocol, Sequence


class AssetSourceKind(str, Enum):
    REAL = "real"
    MANUAL = "manual"
    SIMULATED = "simulated"


class ProviderType(str, Enum):
    WALLET = "wallet"
    EXCHANGE = "exchange"


class SyncStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"
    STALE = "stale"


_ALLOWED_TRANSITIONS = {
    SyncStatus.QUEUED: {SyncStatus.RUNNING, SyncStatus.FAILED},
    SyncStatus.RUNNING: {
        SyncStatus.SUCCESS,
        SyncStatus.PARTIAL,
        SyncStatus.FAILED,
        SyncStatus.STALE,
    },
    SyncStatus.SUCCESS: set(),
    SyncStatus.PARTIAL: set(),
    SyncStatus.FAILED: set(),
    SyncStatus.STALE: set(),
}


@dataclass(frozen=True)
class ExternalAccountRef:
    account_id: str
    user_id: str
    provider_type: ProviderType
    provider: str
    network: str
    public_identifier: str
    source_kind: AssetSourceKind = AssetSourceKind.REAL
    credential_reference: Optional[str] = None

    def __post_init__(self) -> None:
        if self.source_kind is not AssetSourceKind.REAL:
            raise ValueError("asset_source_not_real")
        if self.provider_type is not ProviderType.WALLET:
            raise ValueError("provider_type_not_enabled")
        if not self.account_id or not self.user_id:
            raise ValueError("account_identity_missing")
        if not self.provider.strip() or not self.network.strip():
            raise ValueError("provider_or_network_missing")
        if not self.public_identifier.strip() or len(self.public_identifier) > 512:
            raise ValueError("public_identifier_invalid")
        # TASK 09 accepts public-address concepts only. A future reviewed
        # migration/adapter may relax this after a vault threat model exists.
        if self.credential_reference is not None:
            raise ValueError("credential_reference_not_enabled")


@dataclass(frozen=True)
class AccountValidation:
    valid: bool
    normalized_identifier: Optional[str] = None
    error_code: Optional[str] = None


@dataclass(frozen=True)
class ProviderBalance:
    asset: str
    network: str
    quantity: Decimal
    observed_at: datetime
    contract_address: Optional[str] = None
    decimals: Optional[int] = None
    price_usd: Optional[Decimal] = None
    price_source: Optional[str] = None
    price_as_of: Optional[datetime] = None


@dataclass(frozen=True)
class NormalizedBalance:
    asset_key: str
    asset: str
    network: str
    quantity: Decimal
    observed_at: datetime
    contract_address: Optional[str] = None
    price_usd: Optional[Decimal] = None
    value_usd: Optional[Decimal] = None
    price_source: Optional[str] = None
    price_as_of: Optional[datetime] = None

    def __post_init__(self) -> None:
        if not self.asset_key.strip() or not self.asset.strip() or not self.network.strip():
            raise ValueError("normalized_balance_identity_missing")
        if self.quantity < 0:
            raise ValueError("normalized_balance_quantity_negative")
        if self.price_usd is not None and self.price_usd < 0:
            raise ValueError("normalized_balance_price_negative")
        if self.value_usd is not None and self.value_usd < 0:
            raise ValueError("normalized_balance_value_negative")
        if self.observed_at.tzinfo is None:
            raise ValueError("normalized_balance_timestamp_naive")
        if self.price_as_of is not None and self.price_as_of.tzinfo is None:
            raise ValueError("normalized_balance_price_timestamp_naive")


@dataclass(frozen=True)
class ProviderHealth:
    available: bool
    code: str
    checked_at: datetime


@dataclass(frozen=True)
class SyncPolicy:
    timeout_seconds: int = 10
    max_attempts: int = 3
    initial_backoff_seconds: int = 1
    max_backoff_seconds: int = 8
    rate_limit_per_second: int = 2
    stale_after_seconds: int = 86400

    def __post_init__(self) -> None:
        if not 1 <= self.timeout_seconds <= 60:
            raise ValueError("sync_timeout_invalid")
        if not 1 <= self.max_attempts <= 5:
            raise ValueError("sync_attempts_invalid")
        if self.initial_backoff_seconds < 0:
            raise ValueError("sync_backoff_invalid")
        if self.max_backoff_seconds < self.initial_backoff_seconds:
            raise ValueError("sync_backoff_invalid")
        if not 1 <= self.rate_limit_per_second <= 20:
            raise ValueError("sync_rate_limit_invalid")
        if self.stale_after_seconds < 60:
            raise ValueError("sync_stale_window_invalid")


class AssetSyncProvider(ABC):
    """Network adapter interface. Implementations belong to a later task."""

    provider_code: str
    provider_type: ProviderType

    @abstractmethod
    def validate_account(self, account: ExternalAccountRef) -> AccountValidation:
        """Validate and canonicalize a public identifier without persisting it."""

    @abstractmethod
    def fetch_balances(
        self,
        account: ExternalAccountRef,
        *,
        timeout_seconds: int,
    ) -> Sequence[ProviderBalance]:
        """Fetch provider-native balances. Must be read-only."""

    @abstractmethod
    def normalize_balances(
        self,
        account: ExternalAccountRef,
        balances: Sequence[ProviderBalance],
    ) -> Sequence[NormalizedBalance]:
        """Return deterministic canonical balances without provider raw payloads."""

    @abstractmethod
    def health_check(self, *, timeout_seconds: int) -> ProviderHealth:
        """Return a fixed-code provider health result; do not expose exceptions."""


@dataclass(frozen=True)
class EntitlementDecision:
    allowed: bool
    reason_code: str
    entitlement_key: str = "asset_sync"
    plan_code: Optional[str] = None


class AssetSyncEntitlementChecker(Protocol):
    def check(self, *, user_id: str, entitlement_key: str) -> EntitlementDecision:
        """Resolve access server-side; client plan claims are never trusted."""


class DenyByDefaultEntitlementChecker:
    """Safe placeholder until subscriptions/entitlements have real evidence."""

    def check(self, *, user_id: str, entitlement_key: str) -> EntitlementDecision:
        del user_id
        return EntitlementDecision(
            allowed=False,
            reason_code="entitlement_backend_unavailable",
            entitlement_key=entitlement_key,
        )


def can_transition(current: SyncStatus, target: SyncStatus) -> bool:
    return target in _ALLOWED_TRANSITIONS[current]


def build_idempotency_key(
    *, account_id: str, trigger: str, bucket_started_at: datetime
) -> str:
    """Stable non-secret key for one account/trigger/time bucket."""
    if not account_id or trigger not in {"manual", "scheduled", "retry"}:
        raise ValueError("idempotency_input_invalid")
    if bucket_started_at.tzinfo is None:
        raise ValueError("idempotency_timestamp_naive")
    canonical = "|".join(
        (
            account_id,
            trigger,
            bucket_started_at.astimezone(timezone.utc).isoformat(timespec="seconds"),
        )
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
