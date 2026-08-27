"""TASK 06 — RAG admin endpoints auth、public stats、rebuild lock/failure/audit tests."""

import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import app as app_module  # noqa: E402

NORMAL_TOKEN = "normal-token"
ADMIN_TOKEN = "admin-token"
SPOOF_TOKEN = "spoof-token"
FAKE_SECRET = "sk-fake-admin-secret-DO-NOT-LOG"


class FakeAuth:
    def get_user(self, token):
        if token == NORMAL_TOKEN:
            user = types.SimpleNamespace(
                id="11111111-1111-1111-1111-111111111111",
                email="member@example.com", app_metadata={},
                user_metadata={})
        elif token == ADMIN_TOKEN:
            user = types.SimpleNamespace(
                id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                email="admin-user@example.com",
                app_metadata={"role": "admin"}, user_metadata={})
        elif token == SPOOF_TOKEN:
            user = types.SimpleNamespace(
                id="22222222-2222-2222-2222-222222222222",
                email="admin@example.com", app_metadata={},
                user_metadata={"role": "admin", "is_admin": True})
        else:
            raise RuntimeError("invalid")
        return types.SimpleNamespace(user=user)


class FakeDB:
    def __init__(self):
        self.client = types.SimpleNamespace(auth=FakeAuth())


class FakeRetrieval:
    def __init__(self, count=7, error=None):
        self.count = count
        self.error = error
        self.calls = 0

    def rebuild_index(self):
        self.calls += 1
        if self.error:
            raise self.error
        return self.count


class FakeRAG:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    def _retrieve_for_endpoint(self, query, endpoint="chat", max_results=3):
        self.calls.append((query, endpoint, max_results))
        if self.error:
            raise self.error
        result = types.SimpleNamespace(
            topic=f"投資原則 Bearer {FAKE_SECRET}",
            source=f"/private/server/knowledge/{FAKE_SECRET}/rules.md",
            score=0.75,
            snippet=f"安全片段 Bearer {FAKE_SECRET}",
        )
        return {
            "results": [result],
            "route_decision": types.SimpleNamespace(route="deep"),
            "meta": {"method": "hybrid"},
        }


class RagAdminSecurityTests(unittest.TestCase):
    def setUp(self):
        self.db_patch = mock.patch.object(app_module, "db", FakeDB())
        self.db_patch.start()
        app_module.app.config["TESTING"] = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        self.db_patch.stop()
        if app_module._RAG_REBUILD_LOCK.locked():
            app_module._RAG_REBUILD_LOCK.release()

    @staticmethod
    def _headers(token):
        return {"Authorization": f"Bearer {token}"} if token else {}

    def test_protected_endpoints_anonymous_401_and_normal_user_403(self):
        calls = [
            ("post", "/api/rag/rebuild-index", None),
            ("post", "/api/rag/eval", {"queries": ["test"]}),
            ("get", "/api/rag/stats/details", None),
        ]
        for method, path, payload in calls:
            with self.subTest(path=path, role="anonymous"):
                response = getattr(self.client, method)(path, json=payload)
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.get_json()["code"], "auth/unauthorized")
            with self.subTest(path=path, role="normal"):
                response = getattr(self.client, method)(
                    path, json=payload, headers=self._headers(NORMAL_TOKEN))
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.get_json()["code"], "auth/forbidden")

    def test_email_and_user_metadata_cannot_spoof_admin(self):
        response = self.client.get(
            "/api/rag/stats/details", headers=self._headers(SPOOF_TOKEN))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "auth/forbidden")

    def test_demo_member_is_not_admin(self):
        response = self.client.post(
            "/api/rag/rebuild-index",
            headers=self._headers(app_module.DEMO_MEMBER_TOKEN))
        self.assertEqual(response.status_code, 403)

    def test_public_stats_contains_only_health_summary(self):
        components = {"embeddings": True, "vector_store": False,
                      "bm25": True, "reranker": True}
        with mock.patch.object(app_module, "_rag_component_health", return_value=components), \
             mock.patch.object(app_module, "_rag_available", True):
            response = self.client.get("/api/rag/stats")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data, {
            "status": "degraded", "kb_loaded": True,
            "available_components": 3, "total_components": 4,
        })
        encoded = json.dumps(data)
        for forbidden in ["query", "user", "path", "config", "model", "metrics"]:
            self.assertNotIn(forbidden, encoded.lower())

    def test_admin_details_are_aggregate_and_config_secret_is_masked(self):
        fake_metrics = types.SimpleNamespace(
            enabled=True, get_stats=lambda: {
                "count": 3, "avg_latency_ms": 10.0,
                "query": f"Bearer {FAKE_SECRET}", "records": [{"user": FAKE_SECRET}],
            })
        fake_bm25 = types.SimpleNamespace(corpus_size=12)
        with mock.patch.object(app_module, "_rag_component_health", return_value={
                "embeddings": True, "vector_store": True,
                "bm25": True, "reranker": True}), \
             mock.patch.object(app_module, "_rag_metrics", fake_metrics), \
             mock.patch("services.bm25_service.get_bm25", return_value=fake_bm25), \
             mock.patch.object(app_module.Config, "RAG_EMBEDDING_MODEL",
                               f"Bearer {FAKE_SECRET}"):
            response = self.client.get(
                "/api/rag/stats/details", headers=self._headers(ADMIN_TOKEN))
        self.assertEqual(response.status_code, 200)
        encoded = json.dumps(response.get_json(), ensure_ascii=False)
        self.assertNotIn(FAKE_SECRET, encoded)
        self.assertNotIn('"query":', encoded.lower())
        self.assertNotIn('"user":', encoded.lower())
        self.assertNotIn('"path":', encoded.lower())
        self.assertEqual(response.get_json()["metrics"]["count"], 3)

    def test_admin_rebuild_success(self):
        retrieval = FakeRetrieval(count=7)
        with mock.patch("services.retrieval_service.get_retrieval", return_value=retrieval), \
             mock.patch.object(app_module, "_verify_rag_rebuild", return_value=True):
            response = self.client.post(
                "/api/rag/rebuild-index", headers=self._headers(ADMIN_TOKEN))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["indexed_chunks"], 7)
        self.assertEqual(retrieval.calls, 1)

    def test_concurrent_rebuild_is_409_and_does_not_start_second(self):
        retrieval = FakeRetrieval(count=7)
        app_module._RAG_REBUILD_LOCK.acquire()
        with mock.patch("services.retrieval_service.get_retrieval", return_value=retrieval):
            response = self.client.post(
                "/api/rag/rebuild-index", headers=self._headers(ADMIN_TOKEN))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "rag/rebuild-in-progress")
        self.assertEqual(retrieval.calls, 0)

    def test_rebuild_exception_and_zero_verification_are_fixed_failure(self):
        for retrieval, verify in [
            (FakeRetrieval(error=RuntimeError(f"boom Bearer {FAKE_SECRET}")), True),
            (FakeRetrieval(count=0), False),
        ]:
            with self.subTest(error=bool(retrieval.error)), \
                 mock.patch("services.retrieval_service.get_retrieval", return_value=retrieval), \
                 mock.patch.object(app_module, "_verify_rag_rebuild", return_value=verify), \
                 self.assertLogs(app_module.app.logger.name, level="INFO") as captured:
                response = self.client.post(
                    "/api/rag/rebuild-index", headers=self._headers(ADMIN_TOKEN))
            self.assertEqual(response.status_code, 500)
            self.assertEqual(response.get_json()["code"], "rag/rebuild-failed")
            combined = json.dumps(response.get_json()) + "\n".join(captured.output)
            self.assertNotIn(FAKE_SECRET, combined)
            self.assertFalse(app_module._RAG_REBUILD_LOCK.locked())

    def test_admin_eval_validates_input_and_unavailable(self):
        invalid_payloads = [
            {"queries": "not-list"}, {"queries": []},
            {"queries": ["x"], "endpoint": "unknown"},
            {"queries": ["x" * 501]},
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=str(payload)[:20]):
                response = self.client.post(
                    "/api/rag/eval", json=payload, headers=self._headers(ADMIN_TOKEN))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()["code"], "rag/eval-invalid")
        with mock.patch.object(app_module, "_rag", None), \
             mock.patch.object(app_module, "_rag_available", False):
            response = self.client.post(
                "/api/rag/eval", json={"queries": ["x"]},
                headers=self._headers(ADMIN_TOKEN))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["code"], "rag/unavailable")

    def test_admin_eval_sanitizes_query_source_and_snippet(self):
        rag = FakeRAG()
        query = f"請測試 Bearer {FAKE_SECRET}"
        with mock.patch.object(app_module, "_rag", rag), \
             mock.patch.object(app_module, "_rag_available", True):
            response = self.client.post(
                "/api/rag/eval", json={"queries": [query], "endpoint": "chat"},
                headers=self._headers(ADMIN_TOKEN))
        self.assertEqual(response.status_code, 200)
        encoded = json.dumps(response.get_json(), ensure_ascii=False)
        self.assertNotIn(FAKE_SECRET, encoded)
        self.assertNotIn("/private/server", encoded)
        source = response.get_json()["eval_results"][0]["top_snippets"][0]["source"]
        self.assertEqual(source, "rules.md")

    def test_admin_eval_exception_is_fixed_and_audit_has_no_secret(self):
        rag = FakeRAG(error=RuntimeError(f"provider Bearer {FAKE_SECRET}"))
        with mock.patch.object(app_module, "_rag", rag), \
             mock.patch.object(app_module, "_rag_available", True), \
             self.assertLogs(app_module.app.logger.name, level="INFO") as captured:
            response = self.client.post(
                "/api/rag/eval", json={"queries": ["safe"]},
                headers=self._headers(ADMIN_TOKEN))
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.get_json()["code"], "rag/eval-failed")
        combined = json.dumps(response.get_json()) + "\n".join(captured.output)
        self.assertNotIn(FAKE_SECRET, combined)


if __name__ == "__main__":
    unittest.main()
