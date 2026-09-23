"""Offline regression tests for simulated order pricing and ledger integrity."""

import copy
import os
import socket
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


class SimOrderAmountTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        credentials = {
            key: "" for key in os.environ
            if any(part in key for part in ("OPENAI", "SUPABASE", "CG_API", "ALCHEMY"))
        }
        with (
            patch.dict(os.environ, credentials),
            patch("dotenv.load_dotenv", return_value=False),
            patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test")),
        ):
            import app
        cls.module = app

    def setUp(self):
        app = self.module
        self.state = app.default_local_sim_state("demo-member")
        self.store = {"users": {"demo-member": self.state}}
        self.client = app.app.test_client()
        self.headers = {"Authorization": f"Bearer {app.DEMO_MEMBER_TOKEN}"}
        self.enterContext(patch.dict(app.app.config, TESTING=True))
        self.enterContext(patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test")))
        self.enterContext(patch.object(app, "load_local_sim_store", return_value=self.store))
        self.save = self.enterContext(patch.object(app, "save_local_sim_store"))
        self.price = self.enterContext(patch.object(app, "get_coin_price_usd", return_value=65000.0))

    def order(self, side="buy", **values):
        return self.client.post(
            "/api/sim-trade/order",
            headers=self.headers,
            json={"symbol": "BTC", "side": side, **values},
        )

    def test_buy_uses_server_price_instead_of_client_amount(self):
        response = self.order(quantity=1, amount_usd=1)
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(result["trade"]["amount_usd"], 65000)
        self.assertEqual(result["portfolio"]["cash"], 35000)
        self.assertEqual(result["portfolio"]["positions"][0]["quantity"], 1)
        self.assertEqual(result["portfolio"]["total_value_usd"], 100000)

    def test_sell_cannot_inflate_proceeds_with_client_amount(self):
        self.state["portfolio"]["cash_balance"] = 35000
        self.state["positions"]["BTC"] = {"quantity": 1, "avg_price": 65000}
        response = self.order(side="sell", quantity=1, amount_usd=999999)
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(result["trade"]["amount_usd"], 65000)
        self.assertEqual(result["portfolio"]["cash"], 100000)
        self.assertEqual(result["portfolio"]["positions"], [])

    def test_amount_only_order_still_works(self):
        response = self.order(amount_usd=6500)
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertAlmostEqual(result["trade"]["quantity"], 0.1)
        self.assertEqual(result["portfolio"]["cash"], 93500)
        self.assertEqual(result["portfolio"]["total_value_usd"], 100000)

    def test_quantity_only_order_still_works(self):
        response = self.order(quantity=0.1)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["trade"]["amount_usd"], 6500)

    def test_insufficient_cash_is_checked_against_server_amount(self):
        before = copy.deepcopy(self.store)
        response = self.order(quantity=2, amount_usd=1)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.store, before)
        self.save.assert_not_called()

    def test_invalid_inputs_do_not_mutate_ledger(self):
        cases = [
            {},
            {"quantity": 0},
            {"quantity": -1},
            {"quantity": "nan"},
            {"quantity": "inf"},
            {"quantity": "-inf"},
            {"quantity": "not-a-number"},
            {"quantity": 1e308},
            {"amount_usd": 0},
            {"amount_usd": -1},
            {"amount_usd": "nan"},
            {"amount_usd": "inf"},
            {"quantity": 1, "amount_usd": "nan"},
            {"quantity": 1, "amount_usd": "inf"},
        ]
        before = copy.deepcopy(self.store)
        for values in cases:
            with self.subTest(values=values):
                self.store.clear()
                self.store.update(copy.deepcopy(before))
                self.save.reset_mock()
                response = self.order(**values)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.store, before)
                self.save.assert_not_called()

    def test_invalid_market_prices_do_not_mutate_ledger(self):
        before = copy.deepcopy(self.store)
        for price in (0, -1, float("nan"), float("inf")):
            with self.subTest(price=price):
                self.store.clear()
                self.store.update(copy.deepcopy(before))
                self.save.reset_mock()
                self.price.return_value = price
                response = self.order(quantity=1, amount_usd=1)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.store, before)
                self.save.assert_not_called()

    def test_remote_rpc_receives_server_calculated_amount(self):
        db = Mock()
        db.client.auth.get_user.return_value = SimpleNamespace(user=SimpleNamespace(id="member-1"))
        db.sim_get_or_create_portfolio.return_value = {
            "cash_balance": 100000, "initial_cash": 100000,
        }
        db.sim_list_positions.return_value = []
        db.sim_execute_order.return_value = {
            "trade": {"symbol": "BTC", "side": "buy", "price": 65000,
                      "quantity": 1, "amount_usd": 65000},
        }
        with patch.object(self.module, "db", db):
            self.module.execute_sim_order("test-member-token", "BTC", "buy", 1, 1)
        db.sim_execute_order.assert_called_once()
        values = db.sim_execute_order.call_args.kwargs
        self.assertEqual(values["amount_usd"], 65000)
        self.assertEqual(values["total_value_usd"], 100000)
        self.save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
