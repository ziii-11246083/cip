"""Cross-feature HTTP contracts with external calls isolated."""
import os
import socket
import unittest
from unittest.mock import patch


class FeatureSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        credentials = {key: "" for key in os.environ if any(x in key for x in ("OPENAI", "SUPABASE", "CG_API", "ALCHEMY"))}
        with patch.dict(os.environ, credentials), patch("dotenv.load_dotenv", return_value=False), patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test")):
            import app
        cls.module = app

    def setUp(self):
        self.enterContext(patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test")))
        self.client = self.module.app.test_client()

    def test_all_pages_render(self):
        for path in ("/", "/ui", "/market", "/analysis/BTC", "/social-sentiment", "/narrative-radar", "/ai-coach", "/agent", "/scam-detect", "/health", "/podcast", "/register", "/sim-trade", "/member"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn('class="footer-disclaimer"', response.get_data(as_text=True))

    def test_market_and_social_empty_provider_responses(self):
        m = self.module
        with patch.object(m.DataManager, "get_all_tickers", return_value=[]), patch.object(m.DataManager, "get_market_tickers", return_value=[]), patch.object(m.SocialMediaEngine, "scrape_ptt", return_value=[]), patch.object(m.SocialMediaEngine, "scrape_cnyes", return_value=[]), patch.object(m.SocialMediaEngine, "scrape_rss_for_signals", return_value=[]), patch.object(m.SocialMediaEngine, "fetch_narratives_full", return_value=[]):
            for path in ("/api/market", "/api/coingecko", "/api/social-data", "/api/narratives", "/api/sfi/search"):
                with self.subTest(path=path):
                    response = self.client.get(path)
                    self.assertEqual(response.status_code, 200)
                    self.assertIsNotNone(response.get_json())

    def test_popular_valid_and_invalid_limits(self):
        with patch.object(self.module.DataManager, "_cg_get", return_value=[]) as provider:
            for limit in ("abc", "0", "-1", "251", "1.5"):
                self.assertEqual(self.client.get("/crypto/popular", query_string={"per_page": limit}).status_code, 400)
            provider.assert_not_called()
            self.assertEqual(self.client.get("/crypto/popular?per_page=20").get_json(), [])
            provider.assert_called_once()

    def test_series_fallback_and_fomo_contract(self):
        with patch.object(self.module.DataManager, "_cg_get", return_value={}), patch.object(self.module, "_fetch_yfinance_series", return_value=[[1, 100], [2, 110]]):
            data = self.client.get("/crypto/series?ticker=BTC").get_json()
            self.assertEqual(data["source"], "yfinance")
            self.assertEqual(len(data["prices"]), 2)
        self.assertEqual(self.client.post("/api/check-fomo", json={"symbol": "BTC", "price_change_24h": 20}).get_json()["level"], "HIGH")

    def test_member_write_routes_reject_missing_login(self):
        for path in ("/api/ai-chat", "/api/agent-plan", "/api/agent-auto-order", "/api/sim-trade/order", "/api/sim-trade/reset", "/api/sim-trade/deposit", "/api/paper-stress-test", "/portfolio/risk-health", "/portfolio/analyze-llm", "/api/rag-feedback", "/api/asset-sync/accounts"):
            with self.subTest(path=path):
                self.assertEqual(self.client.post(path, json={}).status_code, 401)

    def test_tts_without_provider_returns_explicit_unavailable(self):
        with patch.object(self.module, "refresh_openai_client", return_value=None):
            for path in ("/podcast/tts", "/api/podcast/tts"):
                self.assertEqual(self.client.post(path, json={"text": "test"}).status_code, 503)

    def test_agent_orders_scale_to_available_cash(self):
        headers = {"Authorization": f"Bearer {self.module.DEMO_MEMBER_TOKEN}"}
        with patch.object(self.module, "sim_snapshot", return_value={"cash": 100}), patch.object(self.module, "execute_sim_order", return_value={"symbol": "BTC"}) as order:
            response = self.client.post("/api/agent-auto-order", headers=headers, json={"allocation": [{"symbol": "BTC", "amount_usd": 150}, {"symbol": "ETH", "amount_usd": 50}]})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.get_json()["scaled"])
            self.assertEqual([call.kwargs["amount_usd"] for call in order.call_args_list], [75, 25])

    def test_coin_details_with_known_history(self):
        history = [100 + index for index in range(60)]
        coins = [{"symbol": symbol, "history_prices": history} for symbol in ("BTC", "ETH")]
        with patch.object(self.module.DataManager, "get_all_tickers", return_value=coins):
            response = self.client.get("/api/details/ETH")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertNotIn("error", data)
        self.assertEqual(len(data["coin_returns"]), 59)
        self.assertIn("simulation", data)
