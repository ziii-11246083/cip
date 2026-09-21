"""Regression checks for accidentally committed merge conflicts.

Run with: python -B -m unittest discover -s tests -v
"""

import ast
import os
from pathlib import Path
import re
import socket
import subprocess
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


class MergeRecoveryTests(unittest.TestCase):
    def test_tracked_files_have_no_conflict_markers(self):
        files = subprocess.check_output(
            ["git", "ls-files", "-z"], cwd=ROOT
        ).decode("utf-8").split("\0")
        marker = re.compile(r"^(?:<{7} |={7}$|>{7} )", re.MULTILINE)
        for name in filter(None, files):
            with self.subTest(file=name):
                try:
                    content = (ROOT / name).read_text(encoding="utf-8-sig")
                except UnicodeError:
                    continue
                self.assertIsNone(marker.search(content), name)

    def test_python_sources_compile(self):
        files = subprocess.check_output(
            ["git", "ls-files", "-z", "*.py"], cwd=ROOT
        ).decode("utf-8").split("\0")
        for name in filter(None, files):
            with self.subTest(file=name):
                ast.parse((ROOT / name).read_text(encoding="utf-8-sig"), filename=name)

    def test_pages_and_member_routes_without_external_services(self):
        # Disable local credentials and outbound connections for this smoke test.
        credentials = {
            key: "" for key in os.environ
            if any(part in key for part in ("OPENAI", "SUPABASE", "CG_API"))
        }
        with (
            patch.dict(os.environ, credentials),
            patch("dotenv.load_dotenv", return_value=False),
            patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test")),
        ):
            import app

            with patch.dict(app.app.config, TESTING=True):
                client = app.app.test_client()
                for path in (
                    "/", "/market", "/ai-coach", "/agent", "/health", "/sim-trade",
                    "/member", "/podcast", "/register", "/scam-detect",
                    "/social-sentiment", "/narrative-radar",
                ):
                    with self.subTest(page=path):
                        response = client.get(path)
                        self.assertEqual(response.status_code, 200)
                        html = response.get_data(as_text=True)
                        self.assertEqual(html.count('<footer class="footer">'), 1)
                        self.assertIn('class="footer-disclaimer"', html)

                response = client.get("/api/market-scenarios")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    set(response.get_json()["scenarios"]),
                    {"normal", "bull", "bear", "black_swan"},
                )
                for path in (
                    "/portfolio/risk-health", "/portfolio/analyze-llm",
                    "/api/portfolio/analyze",
                ):
                    with self.subTest(protected_route=path):
                        response = client.post(path, json={})
                        self.assertEqual(response.status_code, 401)
                        self.assertEqual(response.get_json()["code"], "auth/unauthorized")


if __name__ == "__main__":
    unittest.main()
