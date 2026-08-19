"""
TASK 02 — RAG trace service unit tests (stdlib only, no real DB / secret).

Covers: PII masking, keyed HMAC, fail-closed SupabaseTraceStore
(service-role required), injected fake-client write path, status mapping,
user linkage isolation, and store-failure tolerance.
"""

import json
import logging
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from services.rag_trace_service import (  # noqa: E402
    ChatTraceRecord,
    InMemoryTraceStore,
    RAGTraceService,
    SupabaseTraceStore,
    TRACE_HMAC_SECRET_MISSING,
    TRACE_RUN_ID_MISSING,
    TRACE_RUN_WRITE_FAILED,
    TRACE_SOURCE_WRITE_FAILED,
    TRACE_SR_AMBIGUOUS,
    TRACE_SR_MISSING,
    hmac_query_hash,
    normalize_query,
    sanitize_text,
)

FAKE_URL = "https://example.supabase.co"
FAKE_SR_KEY = "test-service-role-placeholder-not-a-real-key"
TEST_HMAC_SECRET = "test-hmac-secret-not-real-0123456789abcdef"


def make_source(snippet, source="investment_rules.md", topic="投資原則",
                score=0.8, chunk_id="investment_rules#3", section="DCA",
                content_hash="abc123"):
    return types.SimpleNamespace(
        snippet=snippet,
        source=source,
        topic=topic,
        score=score,
        metadata={"chunk_id": chunk_id, "section": section,
                  "content_hash": content_hash, "method": "hybrid"},
    )


def make_rag_result(metrics=None):
    return {
        "citations": ["知識庫: investment_rules.md (投資原則)"],
        "confidence": "high",
        "injected_count": 1,
        "retrieval_results": [
            make_source("定期定額是長期投資的基礎，聯絡 support@example.com"),
            make_source("比特幣具高波動性", source="coin_profiles.json",
                        topic="市場敘事", score=0.5, chunk_id="coin_profiles#0",
                        section="BTC", content_hash="def456"),
        ],
        "metrics_record": metrics or {
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


class SanitizerTests(unittest.TestCase):
    def test_masks_email(self):
        self.assertEqual(sanitize_text("聯絡 a.b@example.com 謝謝"), "聯絡 <EMAIL> 謝謝")

    def test_masks_wallets(self):
        self.assertIn("<WALLET>", sanitize_text("轉到 0x1234567890abcdef1234567890abcdef12345678"))
        self.assertIn("<WALLET>", sanitize_text("地址 bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"))

    def test_masks_phone(self):
        self.assertIn("<PHONE>", sanitize_text("打我手機 0912-345-678"))
        self.assertIn("<PHONE>", sanitize_text("+886912345678"))

    def test_masks_url(self):
        self.assertEqual(sanitize_text("看 https://example.com/a?b=1 喔"), "看 <URL> 喔")

    def test_keeps_normal_text(self):
        text = "比特幣適合長期持有嗎？請分析風險。"
        self.assertEqual(sanitize_text(text), text)

    def test_truncates(self):
        self.assertEqual(len(sanitize_text("x" * 100, max_len=10)), 10)

    def test_empty(self):
        self.assertEqual(sanitize_text(None), "")
        self.assertEqual(sanitize_text(""), "")


class HmacTests(unittest.TestCase):
    def test_hmac_64_hex_deterministic(self):
        h1 = hmac_query_hash("比特幣長期持有", TEST_HMAC_SECRET)
        h2 = hmac_query_hash("比特幣長期持有", TEST_HMAC_SECRET)
        self.assertEqual(h1, h2)
        self.assertRegex(h1, r"^[0-9a-f]{64}$")

    def test_different_secret_different_hash(self):
        h1 = hmac_query_hash("比特幣", "secret-a")
        h2 = hmac_query_hash("比特幣", "secret-b")
        self.assertNotEqual(h1, h2)

    def test_missing_secret_returns_none(self):
        self.assertIsNone(hmac_query_hash("比特幣", ""))

    def test_normalize_collapses_whitespace_lowercase(self):
        self.assertEqual(normalize_query("  比特幣  長期  "), "比特幣 長期")


class InMemoryStoreTests(unittest.TestCase):
    def test_save_and_recent(self):
        store = InMemoryTraceStore()
        self.assertTrue(store.enabled)
        record = ChatTraceRecord(
            trace_id="t1", endpoint="chat", sanitized_query="q", query_hash="h" * 64,
            answer="a", model="m", status="success",
        )
        ok, code = store.save_run(record)
        self.assertTrue(ok)
        self.assertEqual(code, "")
        self.assertEqual(store.recent(1)[0].trace_id, "t1")


class SupabaseTraceStoreFailClosedTests(unittest.TestCase):
    def test_missing_credentials_disabled(self):
        store = SupabaseTraceStore(url=FAKE_URL, service_role_key="")
        self.assertFalse(store.enabled)
        self.assertEqual(store.disabled_reason, TRACE_SR_MISSING)
        self.assertIsNone(store._client)
        record = ChatTraceRecord(trace_id="t", endpoint="chat", sanitized_query="q",
                                 query_hash="h" * 64, answer="a", model="m",
                                 status="success")
        ok, code = store.save_run(record)
        self.assertFalse(ok)
        self.assertEqual(code, TRACE_SR_MISSING)

    def test_ambiguous_key_disabled(self):
        with mock.patch.dict("os.environ", {"SUPABASE_ANON_KEY": FAKE_SR_KEY}):
            store = SupabaseTraceStore(url=FAKE_URL, service_role_key=FAKE_SR_KEY)
        self.assertFalse(store.enabled)
        self.assertEqual(store.disabled_reason, TRACE_SR_AMBIGUOUS)

    def test_no_url_disabled(self):
        store = SupabaseTraceStore(url="", service_role_key=FAKE_SR_KEY)
        self.assertFalse(store.enabled)
        self.assertEqual(store.disabled_reason, TRACE_SR_MISSING)


class SupabaseTraceStoreWritePathTests(unittest.TestCase):
    """Injects a fake supabase module: verifies real insert calls without a real DB."""

    class FakeResponse:
        def __init__(self, data):
            self.data = data

        def execute(self):
            return self

    class FakeTable:
        def __init__(self, name, parent):
            self.name = name
            self.parent = parent

        def insert(self, payload):
            self.parent.inserts.append((self.name, payload))
            if self.parent.fail_on == self.name:
                raise RuntimeError("simulated db failure")
            if self.name == "rag_runs":
                return SupabaseTraceStoreWritePathTests.FakeResponse([{"id": "run-id-1"}])
            return SupabaseTraceStoreWritePathTests.FakeResponse([])

        def execute(self):
            return self

    class FakeClient:
        def __init__(self, fail_on=None):
            self.inserts = []
            self.fail_on = fail_on

        def table(self, name):
            return SupabaseTraceStoreWritePathTests.FakeTable(name, self)

    @staticmethod
    def _fake_supabase_module(fail_on=None):
        fake_client = SupabaseTraceStoreWritePathTests.FakeClient(fail_on=fail_on)
        module = types.ModuleType("supabase")
        module.create_client = mock.Mock(return_value=fake_client)
        return module, fake_client

    def _store_with_fake_client(self, fail_on=None):
        module, fake_client = self._fake_supabase_module(fail_on=fail_on)
        with mock.patch.dict(sys.modules, {"supabase": module}):
            store = SupabaseTraceStore(url=FAKE_URL, service_role_key=FAKE_SR_KEY)
        return store, fake_client

    def _record(self):
        return ChatTraceRecord(
            trace_id="trace-abc", endpoint="chat",
            sanitized_query="聯絡 <EMAIL> 並看 <URL>",
            query_hash="a" * 64,
            answer="回答提及 <EMAIL>",
            model="gpt-4o-mini",
            status="success",
            user_id="11111111-2222-3333-4444-555555555555",
            conversation_id="c1",
            sources=[{
                "chunk_id": "investment_rules#3", "source": "investment_rules.md",
                "topic": "投資原則", "section": "DCA", "rank": 1, "score": 0.8,
                "content_hash": "abc", "excerpt": "定期定額…", "actually_injected": True,
            }],
            prompt_tokens=10, completion_tokens=5, total_latency_ms=123,
        )

    def test_write_path_calls_rag_runs_and_sources(self):
        store, fake_client = self._store_with_fake_client()
        self.assertTrue(store.enabled)
        ok, code = store.save_run(self._record())
        self.assertTrue(ok, code)
        names = [name for name, _ in fake_client.inserts]
        self.assertEqual(names, ["rag_runs", "rag_run_sources"])
        run_name, run_payload = fake_client.inserts[0]
        self.assertEqual(run_name, "rag_runs")
        self.assertRegex(run_payload["query_hash"], r"^[0-9a-f]{64}$")
        self.assertNotIn(FAKE_SR_KEY, str(run_payload))
        self.assertNotIn("@", run_payload["sanitized_query"])
        self.assertNotIn("@", run_payload["answer"])
        src_name, src_rows = fake_client.inserts[1]
        self.assertEqual(src_name, "rag_run_sources")
        self.assertEqual(src_rows[0]["run_id"], "run-id-1")
        self.assertEqual(src_rows[0]["rank"], 1)
        self.assertTrue(src_rows[0]["actually_injected"])

    def test_run_write_failure_returns_code(self):
        store, _ = self._store_with_fake_client(fail_on="rag_runs")
        ok, code = store.save_run(self._record())
        self.assertFalse(ok)
        self.assertEqual(code, TRACE_RUN_WRITE_FAILED)

    def test_source_write_failure_returns_code(self):
        store, _ = self._store_with_fake_client(fail_on="rag_run_sources")
        ok, code = store.save_run(self._record())
        self.assertFalse(ok)
        self.assertEqual(code, TRACE_SOURCE_WRITE_FAILED)


class RAGTraceServiceTests(unittest.TestCase):
    def _service(self, db_store=None, hmac_secret=TEST_HMAC_SECRET):
        mem = InMemoryTraceStore()
        svc = RAGTraceService(store=mem, db_store=db_store, hmac_secret=hmac_secret)
        return svc, mem

    def test_success_run_with_sources(self):
        svc, mem = self._service()
        run = svc.start_chat_run("比特幣適合長期持有嗎", user_id="u-1")
        run.record_rag(make_rag_result())
        run.finish(answer="可以，但要注意波動，聯絡 support@example.com")
        records = mem.recent(1)
        self.assertEqual(len(records), 1)
        r = records[0]
        self.assertEqual(r.status, "success")
        self.assertEqual(r.endpoint, "chat")
        self.assertEqual(r.user_id, "u-1")
        self.assertEqual(r.sanitized_query, "比特幣適合長期持有嗎")
        self.assertRegex(r.query_hash, r"^[0-9a-f]{64}$")
        self.assertNotIn("@", r.answer)
        self.assertEqual(len(r.sources), 2)
        self.assertEqual([s["rank"] for s in r.sources], [1, 2])
        self.assertEqual([s["actually_injected"] for s in r.sources], [True, False])
        self.assertNotIn("@", r.sources[0]["excerpt"])
        self.assertEqual(r.route, "deep")
        self.assertFalse(r.fallback)
        self.assertEqual(r.prompt_tokens, 0)

    def test_empty_context_is_degraded(self):
        svc, mem = self._service()
        run = svc.start_chat_run("問題")
        metrics = {"fallback_reason": "", "empty_context": True, "route_type": "fast"}
        run.record_rag(make_rag_result(metrics=metrics))
        run.finish(answer="回答")
        r = mem.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)
        self.assertTrue(r.empty_context)

    def test_fallback_reason_is_degraded(self):
        svc, mem = self._service()
        run = svc.start_chat_run("問題")
        metrics = {"fallback_reason": "retrieval_error: boom", "empty_context": False}
        run.record_rag(make_rag_result(metrics=metrics))
        run.finish(answer="回答")
        r = mem.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        # 只保存 allowlist 代碼，不保存冒號後的 provider exception
        self.assertEqual(r.fallback_reason, "retrieval_error")

    def test_fallback_reason_unknown_code_becomes_rag_fallback(self):
        svc, mem = self._service()
        run = svc.start_chat_run("問題")
        metrics = {"fallback_reason": "weird_reason: raw text", "empty_context": False}
        run.record_rag(make_rag_result(metrics=metrics))
        run.finish(answer="回答")
        r = mem.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        self.assertEqual(r.fallback_reason, "rag_fallback")

    def test_rag_error_marks_degraded(self):
        svc, mem = self._service()
        run = svc.start_chat_run("問題")
        run.note_rag_error()
        run.finish(answer="回答")
        r = mem.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)

    def test_error_status_only_fixed_code(self):
        svc, mem = self._service()
        run = svc.start_chat_run("問題")
        # 任意 error 字串（含 provider exception text）不得原樣保存
        run.finish(answer="", error="boom " + "x" * 600)
        r = mem.recent(1)[0]
        self.assertEqual(r.status, "error")
        self.assertEqual(r.error, "ai_chat_error")

    def test_error_allowed_code_passthrough(self):
        svc, mem = self._service()
        run = svc.start_chat_run("問題")
        run.finish(answer="", error="ai_chat_error")
        self.assertEqual(mem.recent(1)[0].error, "ai_chat_error")

    def test_demo_user_stays_null(self):
        svc, mem = self._service()
        run = svc.start_chat_run("問題", user_id=None)
        run.finish(answer="回答")
        self.assertIsNone(mem.recent(1)[0].user_id)

    def test_user_linkage_isolation(self):
        svc, mem = self._service()
        svc.start_chat_run("問題", user_id="user-a").finish(answer="a")
        svc.start_chat_run("問題", user_id="user-b").finish(answer="b")
        svc.start_chat_run("問題", user_id=None).finish(answer="c")
        records = mem.recent(3)
        self.assertEqual([r.user_id for r in records], ["user-a", "user-b", None])

    def test_db_store_skipped_when_hmac_secret_missing(self):
        calls = []

        class SpyStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                calls.append(record)
                return True, ""

        spy = SpyStore()
        svc, mem = self._service(db_store=spy, hmac_secret="")
        run = svc.start_chat_run("問題")
        self.assertIsNone(run.query_hash)
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            run.finish(answer="回答")
        self.assertEqual(calls, [])
        self.assertTrue(any(TRACE_HMAC_SECRET_MISSING in line for line in cm.output))
        self.assertEqual(len(mem.recent(1)), 1)

    def test_db_store_failure_does_not_raise(self):
        class FailingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                return False, TRACE_RUN_WRITE_FAILED

        svc, mem = self._service(db_store=FailingStore())
        run = svc.start_chat_run("問題")
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            run.finish(answer="回答")
        self.assertTrue(any(TRACE_RUN_WRITE_FAILED in line for line in cm.output))
        self.assertEqual(len(mem.recent(1)), 1)

    def test_db_store_exception_does_not_raise(self):
        class RaisingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                raise RuntimeError("store exploded")

        svc, mem = self._service(db_store=RaisingStore())
        run = svc.start_chat_run("問題")
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            run.finish(answer="回答")
        self.assertTrue(any("trace_store_error" in line for line in cm.output))
        self.assertEqual(len(mem.recent(1)), 1)

    def test_disabled_db_store_warns_once(self):
        class DisabledStore:
            enabled = False
            disabled_reason = TRACE_SR_MISSING

            def save_run(self, record):
                raise AssertionError("disabled store must not be called")

        svc, mem = self._service(db_store=DisabledStore())
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            svc.start_chat_run("問題").finish(answer="回答")
            svc.start_chat_run("問題").finish(answer="回答")
        hits = [l for l in cm.output if TRACE_SR_MISSING in l]
        self.assertEqual(len(hits), 1)
        self.assertEqual(len(mem.recent(2)), 2)

    def test_double_finish_is_ignored(self):
        svc, mem = self._service()
        run = svc.start_chat_run("問題")
        run.finish(answer="第一次")
        run.finish(answer="第二次")
        self.assertEqual(len(mem.recent(2)), 1)

    def test_logs_contain_no_query_answer_or_secret(self):
        svc, mem = self._service(db_store=SupabaseTraceStore(url="", service_role_key=""))
        query = "查詢 0x1234567890abcdef1234567890abcdef12345678 是否安全"
        run = svc.start_chat_run(query, user_id="u-1")
        run.record_rag(make_rag_result())
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            run.finish(answer="結論：謹慎，聯絡 0912-345-678")
        for line in cm.output:
            self.assertNotIn("0x1234", line)
            self.assertNotIn("0912-345-678", line)
            self.assertNotIn(TEST_HMAC_SECRET, line)
            self.assertNotIn(FAKE_SR_KEY, line)
        r = mem.recent(1)[0]
        self.assertNotIn("0x1234", r.sanitized_query)
        self.assertNotIn("0912-345-678", r.answer)


class SanitizerSecretPatternTests(unittest.TestCase):
    """Codex 反例：姓名、身分證、護照、JWT、API key/token、私鑰、PEM、助記詞。"""

    def test_jwt_masked(self):
        token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-abcdef"
        self.assertEqual(sanitize_text(token), "<JWT>")

    def test_api_keys_masked(self):
        self.assertEqual(sanitize_text("key=sk-abcdefghijklmnop1234"), "key=<API_KEY>")
        self.assertIn("<API_KEY>", sanitize_text("AKIAIOSFODNN7EXAMPLE"))
        self.assertIn("<API_KEY>", sanitize_text("用 xoxb-123456789012-abcdefghijk"))
        self.assertIn("<API_KEY>", sanitize_text("ghp_abcdefghijklmnopqrstuvwxyz"))

    def test_bearer_token_masked(self):
        self.assertEqual(
            sanitize_text("Authorization: Bearer abcdefghijklmnop1234"),
            "Authorization: <TOKEN>")

    def test_64hex_private_key_masked(self):
        key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        self.assertEqual(sanitize_text(key), "<PRIVATE_KEY>")

    def test_pem_private_key_masked(self):
        pem = (
            "-----BEGIN PRIVATE KEY-----\n"
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n"
            "-----END PRIVATE KEY-----"
        )
        self.assertEqual(sanitize_text(pem), "<PRIVATE_KEY>")

    def test_labeled_mnemonic_masked(self):
        bip39 = ("abandon ability able about above absent absorb abstract absurd abuse "
                 "access accident account accuse achieve acid acoustic acquire across act "
                 "action actor actress actual adapt add addict address adjust admit adult "
                 "advance advice aerobic affair afford afraid")
        words12 = " ".join(bip39.split()[:12])
        words24 = " ".join(bip39.split()[:24])
        self.assertEqual(sanitize_text("助記詞: " + words12), "<MNEMONIC>")
        self.assertEqual(sanitize_text("seed phrase " + words24), "<MNEMONIC>")

    def test_taiwan_id_masked(self):
        self.assertEqual(sanitize_text("身分證 A123456789 請查"), "身分證 <ID_NUMBER> 請查")

    def test_labeled_passport_masked(self):
        self.assertEqual(
            sanitize_text("護照號碼 312345678 請查"), "<ID_NUMBER> 請查")

    def test_labeled_name_masked(self):
        self.assertEqual(sanitize_text("姓名: 王小明 請查"), "<NAME> 請查")


class WeakHmacSecretTests(unittest.TestCase):
    def test_short_secret_fails_closed(self):
        calls = []

        class SpyStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                calls.append(record)
                return True, ""

        spy = SpyStore()
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            svc = RAGTraceService(
                store=InMemoryTraceStore(), db_store=spy, hmac_secret="too-short")
        self.assertTrue(any("trace_hmac_secret_weak" in line for line in cm.output))
        run = svc.start_chat_run("問題")
        self.assertIsNone(run.query_hash)
        run.finish(answer="回答")
        self.assertEqual(calls, [])

    def test_32_byte_secret_accepted(self):
        svc = RAGTraceService(store=InMemoryTraceStore(), hmac_secret="x" * 32)
        run = svc.start_chat_run("問題")
        self.assertRegex(run.query_hash, r"^[0-9a-f]{64}$")


class SourcePayloadValidationTests(unittest.TestCase):
    def test_invalid_sources_skipped(self):
        record = ChatTraceRecord(
            trace_id="t", endpoint="chat", sanitized_query="q", query_hash="h" * 64,
            answer="a", model="m", status="success",
            sources=[
                {"source": "ok.md", "excerpt": "內容", "rank": 1},
                {"source": "", "excerpt": "內容", "rank": 2},        # 空 source → skip
                {"source": "bad.md", "excerpt": "   ", "rank": 3},   # 空 excerpt → skip
                {"source": "r0.md", "excerpt": "內容", "rank": 0},   # rank 修正
            ],
        )
        rows = record.to_source_payloads("run-1")
        self.assertEqual(len(rows), 2)
        self.assertEqual([r["source"] for r in rows], ["ok.md", "r0.md"])
        self.assertEqual([r["rank"] for r in rows], [1, 2])


class PrimaryStoreIsolationTests(unittest.TestCase):
    def test_primary_store_raise_isolated(self):
        class RaisingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                raise RuntimeError("primary store exploded")

        svc = RAGTraceService(store=RaisingStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            run = svc.start_chat_run("問題")
            run.record_rag(make_rag_result())
            run.finish(answer="回答")  # 不得 raise
        self.assertTrue(any("trace_store_error" in line for line in cm.output))

    def test_start_and_finish_never_raise_even_with_broken_store(self):
        class BrokenStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                raise RuntimeError("boom")

        svc = RAGTraceService(store=BrokenStore(), db_store=BrokenStore(),
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_chat_run("問題")
        run.finish(answer="回答")


class CompensationTests(unittest.TestCase):
    """Source insert failure / missing run id → cleanup scoped to THIS trace only."""

    class FakeDeleteQuery:
        def __init__(self, client, name):
            self._client = client
            self._name = name
            self._filters = {}

        def eq(self, column, value):
            self._filters[column] = value
            return self

        def execute(self):
            self._client.deletes.append((self._name, dict(self._filters)))
            # 模擬實際刪除：移除符合條件的 run
            to_remove = []
            for trace_id, run_id in list(self._client.runs.items()):
                if self._filters.get("trace_id") and trace_id != self._filters["trace_id"]:
                    continue
                if self._filters.get("id") and run_id != self._filters["id"]:
                    continue
                to_remove.append(trace_id)
            for trace_id in to_remove:
                self._client.runs.pop(trace_id, None)
            return self

    class FakeTable:
        def __init__(self, name, client):
            self._name = name
            self._client = client

        def insert(self, payload):
            self._client.inserts.append((self._name, payload))
            if self._client.fail_on == self._name:
                raise RuntimeError("simulated db failure")
            if self._name == "rag_runs":
                if not self._client.run_insert_returns_id:
                    return CompensationTests.FakeResponse([])
                self._client.runs[payload["trace_id"]] = "run-id-1"
                return CompensationTests.FakeResponse([{"id": "run-id-1"}])
            return CompensationTests.FakeResponse([])

        def delete(self):
            return CompensationTests.FakeDeleteQuery(self._client, self._name)

        def execute(self):
            return self

    class FakeResponse:
        def __init__(self, data):
            self.data = data

        def execute(self):
            return self

    class FakeClient:
        def __init__(self, fail_on=None, run_insert_returns_id=True,
                     fail_delete=False):
            self.inserts = []
            self.deletes = []
            self.runs = {}
            self.fail_on = fail_on
            self.run_insert_returns_id = run_insert_returns_id
            self.fail_delete = fail_delete

        def table(self, name):
            if self.fail_delete and name == "rag_runs":
                table = CompensationTests.FakeTable(name, self)
                original_delete = table.delete

                def broken_delete():
                    raise RuntimeError("delete failed")
                table.delete = broken_delete
                return table
            return CompensationTests.FakeTable(name, self)

    @staticmethod
    def _fake_supabase_module(fail_on=None, run_insert_returns_id=True,
                              fail_delete=False):
        client = CompensationTests.FakeClient(
            fail_on=fail_on, run_insert_returns_id=run_insert_returns_id,
            fail_delete=fail_delete)
        module = types.ModuleType("supabase")
        module.create_client = mock.Mock(return_value=client)
        return module, client

    def _store(self, **kwargs):
        module, client = self._fake_supabase_module(**kwargs)
        with mock.patch.dict(sys.modules, {"supabase": module}):
            store = SupabaseTraceStore(url=FAKE_URL, service_role_key=FAKE_SR_KEY)
        return store, client

    def _record(self, trace_id="trace-abc"):
        return ChatTraceRecord(
            trace_id=trace_id, endpoint="chat", sanitized_query="q",
            query_hash="a" * 64, answer="a", model="m", status="success",
            sources=[{"source": "ok.md", "excerpt": "內容", "rank": 1}],
        )

    def test_source_failure_cleans_only_this_run(self):
        store, client = self._store(fail_on="rag_run_sources")
        # 另一個已存在的 run 不得被誤刪
        client.runs["other-trace"] = "other-run-id"

        ok, code = store.save_run(self._record())
        self.assertFalse(ok)
        self.assertEqual(code, TRACE_SOURCE_WRITE_FAILED)
        self.assertEqual(
            client.deletes,
            [("rag_runs", {"id": "run-id-1", "trace_id": "trace-abc"})])
        # 本次 run 已清除；其他 run 保留
        self.assertNotIn("trace-abc", client.runs)
        self.assertEqual(client.runs, {"other-trace": "other-run-id"})

    def test_missing_run_id_cleans_by_trace(self):
        store, client = self._store(run_insert_returns_id=False)
        ok, code = store.save_run(self._record())
        self.assertFalse(ok)
        self.assertEqual(code, TRACE_RUN_ID_MISSING)
        self.assertEqual(client.deletes, [("rag_runs", {"trace_id": "trace-abc"})])
        self.assertNotIn("trace-abc", client.runs)

    def test_cleanup_failure_still_returns_source_code(self):
        store, client = self._store(fail_on="rag_run_sources", fail_delete=True)
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            ok, code = store.save_run(self._record())
        self.assertFalse(ok)
        self.assertEqual(code, TRACE_SOURCE_WRITE_FAILED)
        self.assertTrue(any("trace_cleanup_failed" in line for line in cm.output))


class RealRAGServiceFallbackTests(unittest.TestCase):
    """使用真實 RAGService.augment_chat() 驗證降級 metrics（Codex 反例）。"""

    def _trace_with(self, rag_result):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_chat_run("比特幣適合長期持有嗎")
        run.record_rag(rag_result)
        run.finish(answer="回答")
        return svc, run

    def test_kb_unavailable_is_degraded(self):
        from services.rag_service import RAGService
        rag = RAGService()
        with mock.patch.object(RAGService, "kb_loaded",
                               new_callable=mock.PropertyMock, return_value=False):
            result = rag.augment_chat("比特幣適合長期持有嗎", "穩健型")
        self.assertEqual(result["metrics_record"].get("fallback_reason"), "kb_unavailable")
        self.assertTrue(result["metrics_record"].get("empty_context"))
        svc, run = self._trace_with(result)
        record = svc._store.recent(1)[0]
        self.assertEqual(record.status, "degraded")
        self.assertTrue(record.fallback)
        self.assertEqual(record.fallback_reason, "kb_unavailable")

    def test_retrieval_exception_is_degraded_with_fixed_code(self):
        from services.rag_service import RAGService
        rag = RAGService()
        rag._retrieve_for_endpoint = mock.Mock(
            side_effect=RuntimeError("secret-provider-error"))
        result = rag.augment_chat("比特幣適合長期持有嗎", "穩健型")
        self.assertEqual(result["metrics_record"].get("fallback_reason"), "retrieval_error")
        svc, run = self._trace_with(result)
        record = svc._store.recent(1)[0]
        self.assertEqual(record.status, "degraded")
        self.assertEqual(record.fallback_reason, "retrieval_error")

    def test_empty_context_is_degraded(self):
        from services.rag_service import RAGService
        rag = RAGService()
        rag._retrieve_for_endpoint = mock.Mock(return_value={
            "results": [], "meta": {},
            "metrics_record": {"empty_context": True, "fallback_reason": "",
                               "route_type": "fast"},
        })
        result = rag.augment_chat("比特幣適合長期持有嗎", "穩健型")
        svc, run = self._trace_with(result)
        record = svc._store.recent(1)[0]
        self.assertEqual(record.status, "degraded")
        self.assertTrue(record.empty_context)

    def test_normal_retrieval_is_success_with_citations(self):
        from services.rag_service import RAGService
        from services.retrieval_service import RetrievalResult
        rag = RAGService()
        rag._retrieve_for_endpoint = mock.Mock(return_value={
            "results": [
                RetrievalResult(snippet="定期定額是長期投資的基礎", source="investment_rules.md",
                                topic="投資原則", score=0.8,
                                metadata={"chunk_id": "investment_rules#3", "section": "DCA"}),
            ],
            "meta": {"method": "hybrid"},
            "metrics_record": {"route_type": "deep", "fallback_reason": "",
                               "empty_context": False, "retrieval_latency_ms": 10.0},
        })
        result = rag.augment_chat("比特幣適合長期持有嗎", "穩健型")
        self.assertTrue(result["citations"])
        svc, run = self._trace_with(result)
        record = svc._store.recent(1)[0]
        self.assertEqual(record.status, "success")
        self.assertFalse(record.fallback)
        self.assertEqual(len(record.sources), 1)
        self.assertTrue(record.sources[0]["actually_injected"])


class LegacyMetricsPrivacyTests(unittest.TestCase):
    """legacy RAG metrics / JSONL 不得落 raw query（Codex 反例）。"""

    def test_build_record_sanitizes_query(self):
        from services import rag_metrics_service
        svc = rag_metrics_service.RAGMetricsService(enabled=True)
        record = svc.build_record(
            endpoint="chat",
            query="用 sk-abcdefghijklmnop1234 與 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 操作",
        )
        self.assertIn("<API_KEY>", record["query"])
        self.assertIn("<PRIVATE_KEY>", record["query"])
        self.assertNotIn("sk-abcdefghijklmnop1234", record["query"])

    def test_log_call_jsonl_contains_no_raw_query(self):
        import tempfile
        from services import rag_metrics_service
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(rag_metrics_service, "METRICS_DIR", Path(tmp)), \
                 mock.patch.object(rag_metrics_service, "METRICS_FILE", Path(tmp) / "m.jsonl"):
                svc = rag_metrics_service.RAGMetricsService(enabled=True)
                svc.log_call(svc.build_record(
                    endpoint="chat",
                    query="JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-abcdef 請分析",
                ))
                content = (Path(tmp) / "m.jsonl").read_text(encoding="utf-8")
        self.assertIn("<JWT>", content)
        self.assertNotIn("eyJhbGciOiJIUzI1NiJ9", content)


class RewriteFallbackTraceTests(unittest.TestCase):
    """Codex R2 blocker：deep route rewrite exception 後 retrieval 成功 → 必須 degraded（rewrite_error）。
    修正前此測試會重現誤記 success（fallback_reason 為空）。"""

    FAKE_TOKEN = "sk-fake-secret-token-0123456789abcdef"
    DEEP_QUERY = "比特幣？以太幣？"

    def _capture_logs(self, logger_names):
        handler = logging.Handler()
        records = []
        handler.emit = lambda record: records.append(record)
        loggers = [logging.getLogger(n) for n in logger_names]
        for lg in loggers:
            lg.addHandler(handler)
        return handler, records, loggers

    def test_rewrite_exception_with_successful_retrieval_is_degraded(self):
        from services.prompt_builder import PromptBuilder
        from services.query_rewrite_service import QueryRewriteService
        from services.rag_service import RAGService

        rag = RAGService()
        handler, records, loggers = self._capture_logs(
            ["services.rag_service", "services.rag_trace_service"])
        try:
            with mock.patch.object(
                QueryRewriteService, "rewrite",
                side_effect=RuntimeError("rewriter crashed token=" + self.FAKE_TOKEN),
            ):
                # 真實 pipeline：real router → rewriter(raise) → real retrieval
                pipe = rag._retrieve_for_endpoint(
                    self.DEEP_QUERY, "chat", topics=None, max_results=3)
        finally:
            for lg in loggers:
                lg.removeHandler(handler)

        # 前置條件：router deep、rewrite exception 後 retrieval 仍成功
        self.assertEqual(pipe["route_decision"].route, "deep")
        self.assertGreaterEqual(len(pipe["results"]), 1)
        metrics = pipe["metrics_record"]
        self.assertEqual(metrics.get("fallback_reason"), "rewrite_error")

        # 組出 augment_chat 同型態結果，走真實 trace 流程
        prompt = PromptBuilder().build_chat_prompt(
            user_message=self.DEEP_QUERY,
            risk_profile="穩健型",
            retrieval_results=pipe["results"],
            retrieval_meta=pipe["meta"],
        )
        rag_result = {
            **prompt,
            "retrieval_results": pipe["results"],
            "metrics_record": metrics,
        }
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_chat_run(self.DEEP_QUERY)
        run.record_rag(rag_result)
        run.finish(answer="測試回答")

        record = svc._store.recent(1)[0]
        self.assertEqual(record.status, "degraded")
        self.assertTrue(record.fallback)
        self.assertEqual(record.fallback_reason, "rewrite_error")
        # retrieval source / citation 保留
        self.assertGreaterEqual(len(record.sources), 1)
        self.assertTrue(rag_result["citations"])
        # fake token / exception text 不得出現在 persisted payload 或 log
        payload = json.dumps(record.to_run_payload(), ensure_ascii=False)
        src_payload = json.dumps(record.to_source_payloads("run-1"), ensure_ascii=False)
        self.assertNotIn(self.FAKE_TOKEN, payload)
        self.assertNotIn(self.FAKE_TOKEN, src_payload)
        for rec in records:
            self.assertNotIn(self.FAKE_TOKEN, rec.getMessage())


class EndpointGeneralizationTests(unittest.TestCase):
    """TASK 03：start_run allowlist fail-closed、llm 代碼、safe_citations。"""

    def test_start_run_unknown_endpoint_rejected(self):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        with self.assertLogs("services.rag_trace_service", level="WARNING") as cm:
            run = svc.start_run("trading", "問題")
        self.assertIsNone(run)
        self.assertTrue(any("trace_endpoint_rejected" in line for line in cm.output))

    def test_start_run_allowed_endpoints(self):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        for endpoint in ["chat", "agent", "scam", "podcast", "health"]:
            run = svc.start_run(endpoint, "問題")
            self.assertIsNotNone(run)
            self.assertEqual(run.endpoint, endpoint)
            run.finish(answer="回答")
        records = svc._store.recent(5)
        self.assertEqual([r.endpoint for r in records],
                         ["chat", "agent", "scam", "podcast", "health"])

    def test_start_chat_run_still_works(self):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_chat_run("問題")
        self.assertEqual(run.endpoint, "chat")

    def test_llm_unavailable_note_marks_degraded(self):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_run("agent", "任務")
        run.note_llm_unavailable()
        run.finish(answer="fallback 回答")
        r = svc._store.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)
        self.assertEqual(r.fallback_reason, "llm_unavailable")

    def test_llm_error_code_allowed(self):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_run("scam", "內容")
        run.finish(answer="", error="llm_error")
        r = svc._store.recent(1)[0]
        self.assertEqual(r.status, "error")
        self.assertEqual(r.error, "llm_error")

    def test_safe_citations_only_injected_and_no_absolute_path(self):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_run("agent", "任務")
        run.record_rag({
            "citations": [], "confidence": "high", "injected_count": 1,
            "retrieval_results": [
                make_source("第一段", source="/abs/path/knowledge/investment_rules.md",
                            chunk_id="investment_rules#3", section="DCA"),
                make_source("第二段", source="data/knowledge/coin_profiles.json",
                            topic="市場敘事", chunk_id="coin_profiles#0",
                            section="BTC", score=0.5),
            ],
            "metrics_record": {"fallback_reason": "", "empty_context": False},
        })
        citations = run.safe_citations()
        self.assertEqual(len(citations), 1)
        self.assertEqual(citations[0]["chunk_id"], "investment_rules#3")
        self.assertEqual(citations[0]["source"], "investment_rules.md")
        self.assertEqual(citations[0]["section"], "DCA")
        self.assertEqual(citations[0]["topic"], "投資原則")
        # 未注入的第二筆不得出現
        self.assertNotIn("coin_profiles", [c["source"] for c in citations])


class RagErrorCodeTests(unittest.TestCase):
    """Codex R1 blocker 1：note_rag_error 必須留下固定 fallback_reason=rag_error。"""

    def test_rag_error_alone_gets_rag_error_code(self):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_run("agent", "任務")
        run.note_rag_error()
        run.finish(answer="回答")
        r = svc._store.recent(1)[0]
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)
        self.assertEqual(r.fallback_reason, "rag_error")

    def test_specific_reason_not_overridden_by_rag_error(self):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_run("scam", "內容")
        run.record_rag(make_rag_result(metrics={
            "fallback_reason": "retrieval_error", "empty_context": False}))
        run.note_rag_error()
        run.finish(answer="回答")
        r = svc._store.recent(1)[0]
        self.assertEqual(r.fallback_reason, "retrieval_error")


class CitationSanitizerTests(unittest.TestCase):
    """Codex R1 blocker 3：citation 全部公開欄位防禦性清理。"""

    def _citations_for(self, sources):
        svc = RAGTraceService(store=InMemoryTraceStore(), db_store=None,
                              hmac_secret=TEST_HMAC_SECRET)
        run = svc.start_run("agent", "任務")
        run.record_rag({
            "citations": [], "confidence": None, "injected_count": len(sources),
            "retrieval_results": sources,
            "metrics_record": {"fallback_reason": "", "empty_context": False},
        })
        return run.safe_citations()

    def test_posix_chunk_id_basename_with_rank(self):
        citations = self._citations_for([
            make_source("s", source="/srv/private/knowledge/doc.md",
                        chunk_id="/srv/private/doc#1", section="/srv/private/section",
                        topic="/srv/private/topic"),
        ])
        c = citations[0]
        self.assertEqual(c["chunk_id"], "doc#1")
        self.assertEqual(c["source"], "doc.md")
        self.assertEqual(c["section"], "section")
        self.assertEqual(c["topic"], "topic")

    def test_windows_paths_cleaned(self):
        citations = self._citations_for([
            make_source("s", source="C:\\private\\knowledge\\doc.md",
                        chunk_id="C:\\private\\doc.md#2", section="C:\\private\\sec",
                        topic="C:\\private\\top"),
        ])
        c = citations[0]
        self.assertEqual(c["chunk_id"], "doc.md#2")
        self.assertEqual(c["source"], "doc.md")
        self.assertEqual(c["section"], "sec")
        self.assertEqual(c["topic"], "top")

    def test_control_chars_removed(self):
        citations = self._citations_for([
            make_source("s", source="doc.md", chunk_id="c#1",
                        section="a\r\nb\tc", topic="正常主題"),
        ])
        self.assertEqual(citations[0]["section"], "abc")

    def test_secret_in_citation_fields_masked(self):
        citations = self._citations_for([
            make_source("s", source="doc.md", chunk_id="c#1",
                        section="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-abcdef",
                        topic="sk-abcdefghijklmnop1234"),
        ])
        c = citations[0]
        self.assertIn("<JWT>", c["section"])
        self.assertIn("<API_KEY>", c["topic"])
        self.assertNotIn("eyJ", c["section"])
        self.assertNotIn("sk-abcdefghijklmnop1234", c["topic"])

    def test_normal_citation_fields_and_order_preserved(self):
        citations = self._citations_for([
            make_source("s", source="data/knowledge/investment_rules.md",
                        chunk_id="investment_rules#3", section="DCA",
                        topic="投資原則"),
        ])
        self.assertEqual(list(citations[0].keys()),
                         ["chunk_id", "source", "section", "topic"])
        self.assertEqual(citations[0]["chunk_id"], "investment_rules#3")
        self.assertEqual(citations[0]["source"], "investment_rules.md")
        self.assertEqual(citations[0]["section"], "DCA")
        self.assertEqual(citations[0]["topic"], "投資原則")


if __name__ == "__main__":
    unittest.main()
