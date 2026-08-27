"""TASK 11 deterministic paper stress tests; never mutate the ledger."""

from __future__ import annotations

import copy
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from services.paper_stress_service import (  # noqa: E402
    SCENARIOS,
    STRATEGIES,
    StressInputError,
    normalize_snapshot,
    run_stress_test,
)


BASE = {
    "cash": 25000,
    "positions": [
        {"symbol": "BTC", "market_value": 50000},
        {"symbol": "ETH", "market_value": 15000},
        {"symbol": "USDC", "market_value": 10000},
    ],
}


class DeterministicStressTests(unittest.TestCase):
    def _run_case(self, snapshot=None, seed=42, days=90):
        return run_stress_test({
            "snapshot": snapshot if snapshot is not None else copy.deepcopy(BASE),
            "seed": seed,
            "horizon_days": days,
        })

    def test_four_scenarios_three_fixed_strategies_and_metrics(self):
        result = self._run_case()
        self.assertEqual(set(result["scenarios"]), set(SCENARIOS))
        self.assertEqual(set(result["strategies"]), set(STRATEGIES))
        for strategy in STRATEGIES:
            self.assertEqual(set(result["results"][strategy]), set(SCENARIOS))
            for scenario in SCENARIOS:
                metrics = result["results"][strategy][scenario]["metrics"]
                self.assertEqual(set(metrics), {
                    "total_return", "volatility", "max_drawdown",
                    "sharpe_like", "final_value",
                })
                self.assertEqual(
                    len(result["results"][strategy][scenario]["path"]), 91)

    def test_same_seed_same_snapshot_is_reproducible(self):
        first = self._run_case(seed=2026)
        second = self._run_case(seed=2026)
        self.assertEqual(first["snapshot"], second["snapshot"])
        self.assertEqual(first["results"], second["results"])
        self.assertNotEqual(first["run_id"], second["run_id"])
        third = self._run_case(seed=2027)
        self.assertNotEqual(first["results"], third["results"])

    def test_scenario_fixtures_are_deterministic_and_directional(self):
        result = self._run_case(
            snapshot={"cash": 0, "positions": [{"symbol": "BTC", "market_value": 100000}]},
            seed=7,
        )
        balanced = result["results"]["balanced"]
        self.assertGreater(
            balanced["bull"]["metrics"]["final_value"],
            balanced["bear"]["metrics"]["final_value"],
        )
        self.assertGreater(
            abs(balanced["black_swan"]["metrics"]["max_drawdown"]),
            abs(balanced["normal"]["metrics"]["max_drawdown"]),
        )

    def test_empty_portfolio_has_flat_metrics(self):
        result = self._run_case(snapshot={"cash": 0, "positions": []})
        for strategy in STRATEGIES:
            for scenario in SCENARIOS:
                metrics = result["results"][strategy][scenario]["metrics"]
                self.assertEqual(metrics["final_value"], 0)
                self.assertEqual(metrics["total_return"], 0)
                self.assertEqual(metrics["max_drawdown"], 0)

    def test_single_and_concentrated_assets_are_not_double_counted(self):
        snapshot = {
            "cash": 0,
            "positions": [
                {"symbol": "BTC", "market_value": 60000},
                {"symbol": "BTC", "market_value": 40000},
            ],
        }
        normalized, warnings = normalize_snapshot(snapshot)
        self.assertEqual(normalized["positions"], [
            {"symbol": "BTC", "market_value": 100000.0}])
        self.assertEqual(warnings, [])
        result = self._run_case(snapshot=snapshot, seed=9)
        conservative = result["results"]["conservative"]["black_swan"]["metrics"]
        aggressive = result["results"]["aggressive"]["black_swan"]["metrics"]
        self.assertGreater(conservative["final_value"], aggressive["final_value"])
        self.assertLess(abs(conservative["max_drawdown"]), abs(aggressive["max_drawdown"]))

    def test_stablecoin_fixture_uses_defensive_path(self):
        result = self._run_case(snapshot={
            "cash": 0,
            "positions": [{"symbol": "USDC", "market_value": 100000}],
        }, seed=11)
        normal = result["results"]["balanced"]["normal"]["metrics"]
        black = result["results"]["balanced"]["black_swan"]["metrics"]
        self.assertLess(normal["volatility"], 0.02)
        self.assertGreater(black["final_value"], 90000)

    def test_missing_price_is_excluded_with_warning_not_zero_valued(self):
        snapshot = {
            "cash": 1000,
            "positions": [
                {"symbol": "BTC", "quantity": 1, "current_price": None},
                {"symbol": "ETH", "quantity": 2, "current_price": 2000},
            ],
        }
        result = self._run_case(snapshot=snapshot)
        self.assertEqual(result["snapshot"]["initial_value"], 5000)
        self.assertEqual(result["warnings"], ["BTC:price_missing"])
        self.assertEqual([p["symbol"] for p in result["snapshot"]["positions"]], ["ETH"])

    def test_input_snapshot_and_ledger_like_object_are_not_mutated(self):
        ledger = copy.deepcopy(BASE)
        before = copy.deepcopy(ledger)
        self._run_case(snapshot=ledger)
        self.assertEqual(ledger, before)
        source = (PROJECT_ROOT / "services/paper_stress_service.py").read_text()
        for forbidden in (
            "sim_transactions", "sim_positions", "sim_portfolios",
            "save_local_sim_store", "execute_sim_order",
        ):
            self.assertNotIn(forbidden, source)

    def test_period_and_seed_validation_fail_closed(self):
        for payload, code in [
            ({"snapshot": BASE, "horizon_days": 6, "seed": 1}, "stress_horizon_invalid"),
            ({"snapshot": BASE, "horizon_days": 366, "seed": 1}, "stress_horizon_invalid"),
            ({"snapshot": BASE, "horizon_days": 90, "seed": -1}, "stress_seed_invalid"),
            ({"snapshot": {"cash": -1, "positions": []}}, "stress_input_invalid"),
            ({"snapshot": {"cash": 1, "positions": [{"symbol": "../BTC", "market_value": 1}]}},
             "stress_symbol_invalid"),
            ({"snapshot": {"cash": True, "positions": []}}, "stress_input_invalid"),
            ({"snapshot": {"cash": 10 ** 19, "positions": []}}, "stress_input_invalid"),
            ({"snapshot": {"cash": 0, "positions": [
                {"symbol": "BTC", "market_value": 10 ** 18},
                {"symbol": "BTC", "market_value": 10 ** 18},
            ]}}, "stress_input_invalid"),
        ]:
            with self.subTest(code=code), self.assertRaises(StressInputError) as ctx:
                run_stress_test(payload)
            self.assertEqual(ctx.exception.code, code)

    def test_output_explicitly_says_not_backtest_and_no_ledger_write(self):
        result = self._run_case()
        self.assertEqual(result["period"]["kind"], "synthetic_days")
        self.assertIn("assumption_based_not_historical_backtest", result["limitations"])
        self.assertIn("results_never_write_simulated_ledger", result["limitations"])


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import app as app_module
        cls.module = app_module
        cls.client = app_module.app.test_client()

    def test_anonymous_rejected_and_demo_can_run_without_ledger_calls(self):
        self.assertEqual(
            self.client.post("/api/paper-stress-test", json={}).status_code, 401)
        with mock.patch.object(self.module, "save_local_sim_store") as save, \
             mock.patch.object(self.module, "execute_sim_order") as order:
            response = self.client.post(
                "/api/paper-stress-test",
                headers={"Authorization": f"Bearer {self.module.DEMO_MEMBER_TOKEN}"},
                json={"snapshot": BASE, "horizon_days": 30, "seed": 9},
            )
        self.assertEqual(response.status_code, 200)
        save.assert_not_called()
        order.assert_not_called()

    def test_invalid_request_has_fixed_400_without_raw_value(self):
        secret = "Bearer fake-stress-secret-DO-NOT-LOG"
        response = self.client.post(
            "/api/paper-stress-test",
            headers={"Authorization": f"Bearer {self.module.DEMO_MEMBER_TOKEN}"},
            json={"snapshot": {"cash": 1, "positions": [{
                "symbol": secret, "market_value": 10,
            }]}},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "stress_symbol_invalid")
        self.assertNotIn(secret, response.get_data(as_text=True))

    def test_unexpected_failure_is_fixed_and_does_not_expose_exception(self):
        secret = "provider-secret-DO-NOT-EXPOSE"
        with mock.patch.object(
            self.module, "_run_paper_stress_test",
            side_effect=RuntimeError(secret),
        ):
            response = self.client.post(
                "/api/paper-stress-test",
                headers={"Authorization": f"Bearer {self.module.DEMO_MEMBER_TOKEN}"},
                json={"snapshot": BASE},
            )
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.get_json()["code"], "stress_internal_error")
        self.assertNotIn(secret, response.get_data(as_text=True))

    def test_ui_marks_assumption_period_benchmark_and_backtest_boundary(self):
        html = (PROJECT_ROOT / "templates/sim_trade.html").read_text(encoding="utf-8-sig")
        for text in ("假設式", "歷史回測", "假設期間", "起始資金", "Seed"):
            self.assertIn(text, html)
        js = (PROJECT_ROOT / "static/js/sim_trade.js").read_text(encoding="utf-8")
        renderer = js.split("function renderStressResults", 1)[1].split(
            "async function runStressTest", 1)[0]
        self.assertNotIn("innerHTML", renderer)


if __name__ == "__main__":
    unittest.main()
