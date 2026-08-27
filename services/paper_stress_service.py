"""Deterministic, assumption-based paper portfolio stress testing (TASK 11).

This is not historical backtesting and never reads/writes the paper-trading
ledger. Callers pass an immutable snapshot; the service returns an independent
run result with deterministic scenario metrics for a configurable seed.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import re
import statistics
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


STABLECOINS = {"USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDP", "PYUSD"}
SYMBOL_RE = re.compile(r"^[A-Z0-9]{2,15}$")
MAX_PORTFOLIO_VALUE = 1_000_000_000_000_000_000.0

SCENARIOS = {
    "normal": {
        "label": "一般市場", "terminal_multiplier": 1.0,
        "volatility_multiplier": 1.0, "shock_day": None, "shock_return": 0.0,
    },
    "bull": {
        "label": "牛市", "terminal_multiplier": 1.3,
        "volatility_multiplier": 0.8, "shock_day": None, "shock_return": 0.0,
    },
    "bear": {
        "label": "熊市", "terminal_multiplier": 0.7,
        "volatility_multiplier": 1.5, "shock_day": 10, "shock_return": -0.08,
    },
    "black_swan": {
        "label": "黑天鵝", "terminal_multiplier": 0.4,
        "volatility_multiplier": 3.0, "shock_day": 5, "shock_return": -0.35,
    },
}

STRATEGIES = {
    "conservative": {"label": "保守型", "risk_weight": 0.35},
    "balanced": {"label": "平衡型", "risk_weight": 0.65},
    "aggressive": {"label": "積極型", "risk_weight": 0.90},
}


class StressInputError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _finite_nonnegative(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def normalize_snapshot(payload: Any) -> Tuple[Dict[str, Any], List[str]]:
    if not isinstance(payload, dict):
        raise StressInputError("stress_input_invalid")
    cash = _finite_nonnegative(payload.get("cash", 0))
    positions = payload.get("positions", [])
    if cash is None or not isinstance(positions, list) or len(positions) > 100:
        raise StressInputError("stress_input_invalid")

    warnings: List[str] = []
    merged: Dict[str, float] = {}
    for item in positions:
        if not isinstance(item, dict):
            raise StressInputError("stress_input_invalid")
        symbol = str(item.get("symbol") or "").strip().upper()
        if not SYMBOL_RE.fullmatch(symbol):
            raise StressInputError("stress_symbol_invalid")
        market_value = _finite_nonnegative(item.get("market_value"))
        if market_value is None:
            quantity = _finite_nonnegative(item.get("quantity"))
            price = _finite_nonnegative(item.get("current_price", item.get("price")))
            if quantity is None or price is None:
                warnings.append(f"{symbol}:price_missing")
                continue
            market_value = quantity * price
        merged_value = merged.get(symbol, 0.0) + market_value
        if not math.isfinite(merged_value) or merged_value > MAX_PORTFOLIO_VALUE:
            raise StressInputError("stress_input_invalid")
        merged[symbol] = merged_value

    normalized_positions = [
        {"symbol": symbol, "market_value": round(value, 8)}
        for symbol, value in sorted(merged.items()) if value > 0
    ]
    total = cash + sum(item["market_value"] for item in normalized_positions)
    if not math.isfinite(total) or total > MAX_PORTFOLIO_VALUE:
        raise StressInputError("stress_input_invalid")
    return {
        "cash": round(cash, 8),
        "positions": normalized_positions,
        "initial_value": round(total, 8),
    }, warnings


def _strategy_allocation(snapshot: Dict[str, Any], strategy: str) -> Dict[str, float]:
    total = float(snapshot["initial_value"])
    if total <= 0:
        return {"CASH": 0.0}
    risky = {
        row["symbol"]: float(row["market_value"])
        for row in snapshot["positions"] if row["symbol"] not in STABLECOINS
    }
    stable = {
        row["symbol"]: float(row["market_value"])
        for row in snapshot["positions"] if row["symbol"] in STABLECOINS
    }
    cash = float(snapshot["cash"])
    if not risky:
        allocation = dict(stable)
        allocation["CASH"] = cash
        return allocation

    target_risk = total * STRATEGIES[strategy]["risk_weight"]
    risky_total = sum(risky.values())
    allocation = {
        symbol: target_risk * value / risky_total
        for symbol, value in risky.items()
    }
    defensive_budget = total - target_risk
    defensive_original = cash + sum(stable.values())
    if stable and defensive_original > 0:
        for symbol, value in stable.items():
            allocation[symbol] = defensive_budget * value / defensive_original
        allocation["CASH"] = defensive_budget * cash / defensive_original
    else:
        allocation["CASH"] = defensive_budget
    return allocation


def _metrics(path: List[float]) -> Dict[str, float]:
    initial = path[0] if path else 0.0
    final = path[-1] if path else 0.0
    if initial <= 0 or len(path) < 2:
        return {
            "total_return": 0.0, "volatility": 0.0,
            "max_drawdown": 0.0, "sharpe_like": 0.0,
            "final_value": round(final, 2),
        }
    returns = [path[index] / path[index - 1] - 1 for index in range(1, len(path))]
    volatility = statistics.pstdev(returns) * math.sqrt(365) if returns else 0.0
    mean_return = statistics.fmean(returns) if returns else 0.0
    daily_std = statistics.pstdev(returns) if returns else 0.0
    sharpe = mean_return / daily_std * math.sqrt(365) if daily_std > 0 else 0.0
    peak = path[0]
    max_drawdown = 0.0
    for value in path:
        peak = max(peak, value)
        if peak > 0:
            max_drawdown = min(max_drawdown, value / peak - 1)
    return {
        "total_return": round(final / initial - 1, 8),
        "volatility": round(volatility, 8),
        "max_drawdown": round(max_drawdown, 8),
        "sharpe_like": round(sharpe, 8),
        "final_value": round(final, 2),
    }


def _simulate(
    snapshot: Dict[str, Any], scenario_key: str, strategy_key: str,
    horizon_days: int, seed: int,
) -> Dict[str, Any]:
    scenario = SCENARIOS[scenario_key]
    allocation = _strategy_allocation(snapshot, strategy_key)
    asset_values = dict(allocation)
    initial = sum(asset_values.values())
    path = [initial]
    shock_day = scenario["shock_day"]
    shock = float(scenario["shock_return"])
    multiplier = float(scenario["terminal_multiplier"])
    residual_multiplier = multiplier / (1 + shock) if shock_day is not None else multiplier
    daily_log_drift = math.log(max(residual_multiplier, 0.000001)) / horizon_days
    daily_vol = 0.025 * float(scenario["volatility_multiplier"])

    # The same seed/scenario produces the same market path for every strategy;
    # only the documented allocation rule changes. This keeps comparison fair.
    rng = random.Random(f"{seed}|{scenario_key}")
    for day in range(1, horizon_days + 1):
        market_noise = rng.gauss(0.0, daily_vol)
        for symbol in sorted(asset_values):
            current = asset_values[symbol]
            if symbol == "CASH":
                continue
            if symbol in STABLECOINS:
                stable_noise = rng.gauss(0.0, 0.0004)
                stable_shock = -0.03 if scenario_key == "black_swan" and day == shock_day else 0.0
                daily_return = max(-0.99, stable_noise + stable_shock)
            else:
                idiosyncratic = rng.gauss(0.0, daily_vol * 0.25)
                daily_return = math.exp(
                    daily_log_drift + market_noise + idiosyncratic
                    - 0.5 * (daily_vol ** 2)
                ) - 1
                if shock_day is not None and day == shock_day:
                    daily_return = (1 + daily_return) * (1 + shock) - 1
                daily_return = max(-0.99, daily_return)
            asset_values[symbol] = current * (1 + daily_return)
        path.append(sum(asset_values.values()))

    return {
        "scenario": scenario_key,
        "scenario_label": scenario["label"],
        "strategy": strategy_key,
        "strategy_label": STRATEGIES[strategy_key]["label"],
        "metrics": _metrics(path),
        "path": [round(value, 2) for value in path],
    }


def run_stress_test(
    payload: Any,
    *,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise StressInputError("stress_input_invalid")
    snapshot, warnings = normalize_snapshot(payload.get("snapshot"))
    horizon = payload.get("horizon_days", 90)
    seed = payload.get("seed", 20260820)
    if isinstance(horizon, bool) or not isinstance(horizon, int) or not 7 <= horizon <= 365:
        raise StressInputError("stress_horizon_invalid")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2_147_483_647:
        raise StressInputError("stress_seed_invalid")

    canonical = json.dumps(snapshot, sort_keys=True, separators=(",", ":"))
    snapshot_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    results = {
        strategy: {
            scenario: _simulate(snapshot, scenario, strategy, horizon, seed)
            for scenario in SCENARIOS
        }
        for strategy in STRATEGIES
    }
    created_at = now or datetime.now(timezone.utc)
    return {
        "run_id": str(uuid.uuid4()),
        "snapshot": {**snapshot, "snapshot_hash": snapshot_hash},
        "period": {"kind": "synthetic_days", "days": horizon},
        "benchmark": "starting_portfolio_value",
        "seed": seed,
        "strategies": {
            key: {"label": value["label"], "risk_weight": value["risk_weight"]}
            for key, value in STRATEGIES.items()
        },
        "scenarios": SCENARIOS,
        "results": results,
        "warnings": warnings,
        "limitations": [
            "assumption_based_not_historical_backtest",
            "synthetic_returns_not_price_forecast",
            "fees_tax_liquidity_and_execution_not_modeled",
            "results_never_write_simulated_ledger",
        ],
        "created_at": created_at.astimezone(timezone.utc).isoformat(),
    }
