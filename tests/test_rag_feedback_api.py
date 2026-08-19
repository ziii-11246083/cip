"""
TASK 04 — POST /api/rag-feedback API 測試（Flask test client＋注入 fakes）。

覆蓋：success、401、demo 403 fail closed、wrong-user／不存在統一 404、
validation 400、重複／改票單列、client 無法指定 user_id/run_id、
DB 例外固定安全錯誤（不外洩 exception/token）。
"""

import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import app as app_module  # noqa: E402

DEMO_TOKEN = "smartinvest-demo-member-token"
USER_A = "11111111-2222-3333-4444-555555555555"
TOKEN_A = "valid-token-a"
USER_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
TOKEN_B = "valid-token-b"
TRACE_A = "trace-aaaaaaaa-111111111111111111111111"
TRACE_MISSING = "trace-missing-00000000000000000000000"
RUN_A = "run-id-aaaa"


class FakeAuth:
    USERS = {TOKEN_A: USER_A, TOKEN_B: USER_B}

    def get_user(self, token):
        uid = self.USERS.get(token)
        if not uid:
            raise RuntimeError("invalid token")
        return types.SimpleNamespace(
            user=types.SimpleNamespace(id=uid, email="user@example.com"))


class FakeDB:
    """模擬 authed RLS 語意：lookup 只看得見「自己」的 run；upsert 以
    (run_id, user_id) 為唯一鍵，重複／改票只保留一列。"""

    def __init__(self):
        self.client = types.SimpleNamespace(auth=FakeAuth())
        self.runs = {TRACE_A: (RUN_A, USER_A)}  # trace → (run_id, owner_uid)
        self.feedback = {}                      # (run_id, user_id) → vote
        self.lookup_calls = []
        self.upsert_calls = []
        self.lookup_error = None
        self.upsert_error = None

    def rag_find_run_id_by_trace(self, access_token, user_id, trace_id):
        self.lookup_calls.append((access_token, user_id, trace_id))
        if self.lookup_error:
            return None, self.lookup_error
        entry = self.runs.get(trace_id)
        if not entry:
            return None, None
        run_id, owner = entry
        if owner != user_id:  # RLS 效果：他人 run 查無
            return None, None
        return run_id, None

    def rag_upsert_feedback(self, access_token, run_id, user_id, vote):
        self.upsert_calls.append((access_token, run_id, user_id, vote))
        if self.upsert_error:
            return False, self.upsert_error
        self.feedback[(run_id, user_id)] = vote
        return True, None


class BaseFeedbackTest(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        self.patchers = [
            mock.patch.object(app_module, "db", self.db),
        ]
        for p in self.patchers:
            p.start()
        app_module.app.config["TESTING"] = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        for p in self.patchers:
            p.stop()

    def _post(self, payload=None, token=TOKEN_A, raw=None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return self.client.post(
            "/api/rag-feedback",
            data=raw if raw is not None else json.dumps(payload),
            content_type="application/json",
            headers=headers,
        )


class FeedbackSuccessTests(BaseFeedbackTest):
    def test_success_up(self):
        resp = self._post({"trace_id": TRACE_A, "vote": "up"})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data, {"ok": True, "vote": "up", "trace_id": TRACE_A})
        self.assertEqual(self.db.feedback, {(RUN_A, USER_A): "up"})
        # lookup 使用使用者 JWT 與 server uid
        self.assertEqual(self.db.lookup_calls[-1], (TOKEN_A, USER_A, TRACE_A))
        self.assertEqual(self.db.upsert_calls[-1], (TOKEN_A, RUN_A, USER_A, "up"))

    def test_duplicate_same_vote_keeps_one_row(self):
        self._post({"trace_id": TRACE_A, "vote": "up"})
        self._post({"trace_id": TRACE_A, "vote": "up"})
        self.assertEqual(len(self.db.feedback), 1)
        self.assertEqual(self.db.feedback[(RUN_A, USER_A)], "up")

    def test_change_vote_keeps_one_row(self):
        self._post({"trace_id": TRACE_A, "vote": "up"})
        resp = self._post({"trace_id": TRACE_A, "vote": "down"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["vote"], "down")
        self.assertEqual(len(self.db.feedback), 1)
        self.assertEqual(self.db.feedback[(RUN_A, USER_A)], "down")

    def test_client_supplied_user_id_and_run_id_ignored(self):
        resp = self._post({
            "trace_id": TRACE_A, "vote": "up",
            "user_id": USER_B, "run_id": "attacker-run-id",
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self.db.feedback, {(RUN_A, USER_A): "up"})
        data = resp.get_json()
        self.assertNotIn("run_id", data)
        self.assertNotIn("user_id", data)


class FeedbackAuthTests(BaseFeedbackTest):
    def test_unauthorized_401(self):
        resp = self._post({"trace_id": TRACE_A, "vote": "up"}, token=None)
        self.assertEqual(resp.status_code, 401)
        self.assertEqual(self.db.lookup_calls, [])

    def test_demo_403_fail_closed(self):
        resp = self._post({"trace_id": TRACE_A, "vote": "up"}, token=DEMO_TOKEN)
        self.assertEqual(resp.status_code, 403)
        data = resp.get_json()
        self.assertEqual(data["error"], "feedback_not_available_for_demo")
        # fail closed：不得查詢或寫入
        self.assertEqual(self.db.lookup_calls, [])
        self.assertEqual(self.db.upsert_calls, [])

    def test_wrong_user_404_uniform(self):
        resp = self._post({"trace_id": TRACE_A, "vote": "up"}, token=TOKEN_B)
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.get_json()["error"], "trace_not_found")

    def test_trace_not_found_404_uniform(self):
        resp = self._post({"trace_id": TRACE_MISSING, "vote": "up"}, token=TOKEN_A)
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.get_json()["error"], "trace_not_found")
        # 與 wrong-user 回應完全一致，不洩漏所有權資訊
        resp2 = self._post({"trace_id": TRACE_A, "vote": "up"}, token=TOKEN_B)
        self.assertEqual(resp.get_json(), resp2.get_json())


class FeedbackValidationTests(BaseFeedbackTest):
    def test_invalid_vote(self):
        for vote in ["maybe", "", None, 1, "UP"]:
            resp = self._post({"trace_id": TRACE_A, "vote": vote})
            self.assertEqual(resp.status_code, 400, vote)
            self.assertEqual(resp.get_json()["error"], "invalid_vote")

    def test_invalid_trace_id(self):
        for trace_id in ["short", "x" * 200, None, 123, ""]:
            resp = self._post({"trace_id": trace_id, "vote": "up"})
            self.assertEqual(resp.status_code, 400, trace_id)
            self.assertEqual(resp.get_json()["error"], "invalid_trace_id")

    def test_non_json_body_400(self):
        resp = self._post(raw="not-json{{{")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.get_json()["error"], "invalid_request")


class FeedbackDbFailureTests(BaseFeedbackTest):
    def test_lookup_db_error_503_fixed_message(self):
        self.db.lookup_error = "rag_run_lookup_failed"
        resp = self._post({"trace_id": TRACE_A, "vote": "up"})
        self.assertEqual(resp.status_code, 503)
        data = resp.get_json()
        self.assertEqual(data["error"], "db_unavailable")
        self.assertNotIn("rag_run_lookup_failed", json.dumps(data, ensure_ascii=False))
        self.assertNotIn("Exception", json.dumps(data, ensure_ascii=False))

    def test_upsert_db_error_500_fixed_message(self):
        self.db.upsert_error = "feedback_upsert_failed"
        resp = self._post({"trace_id": TRACE_A, "vote": "up"})
        self.assertEqual(resp.status_code, 500)
        data = resp.get_json()
        self.assertEqual(data["error"], "feedback_failed")
        self.assertNotIn("feedback_upsert_failed", json.dumps(data, ensure_ascii=False))

    def test_response_never_contains_token_or_internal_ids(self):
        resp = self._post({"trace_id": TRACE_A, "vote": "up"})
        text = json.dumps(resp.get_json(), ensure_ascii=False)
        self.assertNotIn(TOKEN_A, text)
        self.assertNotIn(RUN_A, text)
        self.assertNotIn(USER_A, text)


if __name__ == "__main__":
    unittest.main()
