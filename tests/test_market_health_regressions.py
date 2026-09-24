"""Offline market and portfolio numerical regression checks."""
import os
import socket
import unittest
from unittest.mock import patch
import pandas as pd


class MarketHealthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        credentials = {key: "" for key in os.environ if any(x in key for x in ("OPENAI", "SUPABASE", "CG_API", "ALCHEMY"))}
        with patch.dict(os.environ, credentials), patch("dotenv.load_dotenv", return_value=False), patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test")):
            import app
        cls.module = app

    def test_flat_price_rsi_is_finite_and_neutral(self):
        with patch.object(self.module.DataManager, "get_all_tickers", return_value=[{"symbol": "USDC", "history_prices": [1.] * 60}]):
            response = self.module.app.test_client().get("/api/ta/USDC")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["rsi"], 50)
        self.assertEqual(response.get_json()["signal"], "中立")

    def test_duplicate_holdings_match_single_combined_holding(self):
        history = pd.DataFrame({"Close": [100., 80., 90., 70.]})
        with patch.object(self.module.yf, "Ticker") as ticker:
            ticker.return_value.history.return_value = history
            single = self.module.calculate_portfolio_risk_health(self.module.RiskHealthRequest(holdings=[{"ticker": "BTC", "weight": 1}]))
            split = self.module.calculate_portfolio_risk_health(self.module.RiskHealthRequest(holdings=[{"ticker": "BTC", "weight": .5}, {"ticker": " btc ", "weight": .5}]))
        self.assertEqual(split, single)
        self.assertEqual(single["top1_weight"], 1)
        self.assertEqual(single["herfindahl"], 1)
        self.assertAlmostEqual(single["max_drawdown"], .3)

    def test_first_day_loss_is_included_in_drawdown(self):
        with patch.object(self.module.yf, "Ticker") as ticker:
            ticker.return_value.history.return_value = pd.DataFrame({"Close": [100., 80.]})
            metrics = self.module.calculate_portfolio_risk_health(self.module.RiskHealthRequest(holdings=[{"ticker": "BTC", "weight": 1}]))
        self.assertEqual(metrics["max_drawdown"], .2)
