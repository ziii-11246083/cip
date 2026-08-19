"""
TASK 04（Codex R1 必修1）— feedback DB 路徑 log 固定化測試。

令 _authed_client 的 postgrest.auth、lookup、upsert 分別 raise 含合成
Bearer/API key 的 exception，capture supabase_client logger 後斷言：
secret／exception 原文／traceback 不得出現，只出現固定 allowlisted code。
"""

import logging
import sys
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import supabase_client as sc  # noqa: E402

SECRET = "Bearer sk-fake-feedback-secret-DO-NOT-LOG"
API_KEY = "sk-fake-feedback-api-key-DO-NOT-LOG"


class FeedbackLogLeakTests(unittest.TestCase):
    def _capture_logs(self):
        records = []
        handler = logging.Handler()
        handler.emit = lambda record: records.append(record)
        logger = logging.getLogger("supabase_client")
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        return records

    def _db(self):
        db = sc.SupabaseDB()
        db.url = "https://example.supabase.co"
        db.anon_key = "anon-placeholder"
        db.service_key = "sr-placeholder"
        db._initialized = True
        return db

    def _assert_code_only(self, records, code):
        text = "\n".join(r.getMessage() for r in records)
        self.assertIn(f"code={code}", text)
        self.assertNotIn(SECRET, text)
        self.assertNotIn(API_KEY, text)
        self.assertNotIn("sk-fake", text)
        self.assertNotIn("Traceback", text)

    def test_authed_client_failure_logs_code_only(self):
        records = self._capture_logs()
        db = self._db()
        fake = mock.Mock()
        fake.postgrest.auth.side_effect = RuntimeError(f"auth failed {SECRET}")
        with mock.patch.object(sc, "create_client", return_value=fake):
            with self.assertRaises(RuntimeError):
                db._authed_client("some-access-token")
        self._assert_code_only(records, "rag_authed_client_failed")

    def test_lookup_failure_logs_code_only(self):
        records = self._capture_logs()
        db = self._db()
        with mock.patch.object(
            db, "_authed_table",
            side_effect=RuntimeError(f"lookup failed {SECRET} {API_KEY}"),
        ):
            run_id, code = db.rag_find_run_id_by_trace("tok", "uid", "trace-12345678")
        self.assertIsNone(run_id)
        self.assertEqual(code, "rag_run_lookup_failed")
        self._assert_code_only(records, "rag_run_lookup_failed")

    def test_upsert_failure_logs_code_only(self):
        records = self._capture_logs()
        db = self._db()
        with mock.patch.object(
            db, "_authed_table",
            side_effect=RuntimeError(f"upsert failed {SECRET}"),
        ):
            ok, code = db.rag_upsert_feedback("tok", "run-1", "uid", "up")
        self.assertFalse(ok)
        self.assertEqual(code, "feedback_upsert_failed")
        self._assert_code_only(records, "feedback_upsert_failed")

    def test_lookup_upsert_return_codes_unchanged(self):
        """既有回傳固定 error code 行為不變（review：保留既有行為）。"""
        db = self._db()
        with mock.patch.object(db, "_authed_table", side_effect=RuntimeError("boom")):
            self.assertEqual(db.rag_find_run_id_by_trace("t", "u", "x" * 8),
                             (None, "rag_run_lookup_failed"))
            self.assertEqual(db.rag_upsert_feedback("t", "r", "u", "up"),
                             (False, "feedback_upsert_failed"))


if __name__ == "__main__":
    unittest.main()
