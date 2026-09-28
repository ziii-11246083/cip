"""Offline checks for the shared BTC quote, provider freshness, and settlement."""
import os
import socket
import unittest
from unittest.mock import patch

import pandas as pd


class QuoteConsistencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        credentials = {key: "" for key in os.environ if any(x in key for x in ("OPENAI", "SUPABASE", "CG_API", "ALCHEMY"))}
        with patch.dict(os.environ, credentials), patch("dotenv.load_dotenv", return_value=False), patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test")):
            import app
        cls.module = app

    def setUp(self):
        app = self.module
        self.now = 1800000000.0
        self.enterContext(patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test")))
        self.enterContext(patch.dict(app.SIM_PRICE_CACHE, {}, clear=True))
        self.enterContext(patch.object(app.time, "time", return_value=self.now))
        self.clock = self.enterContext(patch.object(app.time, "monotonic", return_value=1000.0))
        self.cg = self.enterContext(patch.object(app.DataManager, "_cg_get", return_value=None))
        self.yahoo = self.enterContext(patch.object(app.yf, "Ticker"))
        self.yahoo.return_value.history.return_value = pd.DataFrame()
        self.client = app.app.test_client()

    def yahoo_quote(self, price=83210.0, age=15):
        self.yahoo.return_value.history.return_value = pd.DataFrame(
            {"Close": [price]}, index=pd.to_datetime([self.now - age], unit="s", utc=True),
        )

    def test_fresh_primary_quote_is_shared_without_fallback(self):
        self.cg.return_value = {"bitcoin": {"usd": 83210, "last_updated_at": self.now}}
        response = self.client.get("/crypto/quote?ticker=btc")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["current_price"], 83210)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(self.module.get_coin_price_usd(" BTC "), 83210)
        self.cg.assert_called_once()
        self.yahoo.assert_not_called()

    def test_fallback_quote_matches_display_portfolio_and_order(self):
        app = self.module
        self.yahoo_quote()
        state = app.default_local_sim_state("demo-member")
        state["positions"]["BTC"] = {"quantity": 0.01, "avg_price": 80000}
        store = {"users": {"demo-member": state}}
        headers = {"Authorization": f"Bearer {app.DEMO_MEMBER_TOKEN}"}
        with patch.object(app, "load_local_sim_store", return_value=store), patch.object(app, "save_local_sim_store"):
            quote = self.client.get("/crypto/quote?ticker=BTC").get_json()["current_price"]
            portfolio = self.client.get("/api/sim-trade/portfolio", headers=headers).get_json()["portfolio"]
            self.assertEqual(portfolio["price_unavailable_symbols"], [])
            self.assertEqual(portfolio["positions"][0]["current_price"], quote)
            self.assertAlmostEqual(portfolio["positions"][0]["market_value"], quote * 0.01)
            response = self.client.post("/api/sim-trade/order", headers=headers, json={"symbol": "BTC", "side": "buy", "quantity": 0.001})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["trade"]["price"], quote)
            self.assertAlmostEqual(response.get_json()["trade"]["amount_usd"], 83.21)
        self.yahoo.return_value.history.assert_called_once_with(period="1d", interval="1m", auto_adjust=True, timeout=5)

    def test_bad_or_stale_primary_uses_fresh_fallback(self):
        for quote in (None, [], {"usd": 0}, {"usd": float("nan")}, {"usd": 99, "last_updated_at": self.now - 301}, {"usd": 99, "last_updated_at": self.now + 30}):
            with self.subTest(quote=quote):
                self.module.SIM_PRICE_CACHE.clear()
                self.cg.return_value = {"bitcoin": quote}
                self.yahoo_quote()
                self.assertEqual(self.module.get_coin_price_usd("BTC"), 83210)

    def test_invalid_or_old_intraday_data_is_unavailable(self):
        for price, age in ((0, 10), (-1, 10), (float("nan"), 10), (float("inf"), 10), (83210, 300), (83210, 86400), (83210, -60)):
            with self.subTest(price=price, age=age):
                self.yahoo_quote(price, age)
                response = self.client.get("/crypto/quote?ticker=BTC")
                self.assertEqual(response.status_code, 503)
                self.assertIsNone(response.get_json()["current_price"])
                self.assertEqual(self.module.SIM_PRICE_CACHE, {})

    def test_provider_age_is_not_reset_when_fallback_is_cached(self):
        self.yahoo_quote(age=280)
        self.assertEqual(self.module.get_coin_price_usd("BTC"), 83210)
        self.yahoo.return_value.history.return_value = pd.DataFrame()
        self.clock.return_value = 1010
        self.assertEqual(self.module.get_coin_price_usd("BTC"), 83210)
        self.clock.return_value = 1021
        with self.assertRaisesRegex(ValueError, "行情暫時無法取得"):
            self.module.get_coin_price_usd("BTC")

    def test_recent_minute_quote_is_reused_without_repeated_provider_requests(self):
        self.yahoo_quote(age=120)
        self.assertEqual(self.module.get_coin_price_usd("BTC"), 83210)
        self.clock.return_value = 1020
        self.assertEqual(self.module.get_coin_price_usd("BTC"), 83210)
        self.cg.assert_called_once()
        self.yahoo.return_value.history.assert_called_once()

    def test_empty_or_failed_sources_never_create_a_price(self):
        for failure in (None, RuntimeError("provider unavailable")):
            self.yahoo.return_value.history.side_effect = failure
            response = self.client.get("/crypto/quote?ticker=BTC")
            self.assertEqual(response.status_code, 503)
            self.assertIsNone(response.get_json()["current_price"])
        self.assertEqual(self.module.SIM_PRICE_CACHE, {})

    def test_unknown_symbol_is_rejected_without_provider_request(self):
        response = self.client.get("/crypto/quote?ticker=UNKNOWN")
        self.assertEqual(response.status_code, 400)
        self.cg.assert_not_called()
        self.yahoo.assert_not_called()
