"""
TASK 02 — /api/ai-chat trace wiring tests.

Uses the Flask test client with injected fakes:
  - FakeRAG / FakeLLM / FakeDB（no real Supabase, no real OpenAI）
  - RAGTraceService with InMemoryTraceStore + controlled db stores
No real secret, service-role key, production DB, or user data anywhere.
"""

import json
import logging
import sys
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import app as app_module  # noqa: E402

from services.rag_trace_service import (  # noqa: E402
    InMemoryTraceStore,
    RAGTraceService,
    SupabaseTraceStore,
    TRACE_SR_MISSING,
)

DEMO_TOKEN = "smartinvest-demo-member-token"
TEST_HMAC_SECRET = "test-hmac-secret-not-real-0123456789abcdef"
FAKE_URL = "https://example.supabase.co"
FAKE_SR_KEY = "test-service-role-placeholder-not-a-real-key"
USER_A = "11111111-2222-3333-4444-555555555555"
USER_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class FakeRAG:
    def __init__(self, context=None, citations=None, confidence="high",
                 retrieval_results=None, metrics_record=None,
                 injected_count=None, raise_error=False):
        self._context = context
        self._citations = citations
        self._confidence = confidence
        self._results = retrieval_results
        self._metrics = metrics_record
        self._injected = injected_count
        self._raise = raise_error

    def augment_chat(self, user_msg, risk_profile="穩健型"):
        if self._raise:
            raise RuntimeError("rag exploded")
        return {
            "system": ["system"],
            "context": self._context if self._context is not None else ["- [投資原則] 定期定額…"],
            "citations": self._citations if self._citations is not None
                else ["知識庫: investment_rules.md (投資原則)"],
            "user_message": user_msg,
            "confidence": self._confidence,
            "injected_count": self._injected if self._injected is not None else 1,
            "retrieval_results": self._results if self._results is not None else [
                types.SimpleNamespace(
                    snippet="定期定額是基礎，聯絡 support@example.com",
                    source="investment_rules.md",
                    topic="投資原則",
                    score=0.8,
                    metadata={"chunk_id": "investment_rules#3", "section": "DCA",
                              "content_hash": "abc123"},
                ),
                types.SimpleNamespace(
                    snippet="比特幣波動高",
                    source="coin_profiles.json",
                    topic="市場敘事",
                    score=0.5,
                    metadata={"chunk_id": "coin_profiles#0", "section": "BTC",
                              "content_hash": "def456"},
                ),
            ],
            "metrics_record": self._metrics if self._metrics is not None else {
                "route_type": "deep",
                "fallback_reason": "",
                "empty_context": False,
                "rewrite_used": True,
                "rewrite_rejected": False,
                "rewrite_similarity": 0.95,
                "sparse_hit_count": 3,
                "dense_hit_count": 2,
                "final_context_count": 2,
                "retrieval_latency_ms": 12.3,
                "rerank_latency_ms": 4.1,
                "total_rag_latency_ms": 18.0,
            },
        }


class FakeLLM:
    def __init__(self, reply="這是 AI 測試回答", prompt_tokens=12,
                 completion_tokens=7, error=None):
        self._reply = reply
        self._prompt_tokens = prompt_tokens
        self._completion_tokens = completion_tokens
        self._error = error

        def create(**kwargs):
            if self._error:
                raise self._error
            message = types.SimpleNamespace(content=self._reply, tool_calls=[])
            usage = types.SimpleNamespace(prompt_tokens=self._prompt_tokens,
                                          completion_tokens=self._completion_tokens)
            return types.SimpleNamespace(
                usage=usage, choices=[types.SimpleNamespace(message=message)])

        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))


class FakeAuth:
    USERS = {
        "valid-token-a": USER_A,
        "valid-token-b": USER_B,
    }

    def get_user(self, token):
        uid = self.USERS.get(token)
        if not uid:
            raise RuntimeError("invalid token")
        return types.SimpleNamespace(
            user=types.SimpleNamespace(id=uid, email="user@example.com"))


class FakeDB:
    def __init__(self):
        self.client = types.SimpleNamespace(auth=FakeAuth())

    def create_conversation(self, user_id, title, ai_model="gpt-4o-mini"):
        return "conv-1"

    def create_conversation_authed(self, access_token, user_id, title, ai_model="gpt-4o-mini"):
        return "conv-1"

    def get_conversation_history(self, conversation_id):
        return []

    def get_conversation_history_authed(self, access_token, conversation_id):
        return []

    def save_message(self, *args, **kwargs):
        return True

    def save_message_authed(self, *args, **kwargs):
        return True

    def list_conversations(self, user_id, limit=50):
        return []

    def list_conversations_authed(self, access_token, user_id, limit=50):
        return []


class BaseChatTraceTest(unittest.TestCase):
    def setUp(self):
        self.mem = InMemoryTraceStore()
        self.trace_svc = RAGTraceService(
            store=self.mem, db_store=None, hmac_secret=TEST_HMAC_SECRET)
        self.patchers = [
            mock.patch.object(app_module, "_trace", self.trace_svc),
            mock.patch.object(app_module, "client", FakeLLM()),
            mock.patch.object(app_module, "_rag", FakeRAG()),
            mock.patch.object(app_module, "_rag_available", True),
            mock.patch.object(app_module, "db", FakeDB()),
        ]
        for p in self.patchers:
            p.start()
        app_module.app.config["TESTING"] = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        for p in self.patchers:
            p.stop()

    def _post(self, message, token=DEMO_TOKEN):
        return self.client.post(
            "/api/ai-chat",
            json={"message": message, "risk_profile": "穩健型"},
            headers={"Authorization": f"Bearer {token}"},
        )


class NormalChatTraceTests(BaseChatTraceTest):
    def test_normal_rag_answer_creates_run_with_sources(self):
        resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["reply"], "這是 AI 測試回答")
        self.assertEqual(data["conversation_id"], "conv-1")
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(data["citations"], ["知識庫: investment_rules.md (投資原則)"])
        self.assertEqual(data["confidence"], "high")

        records = self.mem.recent(1)
        self.assertEqual(len(records), 1)
        r = records[0]
        self.assertEqual(r.trace_id, data["trace_id"])
        self.assertEqual(r.endpoint, "chat")
        self.assertIsNone(r.user_id)  # demo 使用者不寫 user_id
        self.assertEqual(r.conversation_id, "conv-1")
        self.assertEqual(r.status, "success")
        self.assertEqual(r.answer, "這是 AI 測試回答")
        self.assertEqual(r.sanitized_query, "比特幣適合長期持有嗎")
        self.assertRegex(r.query_hash, r"^[0-9a-f]{64}$")
        self.assertEqual(r.prompt_tokens, 12)
        self.assertEqual(r.completion_tokens, 7)
        self.assertGreaterEqual(r.total_latency_ms, 0)
        self.assertEqual(len(r.sources), 2)
        self.assertEqual([s["rank"] for s in r.sources], [1, 2])
        self.assertEqual([s["actually_injected"] for s in r.sources], [True, False])
        self.assertNotIn("@", r.sources[0]["excerpt"])
        self.assertNotIn("support@example.com", str(r.sources))

    def test_empty_context_fallback_still_has_run(self):
        app_module._rag = FakeRAG(
            context=[], citations=[], confidence="low",
            retrieval_results=[], injected_count=0,
            metrics_record={"fallback_reason": "", "empty_context": True,
                            "route_type": "fast"},
        )
        resp = self._post("冷門問題")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["reply"], "這是 AI 測試回答")
        self.assertEqual(data["confidence"], "low")
        r = self.mem.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)
        self.assertTrue(r.empty_context)
        self.assertEqual(r.sources, [])

    def test_llm_error_run_failed_and_api_behavior_unchanged(self):
        app_module.client = FakeLLM(error=RuntimeError("model backend down"))
        resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["reply"], "系統錯誤，請稍後再試。")
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(data["citations"], [])
        self.assertIsNone(data["confidence"])
        r = self.mem.recent(1)[0]
        self.assertEqual(r.status, "error")
        self.assertEqual(r.error, "ai_chat_error")
        self.assertEqual(r.answer, "")

    def test_llm_error_does_not_leak_exception_text(self):
        app_module.client = FakeLLM(
            error=RuntimeError("provider failed token=sk-secret123456789012"))
        resp = self._post("比特幣適合長期持有嗎")
        data = resp.get_json()
        text = json.dumps(data, ensure_ascii=False)
        self.assertNotIn("sk-secret123456789012", text)
        self.assertNotIn("provider failed", text)
        r = self.mem.recent(1)[0]
        self.assertNotIn("sk-secret", r.error)
        self.assertNotIn("sk-secret", r.fallback_reason)


class TraceStoreFailureTests(BaseChatTraceTest):
    def test_db_store_failure_chat_still_succeeds(self):
        class FailingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                return False, "trace_run_write_failed"

        app_module._trace = RAGTraceService(
            store=self.mem, db_store=FailingStore(), hmac_secret=TEST_HMAC_SECRET)
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["reply"], "這是 AI 測試回答")
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")
        self.assertTrue(any("trace_run_write_failed" in line for line in cm.output))
        self.assertEqual(len(self.mem.recent(1)), 1)

    def test_db_store_source_failure_chat_still_succeeds(self):
        class SourceFailingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                return False, "trace_source_write_failed"

        app_module._trace = RAGTraceService(
            store=self.mem, db_store=SourceFailingStore(), hmac_secret=TEST_HMAC_SECRET)
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["reply"], "這是 AI 測試回答")
        self.assertTrue(any("trace_source_write_failed" in line for line in cm.output))
        self.assertEqual(len(self.mem.recent(1)), 1)

    def test_primary_store_raise_chat_still_succeeds(self):
        class RaisingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                raise RuntimeError("primary store exploded")

        app_module._trace = RAGTraceService(
            store=RaisingStore(), db_store=None, hmac_secret=TEST_HMAC_SECRET)
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        # 必須回原本成功回答，不得變成「系統錯誤」
        self.assertEqual(data["reply"], "這是 AI 測試回答")
        self.assertEqual(data["conversation_id"], "conv-1")
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")
        self.assertTrue(any("trace_store_error" in line for line in cm.output))

    def test_rag_error_chat_still_succeeds(self):
        app_module._rag = FakeRAG(raise_error=True)
        resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["reply"], "這是 AI 測試回答")
        r = self.mem.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)
        self.assertEqual(r.sources, [])

    def test_rag_none_marks_degraded_kb_unavailable(self):
        app_module._rag = None
        app_module._rag_available = False
        resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["reply"], "這是 AI 測試回答")
        r = self.mem.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)
        self.assertEqual(r.fallback_reason, "kb_unavailable")
        self.assertEqual(r.sources, [])

    def test_rag_unavailable_marks_degraded_kb_unavailable(self):
        app_module._rag = FakeRAG()  # 存在但 kb 未載入
        app_module._rag_available = False
        resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["reply"], "這是 AI 測試回答")
        r = self.mem.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)
        self.assertEqual(r.fallback_reason, "kb_unavailable")


class ServiceRoleFailClosedTests(BaseChatTraceTest):
    def test_anon_only_no_service_role_no_insert_chat_ok(self):
        store = SupabaseTraceStore(url=FAKE_URL, service_role_key="")
        app_module._trace = RAGTraceService(
            store=self.mem, db_store=store, hmac_secret=TEST_HMAC_SECRET)
        self.assertIsNone(store._client)  # 無 client → 不可能嘗試 insert
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["reply"], "這是 AI 測試回答")
        self.assertTrue(any(TRACE_SR_MISSING in line for line in cm.output))
        self.assertEqual(len(self.mem.recent(1)), 1)

    def test_injected_service_role_store_write_path_called(self):
        calls = []

        class RecordingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                calls.append(record)
                return True, ""

        app_module._trace = RAGTraceService(
            store=self.mem, db_store=RecordingStore(), hmac_secret=TEST_HMAC_SECRET)
        resp = self._post("比特幣適合長期持有嗎")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(calls), 1)
        record = calls[0]
        self.assertRegex(record.query_hash, r"^[0-9a-f]{64}$")
        self.assertEqual(len(record.sources), 2)
        self.assertEqual(record.answer, "這是 AI 測試回答")


class UserLinkageTests(BaseChatTraceTest):
    def test_demo_user_has_null_user_id(self):
        self._post("問題一")
        self.assertIsNone(self.mem.recent(1)[0].user_id)

    def test_real_user_gets_own_uid(self):
        resp = self._post("問題一", token="valid-token-a")
        self.assertEqual(resp.status_code, 200)
        r = self.mem.recent(1)[0]
        self.assertEqual(r.user_id, USER_A)
        uuid.UUID(r.user_id)  # 必須是合法 UUID

    def test_users_do_not_pollute_each_other(self):
        self._post("問題一", token="valid-token-a")
        self._post("問題一", token="valid-token-b")
        self._post("問題一", token=DEMO_TOKEN)
        records = self.mem.recent(3)
        self.assertEqual(
            [r.user_id for r in records], [USER_A, USER_B, None])


class ApiCompatibilityTests(BaseChatTraceTest):
    def test_response_keys_are_incremental_only(self):
        resp = self._post("比特幣適合長期持有嗎")
        data = resp.get_json()
        self.assertEqual(
            set(data.keys()),
            {"reply", "conversation_id", "trace_id", "citations", "confidence"},
        )
        self.assertIsInstance(data["reply"], str)
        self.assertIsInstance(data["conversation_id"], str)
        self.assertIsInstance(data["trace_id"], str)
        self.assertIsInstance(data["citations"], list)

    def test_empty_message_400_unchanged(self):
        resp = self._post("")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.get_json(), {"reply": "請先輸入訊息內容。"})

    def test_unauthorized_401_no_trace_created(self):
        resp = self.client.post(
            "/api/ai-chat", json={"message": "問題"})
        self.assertEqual(resp.status_code, 401)
        self.assertEqual(self.mem.recent(10), [])

    def test_existing_history_and_conversations_endpoints_unchanged(self):
        hist = self.client.get(
            "/api/ai-chat/history?conversation_id=conv-1",
            headers={"Authorization": f"Bearer {DEMO_TOKEN}"})
        conv = self.client.get(
            "/api/ai-chat/conversations",
            headers={"Authorization": f"Bearer {DEMO_TOKEN}"})
        self.assertEqual(hist.status_code, 200)
        self.assertEqual(conv.status_code, 200)

    def test_response_and_logs_contain_no_secret(self):
        records = []
        handler = logging.Handler()
        handler.emit = lambda record: records.append(record)
        logger = logging.getLogger("services.rag_trace_service")
        logger.addHandler(handler)
        try:
            resp = self._post("查詢投資建議")
        finally:
            logger.removeHandler(handler)
        data = resp.get_json()
        payload_text = json.dumps(data, ensure_ascii=False)
        self.assertNotIn(TEST_HMAC_SECRET, payload_text)
        self.assertNotIn(FAKE_SR_KEY, payload_text)
        self.assertNotIn("service_role", payload_text.lower())
        for record in records:
            self.assertNotIn(TEST_HMAC_SECRET, record.getMessage())
            self.assertNotIn(FAKE_SR_KEY, record.getMessage())
            self.assertNotIn("查詢投資建議", record.getMessage())


class RewriteFallbackEndpointTests(BaseChatTraceTest):
    """Codex R2：rewrite exception 下 Chat 回答／HTTP 行為不變、trace degraded、無 token 外洩。"""

    def test_rewrite_exception_endpoint_behavior(self):
        from services.rag_service import RAGService
        from services.query_rewrite_service import QueryRewriteService

        real_rag = RAGService()
        # 測試環境適應：venv 無 jieba/dense 時，sparse 檢索的 topic filter
        # 會使結果為 0；此 patch 僅把 filter 移除，檢索引擎本身仍為真實實作。
        real_retrieve = real_rag._retrieval.retrieve_with_meta
        real_rag._retrieval.retrieve_with_meta = (
            lambda query, topics=None, max_results=3: real_retrieve(
                query, topics=None, max_results=max_results)
        )

        fake_token = "sk-fake-secret-token-0123456789abcdef"
        patcher = mock.patch.object(
            QueryRewriteService, "rewrite",
            side_effect=RuntimeError("rewriter crashed token=" + fake_token))
        patcher.start()
        self.addCleanup(patcher.stop)

        app_module._rag = real_rag
        app_module._rag_available = True

        resp = self._post("比特幣？以太幣？")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        # Chat 原回答與既有欄位不變
        self.assertEqual(data["reply"], "這是 AI 測試回答")
        self.assertEqual(data["conversation_id"], "conv-1")
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")
        # citation 保留
        self.assertGreaterEqual(len(data["citations"]), 1)
        # fake token 不得出現在 API response
        self.assertNotIn(fake_token, json.dumps(data, ensure_ascii=False))

        record = self.mem.recent(1)[0]
        self.assertEqual(record.status, "degraded")
        self.assertTrue(record.fallback)
        self.assertEqual(record.fallback_reason, "rewrite_error")
        self.assertGreaterEqual(len(record.sources), 1)
        self.assertNotIn(fake_token, json.dumps(
            record.to_run_payload(), ensure_ascii=False))
        self.assertNotIn(fake_token, json.dumps(
            record.to_source_payloads("run-1"), ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
