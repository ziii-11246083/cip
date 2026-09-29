"""Cross-feature HTTP contracts with external calls isolated."""
import os
import socket
import unittest
from pathlib import Path
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
        for path in ("/", "/ui", "/market", "/analysis/BTC", "/social-sentiment", "/narrative-radar", "/ai-coach", "/scam-detect", "/health", "/podcast", "/register", "/membership", "/sim-trade", "/member"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn('class="footer-disclaimer"', response.get_data(as_text=True))
                self.assertNotIn("訪客使用", response.get_data(as_text=True))
                self.assertNotIn("continueAsGuest", response.get_data(as_text=True))

    def test_old_agent_url_redirects_to_coach(self):
        response = self.client.get("/agent")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/ai-coach")

    def test_upgrade_teaser_links_to_unpaid_plan(self):
        for path in ("/", "/register", "/member"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertIn('href="/membership"', html)
        member_html = self.client.get("/member").get_data(as_text=True)
        self.assertIn('id="membership-plan"', member_html)
        self.assertIn("NT$99", member_html)
        self.assertIn("目前尚未開放訂閱或扣款", member_html)
        self.assertNotIn("立即付款", member_html)
        self.assertIn('id="editProfileBtn"', member_html)
        self.assertIn('id="profileForm"', member_html)
        self.assertIn('id="subscriptionDialog"', member_html)
        self.assertGreaterEqual(member_html.count('data-subscribe-open'), 2)
        self.assertIn("原有會員與 TEST 帳號為進階會員", member_html)
        self.assertIn("免費會員", member_html)
        self.assertEqual(member_html.count('<article class="member-plan'), 2)
        self.assertNotIn("member-plan-test", member_html)
        self.assertNotIn("TEST 已屬進階會員；作為展示帳號，不連結真實錢包", member_html)
        self.assertIn("示範連結錢包", member_html)
        self.assertIn('id="subscriptionContinueFree"', member_html)
        self.assertIn("查看目前訂閱狀態", member_html)
        self.assertIn('id="realAssetForm" hidden', member_html)

    def test_podcast_is_public_without_guest_activation(self):
        html = self.client.get("/podcast").get_data(as_text=True)
        self.assertIn('id="btnGenPodcast"', html)
        self.assertNotIn("btnEnablePodcastGuest", html)
        self.assertNotIn("podcastGuestGate", html)
        self.assertNotIn("訪客使用", html)
        source = (Path(__file__).resolve().parents[1] / "static/js/podcast.js").read_text(encoding="utf-8")
        self.assertNotIn("ensurePodcastAccess", source)
        with patch.object(self.module, "refresh_openai_client", return_value=None):
            response = self.client.post("/podcast/generate", json={"market": "BTC"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("lines", response.get_json())

    def test_membership_entry_and_unpaid_join_flow(self):
        home = self.client.get("/").get_data(as_text=True)
        self.assertIn('class="join-member-link" href="/membership"', home)
        page = self.client.get("/membership").get_data(as_text=True)
        self.assertIn("免費會員", page)
        self.assertIn("進階會員", page)
        self.assertIn("NT$99", page)
        self.assertIn('id="joinPremiumBtn"', page)
        self.assertIn('id="membershipDialog"', page)
        self.assertIn("付款與正式訂閱尚未開放", page)
        self.assertIn("agent-cat-focus.png", page)

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
