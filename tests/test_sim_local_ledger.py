"""Ensure member history and reset operate on the active simulated ledger."""

import hashlib
import os
import socket
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


class LocalLedgerTests(unittest.TestCase):
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
        self.db = Mock()
        self.db.client.auth.get_user.return_value = SimpleNamespace(user=SimpleNamespace(
            id="member-1", email="member@example.invalid", app_metadata={},
        ))
        self.enterContext(patch.object(app, "db", self.db))
        self.enterContext(patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test")))
        self.enterContext(patch.dict(app.app.config, TESTING=True))
        self.enterContext(patch.object(app, "get_coin_price_usd", return_value=65000.0))
        self.token = "synthetic-member-token"
        self.key = app.sim_user_key(self.token)
        self.state = app.default_local_sim_state(self.key)
        self.state["prefer_local"] = True
        self.state["portfolio"]["cash_balance"] = 35000
        self.state["positions"]["BTC"] = {"quantity": 1, "avg_price": 65000}
        self.state["trades"] = [{
            "symbol": "BTC", "side": "buy", "price": 65000, "quantity": 1,
            "amount_usd": 65000, "timestamp": "2026-09-23T00:00:00",
        }]
        self.store = {"users": {self.key: self.state}}
        self.enterContext(patch.object(app, "load_local_sim_store", return_value=self.store))
        self.save = self.enterContext(patch.object(app, "save_local_sim_store"))
        self.client = app.app.test_client()
        self.headers = {"Authorization": f"Bearer {self.token}"}

    def test_member_reset_clears_local_ledger_and_keeps_it_active(self):
        response = self.client.post("/api/sim-trade/reset", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        portfolio = response.get_json()["portfolio"]
        self.assertEqual(portfolio["cash"], 100000)
        self.assertEqual(portfolio["positions"], [])
        state = self.store["users"][self.key]
        self.assertTrue(state["prefer_local"])
        self.assertEqual(state["trades"], [])
        self.db.sim_reset_portfolio.assert_not_called()
        self.db.sim_get_or_create_portfolio.assert_not_called()
        self.save.assert_called_once()

    def test_member_history_reads_active_local_trades(self):
        response = self.client.get("/api/sim-trade/history", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["trades"], self.state["trades"])
        self.db.sim_list_transactions.assert_not_called()

    def test_empty_remote_history_does_not_resurrect_old_local_trades(self):
        self.state["prefer_local"] = False
        self.db.sim_list_transactions.return_value = []
        response = self.client.get("/api/sim-trade/history", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["trades"], [])
        self.db.sim_list_transactions.assert_called_once_with(self.token, limit=50)

    def test_remote_member_reset_still_uses_remote_ledger(self):
        self.state["prefer_local"] = False
        self.db.sim_get_or_create_portfolio.return_value = {"cash_balance": 100000, "initial_cash": 100000}
        self.db.sim_list_positions.return_value = []
        self.db.sim_list_equity_curve.return_value = []
        response = self.client.post("/api/sim-trade/reset", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.db.sim_reset_portfolio.assert_called_once_with(self.token, 100000, 100000)
        self.save.assert_not_called()

    def test_refreshed_token_keeps_same_member_cash_and_positions(self):
        for token in (self.token, "synthetic-refreshed-token"):
            with self.subTest(token=token):
                self.db.client.auth.get_user.reset_mock()
                response = self.client.get(
                    "/api/sim-trade/portfolio", headers={"Authorization": f"Bearer {token}"},
                )
                self.assertEqual(response.status_code, 200)
                portfolio = response.get_json()["portfolio"]
                self.assertEqual(portfolio["cash"], 35000)
                self.assertEqual(portfolio["positions"][0]["quantity"], 1)
                self.db.client.auth.get_user.assert_called_once_with(token)
        self.assertEqual(list(self.store["users"]), [self.key])
        self.db.sim_get_or_create_portfolio.assert_not_called()

    def test_different_member_cannot_read_first_members_local_ledger(self):
        self.db.client.auth.get_user.return_value.user.id = "member-2"
        self.db.sim_get_or_create_portfolio.return_value = {"cash_balance": 77000, "initial_cash": 100000}
        self.db.sim_list_positions.return_value = []
        self.db.sim_list_equity_curve.return_value = []
        response = self.client.get("/api/sim-trade/portfolio", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["portfolio"]["cash"], 77000)
        self.assertEqual(response.get_json()["portfolio"]["positions"], [])
        self.assertEqual(self.state["portfolio"]["cash_balance"], 35000)

    def test_current_tokens_legacy_ledger_is_migrated_without_losing_assets(self):
        legacy_key = "user-" + hashlib.sha256(self.token.encode()).hexdigest()[:24]
        self.store["users"] = {legacy_key: self.state}
        response = self.client.get("/api/sim-trade/portfolio", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["portfolio"]["cash"], 35000)
        self.assertEqual(response.get_json()["portfolio"]["positions"][0]["quantity"], 1)
        self.assertNotIn(legacy_key, self.store["users"])
        self.assertIs(self.store["users"][self.key], self.state)
        self.assertEqual(self.state["portfolio"]["user_id"], self.key)
        self.assertEqual(len(self.state["trades"]), 1)
        self.save.assert_called_once()

    def test_unverified_user_cannot_create_a_local_ledger_key(self):
        self.db.client.auth.get_user.return_value.user = None
        with self.assertRaises(ValueError):
            self.module.sim_user_key("unverified-token")
        self.save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
