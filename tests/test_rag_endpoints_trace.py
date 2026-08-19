"""
TASK 03 — 其餘 RAG endpoints（agent / scam / podcast / health）trace 接線測試。

使用 Flask test client 與注入 fakes（無真實 OpenAI key、無真實 Supabase、
無網路）；每 endpoint 覆蓋：成功、empty context、store failure、LLM/RAG
exception 固定代碼、缺 key 降級、Auth/validation 不建立 trace、metadata 不污染、
citation 只含 injected 且無絕對路徑、podcast canonical/alias 各一筆 trace。
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

from services.rag_trace_service import InMemoryTraceStore, RAGTraceService  # noqa: E402

DEMO_TOKEN = "smartinvest-demo-member-token"
REAL_TOKEN_A = "valid-token-a"
USER_A = "11111111-2222-3333-4444-555555555555"
TEST_HMAC_SECRET = "test-hmac-secret-not-real-0123456789abcdef"


def make_source(snippet, source="data/knowledge/investment_rules.md",
                topic="投資原則", score=0.8, chunk_id="investment_rules#3",
                section="DCA"):
    return types.SimpleNamespace(
        snippet=snippet, source=source, topic=topic, score=score,
        metadata={"chunk_id": chunk_id, "section": section})


DEFAULT_METRICS = {
    "route_type": "deep", "fallback_reason": "", "empty_context": False,
    "retrieval_latency_ms": 10.0,
}


class FakeRAG:
    """Per-endpoint configurable augment results."""

    def __init__(self):
        self.results = [make_source("定期定額是長期投資的基礎"),
                        make_source("比特幣波動高", source="data/knowledge/coin_profiles.json",
                                    topic="市場敘事", score=0.5,
                                    chunk_id="coin_profiles#0", section="BTC")]
        self.injected_count = 1
        self.metrics = dict(DEFAULT_METRICS)
        self.context = None
        self.raise_error = False
        self.confidence = "high"

    def _base(self):
        if self.raise_error:
            raise RuntimeError("rag exploded with token=sk-fake-rag-secret")
        return {
            "retrieval_results": self.results,
            "metrics_record": dict(self.metrics),
            "injected_count": self.injected_count,
            "citations": ["知識庫: investment_rules.md (投資原則)"],
            "confidence": self.confidence,
        }

    def augment_agent(self, goal, profile, budget):
        out = self._base()
        out["context"] = self.context if self.context is not None else ["- [投資原則] 定期定額…"]
        return out

    def augment_scam(self, text):
        out = self._base()
        out["rag_snippets"] = ["[投資原則] 詐騙模式補充…"]
        return out

    def augment_podcast(self, topic, market_context=None):
        out = self._base()
        out["context"] = self.context if self.context is not None else ["- [Podcast風格] 開場…"]
        return out

    def augment_health(self, risk_health, holdings_text):
        out = self._base()
        out["context"] = self.context if self.context is not None else ["- [健康度檢查] 集中度…"]
        return out


class FakeAuth:
    USERS = {REAL_TOKEN_A: USER_A}

    def get_user(self, token):
        uid = self.USERS.get(token)
        if not uid:
            raise RuntimeError("invalid token")
        return types.SimpleNamespace(
            user=types.SimpleNamespace(id=uid, email="user@example.com"))


class FakeDB:
    def __init__(self):
        self.client = types.SimpleNamespace(auth=FakeAuth())


class FakeLLM:
    def __init__(self, create_error=None, parse_error=None):
        self._create_error = create_error
        self._parse_error = parse_error

        def create(**kwargs):
            if self._create_error:
                raise self._create_error
            content = json.dumps({
                "summary": "AI 整理的行動計畫", "steps": ["步驟1", "步驟2"],
                "risks": ["風險1"], "next_action": "下一步",
                "allocation": [{"symbol": "BTC", "weight": 0.4, "amount_usd": 40000}],
            }, ensure_ascii=False)
            return types.SimpleNamespace(choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(content=content, tool_calls=[]))])

        def parse(**kwargs):
            if self._parse_error:
                raise self._parse_error
            response_format = kwargs.get("response_format")
            if response_format.__name__ == "ScamScanResult":
                parsed = types.SimpleNamespace(risk_level="medium", report="測試風險報告")
            elif response_format.__name__ == "PodcastLLMOut":
                line = types.SimpleNamespace(
                    speaker="主持人", text="早安，歡迎收聽。",
                    model_dump=lambda: {"speaker": "主持人", "text": "早安，歡迎收聽。"})
                parsed = types.SimpleNamespace(
                    title="今日市場晨報", bullets=["重點1", "重點2", "重點3"],
                    lines=[line] * 14)
            else:
                parsed = types.SimpleNamespace(
                    narrative="白話配置分析", highlights=["集中度偏高"])
            return types.SimpleNamespace(choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(parsed=parsed))])

        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))
        self.beta = types.SimpleNamespace(
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(parse=parse)))


class BaseEndpointTraceTest(unittest.TestCase):
    def setUp(self):
        self.mem = InMemoryTraceStore()
        self.trace_svc = RAGTraceService(
            store=self.mem, db_store=None, hmac_secret=TEST_HMAC_SECRET)
        self.fake_llm = FakeLLM()
        self.fake_rag = FakeRAG()
        self.patchers = [
            mock.patch.object(app_module, "_trace", self.trace_svc),
            mock.patch.object(app_module, "client", self.fake_llm),
            mock.patch.object(app_module, "refresh_openai_client",
                              lambda: self.fake_llm),
            mock.patch.object(app_module, "_rag", self.fake_rag),
            mock.patch.object(app_module, "_rag_available", True),
            mock.patch.object(app_module, "db", FakeDB()),
            mock.patch.object(app_module, "calculate_portfolio_risk_health",
                              lambda req: {
                                  "top1_weight": 0.62, "annual_vol": 0.55,
                                  "max_drawdown": 0.31}),
        ]
        for p in self.patchers:
            p.start()
        app_module.app.config["TESTING"] = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        for p in self.patchers:
            p.stop()

    def _post(self, path, payload, token=None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return self.client.post(path, json=payload, headers=headers)

    def _last(self):
        return self.mem.recent(1)[0]


class AgentPlanTraceTests(BaseEndpointTraceTest):
    PAYLOAD = {"goal": "幫我規劃比特幣投資", "profile": "穩健型", "budget": "100000"}

    def test_success_trace_and_contract(self):
        resp = self._post("/api/agent-plan", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for key in ["summary", "steps", "risks", "next_action", "allocation"]:
            self.assertIn(key, data)
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")
        self.assertIsInstance(data["citations"], list)
        self.assertEqual(data["confidence"], "high")
        r = self._last()
        self.assertEqual(r.endpoint, "agent")
        self.assertEqual(r.user_id, USER_A)
        self.assertEqual(r.status, "success")
        self.assertEqual(len(r.sources), 2)
        # answer snapshot = 實際 business response（排除 trace metadata）
        answer = json.loads(r.answer)
        self.assertEqual(answer["summary"], "AI 整理的行動計畫")
        for key in ["summary", "steps", "risks", "next_action", "allocation"]:
            self.assertEqual(answer[key], data[key])
        self.assertEqual(
            set(answer.keys()),
            {"summary", "steps", "risks", "next_action", "allocation"})

    def test_empty_context_degraded(self):
        self.fake_rag.context = []
        self.fake_rag.metrics = {"fallback_reason": "", "empty_context": True,
                                 "route_type": "fast"}
        resp = self._post("/api/agent-plan", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("summary", data)
        r = self._last()
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)

    def test_store_failure_response_unchanged(self):
        class RaisingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                raise RuntimeError("store exploded")

        app_module._trace = RAGTraceService(
            store=RaisingStore(), db_store=None, hmac_secret=TEST_HMAC_SECRET)
        resp = self._post("/api/agent-plan", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["summary"], "AI 整理的行動計畫")
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")

    def test_llm_exception_fixed_code_no_leak(self):
        app_module.client = FakeLLM(create_error=RuntimeError("provider token=sk-leak-1234567890123456"))
        resp = self._post("/api/agent-plan", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("summary", data)  # fallback plan
        self.assertNotIn("debug", data)  # 不再回傳 str(e)
        self.assertNotIn("sk-leak", json.dumps(data, ensure_ascii=False))
        r = self._last()
        self.assertEqual(r.status, "error")
        self.assertEqual(r.error, "llm_error")

    def test_missing_key_degraded_llm_unavailable(self):
        app_module.client = None
        resp = self._post("/api/agent-plan", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("summary", data)
        r = self._last()
        self.assertEqual(r.status, "degraded")
        self.assertEqual(r.fallback_reason, "llm_unavailable")

    def test_empty_goal_no_trace(self):
        resp = self._post("/api/agent-plan", {"goal": ""}, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self.mem.recent(10), [])

    def test_unauth_no_trace(self):
        resp = self._post("/api/agent-plan", self.PAYLOAD)
        self.assertEqual(resp.status_code, 401)
        self.assertEqual(self.mem.recent(10), [])


class ScamScanTraceTests(BaseEndpointTraceTest):
    PAYLOAD = {"text": "這個項目保證每天 10% 收益"}

    def test_success_anonymous_user_null(self):
        resp = self._post("/api/scam-scan", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["risk_level"], "medium")
        self.assertEqual(data["report"], "測試風險報告")
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")
        r = self._last()
        self.assertEqual(r.endpoint, "scam")
        self.assertIsNone(r.user_id)
        self.assertEqual(r.status, "success")
        self.assertGreaterEqual(len(r.sources), 1)

    def test_empty_context_degraded(self):
        self.fake_rag.results = []
        self.fake_rag.metrics = {"fallback_reason": "", "empty_context": True}
        resp = self._post("/api/scam-scan", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["risk_level"], "medium")
        r = self._last()
        self.assertEqual(r.status, "degraded")

    def test_store_failure_response_unchanged(self):
        class FailingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                return False, "trace_run_write_failed"

        app_module._trace = RAGTraceService(
            store=self.mem, db_store=FailingStore(), hmac_secret=TEST_HMAC_SECRET)
        resp = self._post("/api/scam-scan", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["risk_level"], "medium")

    def test_llm_exception_fixed_message_no_leak(self):
        app_module.refresh_openai_client = lambda: FakeLLM(
            parse_error=RuntimeError("provider token=sk-leak-1234567890123456"))
        resp = self._post("/api/scam-scan", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["report"], "系統錯誤，請稍後再試。")
        self.assertNotIn("sk-leak", json.dumps(data, ensure_ascii=False))
        r = self._last()
        self.assertEqual(r.status, "error")
        self.assertEqual(r.error, "llm_error")

    def test_missing_key_degraded_llm_unavailable(self):
        app_module.refresh_openai_client = lambda: None
        resp = self._post("/api/scam-scan", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["report"], "API Key 未設定，無法連線 AI。")
        r = self._last()
        self.assertEqual(r.status, "degraded")
        self.assertEqual(r.fallback_reason, "llm_unavailable")

    def test_empty_text_no_trace(self):
        resp = self._post("/api/scam-scan", {"text": ""})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["report"], "請提供要檢測的內容。")
        self.assertEqual(self.mem.recent(10), [])

    def test_rag_exception_fixed_code(self):
        self.fake_rag.raise_error = True
        resp = self._post("/api/scam-scan", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertNotIn("sk-fake-rag-secret", json.dumps(data, ensure_ascii=False))
        r = self._last()
        self.assertEqual(r.status, "degraded")
        self.assertTrue(r.fallback)
        self.assertEqual(r.fallback_reason, "rag_error")
        self.assertNotIn("sk-fake-rag-secret", json.dumps(r.to_run_payload(),
                                                          ensure_ascii=False))


class PodcastTraceTests(BaseEndpointTraceTest):
    PAYLOAD = {"market": "BTC"}

    def test_canonical_success_one_trace(self):
        resp = self._post("/podcast/generate", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for key in ["title", "bullets", "script", "estimated_seconds", "lines"]:
            self.assertIn(key, data)
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")
        records = self.mem.recent(10)
        self.assertEqual(len(records), 1)
        r = records[0]
        self.assertEqual(r.endpoint, "podcast")
        self.assertIsNone(r.user_id)
        self.assertEqual(r.status, "success")

    def test_alias_one_trace(self):
        resp = self._post("/api/podcast/generate", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(self.mem.recent(10)), 1)
        self.assertEqual(self.mem.recent(1)[0].endpoint, "podcast")

    def test_validation_422_no_trace(self):
        resp = self._post("/podcast/generate", {"market": "NOT_A_MARKET"})
        self.assertEqual(resp.status_code, 422)
        self.assertEqual(self.mem.recent(10), [])

    def test_empty_context_degraded(self):
        self.fake_rag.context = []
        self.fake_rag.metrics = {"fallback_reason": "", "empty_context": True}
        resp = self._post("/podcast/generate", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._last().status, "degraded")

    def test_store_failure_response_unchanged(self):
        class RaisingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                raise RuntimeError("boom")

        app_module._trace = RAGTraceService(
            store=RaisingStore(), db_store=None, hmac_secret=TEST_HMAC_SECRET)
        resp = self._post("/podcast/generate", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("title", resp.get_json())

    def test_missing_key_degraded(self):
        app_module.refresh_openai_client = lambda: None
        resp = self._post("/podcast/generate", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("title", data)  # fallback podcast shape
        r = self._last()
        self.assertEqual(r.status, "degraded")
        self.assertEqual(r.fallback_reason, "llm_unavailable")

    def test_llm_exception_no_debug_leak(self):
        app_module.refresh_openai_client = lambda: FakeLLM(
            parse_error=RuntimeError("provider token=sk-leak-1234567890123456"))
        resp = self._post("/podcast/generate", self.PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("title", data)
        self.assertNotIn("debug", data)  # 不再回傳 OpenAI fallback: xxx
        self.assertNotIn("sk-leak", json.dumps(data, ensure_ascii=False))
        r = self._last()
        self.assertEqual(r.status, "error")
        self.assertEqual(r.error, "llm_error")


class HealthTraceTests(BaseEndpointTraceTest):
    PAYLOAD = {"holdings": [{"ticker": "BTC", "weight": 0.6},
                            {"ticker": "ETH", "weight": 0.4}]}

    def test_success_auth_uid(self):
        resp = self._post("/portfolio/analyze-llm", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for key in ["risk_health", "narrative", "highlights"]:
            self.assertIn(key, data)
        self.assertEqual(data["narrative"], "白話配置分析")
        self.assertRegex(data["trace_id"], r"^[0-9a-f]{32}$")
        r = self._last()
        self.assertEqual(r.endpoint, "health")
        self.assertEqual(r.user_id, USER_A)
        self.assertEqual(r.status, "success")
        answer = json.loads(r.answer)
        self.assertEqual(answer["narrative"], "白話配置分析")
        self.assertEqual(set(answer.keys()), {"risk_health", "narrative", "highlights"})

    def test_empty_context_degraded(self):
        self.fake_rag.context = []
        self.fake_rag.metrics = {"fallback_reason": "", "empty_context": True}
        resp = self._post("/portfolio/analyze-llm", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._last().status, "degraded")

    def test_store_failure_response_unchanged(self):
        class RaisingStore:
            enabled = True
            disabled_reason = None

            def save_run(self, record):
                raise RuntimeError("boom")

        app_module._trace = RAGTraceService(
            store=RaisingStore(), db_store=None, hmac_secret=TEST_HMAC_SECRET)
        resp = self._post("/portfolio/analyze-llm", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("narrative", resp.get_json())

    def test_missing_key_degraded(self):
        app_module.client = None
        resp = self._post("/portfolio/analyze-llm", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("risk_health", data)
        r = self._last()
        self.assertEqual(r.status, "degraded")
        self.assertEqual(r.fallback_reason, "llm_unavailable")

    def test_llm_exception_fixed_narrative_no_leak(self):
        app_module.client = FakeLLM(
            parse_error=RuntimeError("provider token=sk-leak-1234567890123456"))
        resp = self._post("/portfolio/analyze-llm", self.PAYLOAD, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["narrative"], "LLM 分析連線失敗，請檢查金鑰。")
        self.assertNotIn("sk-leak", json.dumps(data, ensure_ascii=False))
        r = self._last()
        self.assertEqual(r.status, "error")
        self.assertEqual(r.error, "llm_error")

    def test_validation_422_no_trace(self):
        resp = self._post("/portfolio/analyze-llm", {}, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 422)
        self.assertEqual(self.mem.recent(10), [])

    def test_unauth_no_trace(self):
        resp = self._post("/portfolio/analyze-llm", self.PAYLOAD)
        self.assertEqual(resp.status_code, 401)
        self.assertEqual(self.mem.recent(10), [])


class CrossEndpointTests(BaseEndpointTraceTest):
    def test_endpoint_metadata_not_polluted(self):
        self._post("/api/agent-plan", {"goal": "規劃投資"}, token=REAL_TOKEN_A)
        self._post("/api/scam-scan", {"text": "保證收益"})
        self._post("/podcast/generate", {"market": "BTC"})
        self._post("/portfolio/analyze-llm",
                   {"holdings": [{"ticker": "BTC", "weight": 0.5}]},
                   token=REAL_TOKEN_A)
        records = self.mem.recent(4)
        self.assertEqual(
            [(r.endpoint, r.user_id) for r in records],
            [("agent", USER_A), ("scam", None), ("podcast", None),
             ("health", USER_A)])
        for r in records:
            self.assertIn(r.status, {"success", "degraded", "abstained", "error"})

    def test_citations_only_injected(self):
        resp = self._post("/api/agent-plan", {"goal": "規劃投資"}, token=REAL_TOKEN_A)
        data = resp.get_json()
        self.assertEqual(len(data["citations"]), 1)  # injected_count=1 of 2
        self.assertEqual(data["citations"][0]["chunk_id"], "investment_rules#3")

    def test_citation_no_absolute_path(self):
        self.fake_rag.results = [
            make_source("內容", source="/server/absolute/data/knowledge/investment_rules.md",
                        chunk_id="investment_rules#3", section="DCA"),
        ]
        self.fake_rag.injected_count = 1
        resp = self._post("/api/scam-scan", {"text": "檢查"})
        data = resp.get_json()
        self.assertEqual(len(data["citations"]), 1)
        self.assertEqual(data["citations"][0]["source"], "investment_rules.md")
        self.assertNotIn("/server", json.dumps(data["citations"], ensure_ascii=False))

    def test_demo_user_null(self):
        resp = self._post("/api/agent-plan", {"goal": "規劃投資"}, token=DEMO_TOKEN)
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(self._last().user_id)


class RagExceptionCodeTests(BaseEndpointTraceTest):
    """Codex R1 blocker 1：四 route 的直接 RAG exception → fallback_reason=rag_error。"""

    def _assert_rag_error(self, record):
        self.assertEqual(record.status, "degraded")
        self.assertTrue(record.fallback)
        self.assertEqual(record.fallback_reason, "rag_error")
        self.assertNotIn("sk-fake-rag-secret",
                         json.dumps(record.to_run_payload(), ensure_ascii=False))

    def test_agent_rag_exception(self):
        self.fake_rag.raise_error = True
        resp = self._post("/api/agent-plan", {"goal": "規劃投資"}, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("summary", data)
        self.assertNotIn("sk-fake-rag-secret", json.dumps(data, ensure_ascii=False))
        self._assert_rag_error(self._last())

    def test_podcast_rag_exception(self):
        self.fake_rag.raise_error = True
        resp = self._post("/podcast/generate", {"market": "BTC"})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("title", data)
        self.assertNotIn("sk-fake-rag-secret", json.dumps(data, ensure_ascii=False))
        self._assert_rag_error(self._last())

    def test_health_rag_exception(self):
        self.fake_rag.raise_error = True
        resp = self._post("/portfolio/analyze-llm",
                          {"holdings": [{"ticker": "BTC", "weight": 0.5}]},
                          token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("narrative", data)
        self.assertNotIn("sk-fake-rag-secret", json.dumps(data, ensure_ascii=False))
        self._assert_rag_error(self._last())

    def test_scam_rag_exception(self):
        self.fake_rag.raise_error = True
        resp = self._post("/api/scam-scan", {"text": "檢查"})
        self.assertEqual(resp.status_code, 200)
        self._assert_rag_error(self._last())


class SnapshotTests(BaseEndpointTraceTest):
    """Codex R1 blocker 2：query/answer snapshot 反映實際輸入與實際交付內容。"""

    def test_agent_same_goal_different_budget_different_query_hash(self):
        self._post("/api/agent-plan",
                   {"goal": "規劃比特幣投資", "profile": "穩健型", "budget": "100000"},
                   token=REAL_TOKEN_A)
        self._post("/api/agent-plan",
                   {"goal": "規劃比特幣投資", "profile": "穩健型", "budget": "500000"},
                   token=REAL_TOKEN_A)
        records = self.mem.recent(2)
        self.assertNotEqual(records[0].query_hash, records[1].query_hash)
        self.assertNotEqual(records[0].sanitized_query, records[1].sanitized_query)

    def test_agent_query_snapshot_contains_profile_budget(self):
        self._post("/api/agent-plan",
                   {"goal": "規劃投資", "profile": "積極型", "budget": "250000"},
                   token=REAL_TOKEN_A)
        snapshot = json.loads(self._last().sanitized_query)
        self.assertEqual(snapshot["goal"], "規劃投資")
        self.assertEqual(snapshot["profile"], "積極型")
        self.assertEqual(snapshot["budget"], "250000")
        self.assertEqual(snapshot["retrieval_query"], "規劃投資")

    def test_podcast_query_snapshot_contains_context(self):
        self._post("/podcast/generate", {
            "market": "BTC", "profile": {"risk_level": "aggressive"},
            "watchlist": ["ETH", "SOL"], "events": ["ETH ETF 通過"],
        })
        snapshot = json.loads(self._last().sanitized_query)
        self.assertEqual(snapshot["market"], "BTC")
        self.assertEqual(snapshot["risk_level"], "aggressive")
        self.assertEqual(snapshot["watchlist"], ["ETH", "SOL"])
        self.assertEqual(snapshot["events"], ["ETH ETF 通過"])
        self.assertEqual(snapshot["retrieval_query"], "BTC")

    def test_health_query_snapshot_contains_holdings_metrics_retrieval_query(self):
        self._post("/portfolio/analyze-llm",
                   {"holdings": [{"ticker": "BTC", "weight": 0.6},
                                 {"ticker": "ETH", "weight": 0.4}]},
                   token=REAL_TOKEN_A)
        snapshot = json.loads(self._last().sanitized_query)
        self.assertIn("BTC(0.60)", snapshot["holdings"])
        self.assertIn("ETH(0.40)", snapshot["holdings"])
        self.assertIn("top1_weight", snapshot["metrics"])
        self.assertIn("annual_vol", snapshot["metrics"])
        self.assertIn("max_drawdown", snapshot["metrics"])
        self.assertEqual(snapshot["retrieval_query"], "配置風險波動集中度")

    def test_fallback_answer_snapshot_matches_business_response(self):
        app_module.client = None
        resp = self._post("/api/agent-plan", {"goal": "規劃投資"}, token=REAL_TOKEN_A)
        data = resp.get_json()
        answer = json.loads(self._last().answer)
        self.assertEqual(
            set(answer.keys()), {"summary", "steps", "risks", "next_action", "allocation"})
        for key in answer:
            self.assertEqual(answer[key], data[key])

    def test_secrets_in_inputs_sanitized_everywhere(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-abcdef"
        api_key = "sk-abcdefghijklmnop1234"
        resp = self._post("/podcast/generate", {
            "market": "PERSONAL",
            "events": [jwt, api_key],
            "portfolio_summary": {"note": jwt, "key": api_key},
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertNotIn(jwt, json.dumps(data, ensure_ascii=False))
        self.assertNotIn(api_key, json.dumps(data, ensure_ascii=False))
        record = self._last()
        payload = json.dumps(record.to_run_payload(), ensure_ascii=False)
        self.assertNotIn(jwt, payload)
        self.assertNotIn(api_key, payload)
        self.assertIn("<JWT>", record.sanitized_query)
        self.assertIn("<API_KEY>", record.sanitized_query)


class CitationEndpointSanitizerTests(BaseEndpointTraceTest):
    """Codex R1 blocker 3：citation 反例（POSIX/Windows 路徑、控制字元、secret）。"""

    def test_citation_all_fields_cleaned(self):
        self.fake_rag.results = [
            make_source("內容",
                        source="/srv/private/knowledge/doc.md",
                        chunk_id="/srv/private/doc#1",
                        section="C:\\private\\section",
                        topic="/srv/private/topic"),
        ]
        self.fake_rag.injected_count = 1
        resp = self._post("/api/scam-scan", {"text": "檢查"})
        data = resp.get_json()
        c = data["citations"][0]
        self.assertEqual(c["chunk_id"], "doc#1")
        self.assertEqual(c["source"], "doc.md")
        self.assertEqual(c["section"], "section")
        self.assertEqual(c["topic"], "topic")
        raw = json.dumps(data["citations"], ensure_ascii=False)
        self.assertNotIn("/srv", raw)
        self.assertNotIn("C:\\", raw)
        self.assertNotIn("private", raw)

    def test_citation_control_chars_and_secret_cleaned(self):
        self.fake_rag.results = [
            make_source("內容", source="doc.md", chunk_id="c#1",
                        section="a\r\nb\teyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-abcdef",
                        topic="sk-abcdefghijklmnop1234"),
        ]
        self.fake_rag.injected_count = 1
        resp = self._post("/api/scam-scan", {"text": "檢查"})
        data = resp.get_json()
        c = data["citations"][0]
        self.assertNotIn("\r", c["section"])
        self.assertNotIn("\n", c["section"])
        self.assertNotIn("\t", c["section"])
        self.assertIn("<JWT>", c["section"])
        self.assertIn("<API_KEY>", c["topic"])
        self.assertNotIn("eyJ", json.dumps(data["citations"], ensure_ascii=False))
        self.assertNotIn("sk-abcdefghijklmnop1234",
                         json.dumps(data["citations"], ensure_ascii=False))


class TraceSnapshotTruncationTests(BaseEndpointTraceTest):
    """Codex R2 blocker：超過 max_len 的 snapshot 必須仍是合法、可評測的 JSON。"""

    JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-abcdef"
    API_KEY = "sk-abcdefghijklmnop1234"
    PRIVATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    def test_long_agent_goal_query_valid_json(self):
        long_goal = "投資" * 2600  # 5200 chars
        resp = self._post("/api/agent-plan", {"goal": long_goal}, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        record = self._last()
        self.assertLessEqual(len(record.sanitized_query), 4000)
        snapshot = json.loads(record.sanitized_query)  # 修正前：JSONDecodeError
        for key in ["goal", "profile", "budget", "retrieval_query"]:
            self.assertIn(key, snapshot)
        self.assertIn("…[truncated]", snapshot["goal"])

    def test_long_scam_text_query_valid_json(self):
        long_text = "檢查" * 3000  # 6000 chars
        resp = self._post("/api/scam-scan", {"text": long_text})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["risk_level"], "medium")
        record = self._last()
        self.assertLessEqual(len(record.sanitized_query), 4000)
        snapshot = json.loads(record.sanitized_query)
        for key in ["text", "retrieval_query"]:
            self.assertIn(key, snapshot)
        self.assertIn("…[truncated]", snapshot["text"])

    def test_podcast_long_events_and_portfolio_summary(self):
        events = ["事件%d" % i for i in range(3000)]
        portfolio_summary = {"k%d" % i: "v" * 100 for i in range(100)}
        resp = self._post("/podcast/generate", {
            "market": "PERSONAL", "events": events,
            "portfolio_summary": portfolio_summary,
        })
        self.assertEqual(resp.status_code, 200)
        self.assertIn("title", resp.get_json())
        record = self._last()
        self.assertLessEqual(len(record.sanitized_query), 4000)
        snapshot = json.loads(record.sanitized_query)
        for key in ["market", "risk_level", "watchlist", "events",
                    "portfolio_summary", "retrieval_query"]:
            self.assertIn(key, snapshot)
        raw = json.dumps(snapshot, ensure_ascii=False)
        self.assertIn("…[truncated]", raw)

    def test_long_answer_truncated_valid_json(self):
        long_summary = "長" * 9000
        app_module.client = FakeLLM()
        app_module.client.chat.completions.create = (
            lambda **kwargs: types.SimpleNamespace(choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(
                    content=json.dumps({"summary": long_summary,
                                        "steps": ["s"], "risks": ["r"],
                                        "next_action": "n",
                                        "allocation": []},
                                       ensure_ascii=False),
                    tool_calls=[]))]))
        resp = self._post("/api/agent-plan", {"goal": "規劃投資"}, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        # API response 不得因 trace 截斷而改變
        self.assertEqual(data["summary"], long_summary)
        record = self._last()
        self.assertLessEqual(len(record.answer), 8000)
        answer = json.loads(record.answer)  # 修正前：JSONDecodeError
        for key in ["summary", "steps", "risks", "next_action", "allocation"]:
            self.assertIn(key, answer)
        self.assertIn("…[truncated]", answer["summary"])

    def test_long_input_deterministic(self):
        long_goal = "投資" * 2600
        self._post("/api/agent-plan", {"goal": long_goal}, token=REAL_TOKEN_A)
        self._post("/api/agent-plan", {"goal": long_goal}, token=REAL_TOKEN_A)
        r1, r2 = self.mem.recent(2)
        self.assertEqual(r1.sanitized_query, r2.sanitized_query)
        self.assertEqual(r1.query_hash, r2.query_hash)

    def test_secrets_not_in_truncated_snapshot(self):
        # JWT 放在前段（會被遮罩），API key／私鑰放在後段（可能被截斷，但絕不能原樣出現）
        long_text = self.JWT + "檢查" * 2900 + self.API_KEY + self.PRIVATE_KEY
        records = []
        handler = logging.Handler()
        handler.emit = lambda record: records.append(record)
        logger = logging.getLogger("services.rag_trace_service")
        logger.addHandler(handler)
        try:
            resp = self._post("/api/scam-scan", {"text": long_text})
        finally:
            logger.removeHandler(handler)
        self.assertEqual(resp.status_code, 200)
        record = self._last()
        payload = json.dumps(record.to_run_payload(), ensure_ascii=False)
        self.assertNotIn(self.JWT, payload)
        self.assertNotIn(self.API_KEY, payload)
        self.assertNotIn(self.PRIVATE_KEY, payload)
        snapshot = json.loads(record.sanitized_query)
        self.assertIn("<JWT>", snapshot["text"])
        self.assertNotIn("eyJ", snapshot["text"])
        for rec in records:
            self.assertNotIn(self.JWT, rec.getMessage())
            self.assertNotIn(self.API_KEY, rec.getMessage())
        response_text = json.dumps(resp.get_json(), ensure_ascii=False)
        self.assertNotIn(self.JWT, response_text)
        self.assertNotIn(self.API_KEY, response_text)

    def test_api_response_unchanged_by_truncation(self):
        events = ["事件%d" % i for i in range(3000)]
        resp = self._post("/podcast/generate", {"market": "BTC", "events": events})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        for key in ["title", "bullets", "script", "estimated_seconds", "lines"]:
            self.assertIn(key, data)
        self.assertEqual(data["title"], "今日市場晨報")
        self.assertEqual(len(data["lines"]), 14)

    def test_small_snapshot_byte_stable(self):
        self._post("/api/agent-plan",
                   {"goal": "規劃投資", "profile": "穩健型", "budget": "100000"},
                   token=REAL_TOKEN_A)
        record = self._last()
        expected = json.dumps(
            {"goal": "規劃投資", "profile": "穩健型", "budget": "100000",
             "retrieval_query": "規劃投資"},
            ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        self.assertEqual(record.sanitized_query, expected)
        self.assertNotIn("…[truncated]", record.sanitized_query)


class TraceSnapshotSanitizeOrderTests(BaseEndpointTraceTest):
    """Codex R3 blocker：sanitizer 必須作用於 JSON value，不可作用於 serialized JSON 語法；
    過大 nested dict 不得讓整筆 snapshot 退化成 error envelope。"""

    URL = "https://example.invalid/path?x=1"

    def test_agent_goal_with_url_valid_json(self):
        resp = self._post("/api/agent-plan",
                          {"goal": "請分析 " + self.URL}, token=REAL_TOKEN_A)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("summary", data)
        record = self._last()
        snapshot = json.loads(record.sanitized_query)  # 修正前：JSONDecodeError
        for key in ["goal", "profile", "budget", "retrieval_query"]:
            self.assertIn(key, snapshot)
        self.assertNotIn("example.invalid", snapshot["goal"])
        self.assertIn("<URL>", snapshot["goal"])

    def test_nested_values_with_url_and_pii_valid_json(self):
        resp = self._post("/api/scam-scan", {"text": "連結 " + self.URL})
        self.assertEqual(resp.status_code, 200)
        record = self._last()
        snapshot = json.loads(record.sanitized_query)
        self.assertIn("<URL>", snapshot["text"])
        self.assertNotIn("example.invalid", snapshot["text"])

        resp2 = self._post("/podcast/generate", {
            "market": "PERSONAL",
            "events": ["事件 " + self.URL, "聯絡 a.b@example.com"],
            "portfolio_summary": {"note": "看 " + self.URL},
        })
        self.assertEqual(resp2.status_code, 200)
        record2 = self.mem.recent(1)[0]
        snapshot2 = json.loads(record2.sanitized_query)
        self.assertIn("<URL>", snapshot2["events"][0])
        self.assertIn("<EMAIL>", snapshot2["events"][1])
        self.assertIn("<URL>", snapshot2["portfolio_summary"]["note"])
        raw = json.dumps(snapshot2, ensure_ascii=False)
        self.assertNotIn("example.invalid", raw)
        self.assertNotIn("a.b@example.com", raw)

    def test_nested_dict_key_secret_cleaned_collision_safe(self):
        jwt_a = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-aaaa"
        jwt_b = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-bbbb"
        payload = {
            "market": "PERSONAL",
            "portfolio_summary": {
                jwt_a: "value-a",
                jwt_b: "value-b",
                "正常key": "value-c",
            },
        }
        resp = self._post("/podcast/generate", payload)
        self.assertEqual(resp.status_code, 200)
        snapshot = json.loads(self._last().sanitized_query)
        summary = snapshot["portfolio_summary"]
        raw = json.dumps(summary, ensure_ascii=False)
        self.assertNotIn("eyJ", raw)
        self.assertNotIn("sig-signature", raw)
        # 兩個 JWT key 遮罩後相同 → 必須 collision-safe，不得靜默覆蓋
        values = sorted(v for v in summary.values() if isinstance(v, str))
        self.assertEqual(values, ["value-a", "value-b", "value-c"])
        self.assertEqual(len(summary), 3)

    def test_3000_entry_nested_dict_keeps_outer_keys(self):
        portfolio_summary = {"k%04d" % i: "v" * 30 for i in range(3000)}
        resp = self._post("/podcast/generate", {
            "market": "PERSONAL",
            "portfolio_summary": portfolio_summary,
        })
        self.assertEqual(resp.status_code, 200)
        record = self._last()
        self.assertLessEqual(len(record.sanitized_query), 4000)
        snapshot = json.loads(record.sanitized_query)  # 修正前：error envelope 或 parse 失敗
        for key in ["market", "risk_level", "watchlist", "events",
                    "portfolio_summary", "retrieval_query"]:
            self.assertIn(key, snapshot)
        self.assertIn("…[truncated]", json.dumps(snapshot, ensure_ascii=False))


class TraceSnapshotKeyCollisionAllocatorTests(BaseEndpointTraceTest):
    """Codex R4 blocker：final cleaned key 必須對整個輸出 dict 保證唯一。"""

    def test_key_collision_final_candidate_unique_no_value_lost(self):
        jwt_a = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-aaaa"
        jwt_b = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-signature-bbbb"
        payload = {
            "market": "PERSONAL",
            "portfolio_summary": {
                "<JWT>": "value-raw-jwt",
                "<JWT>#2": "value-raw-jwt2",
                "<JWT>#3": "value-raw-jwt3",
                jwt_a: "value-a",
                jwt_b: "value-b",
            },
        }
        resp = self._post("/podcast/generate", payload)
        self.assertEqual(resp.status_code, 200)
        record = self._last()
        snapshot = json.loads(record.sanitized_query)  # 修正前：value 遺失（3 != 5）
        summary = snapshot["portfolio_summary"]
        self.assertEqual(len(summary), 5)  # 所有 input values 均保留
        self.assertEqual(len(set(summary.keys())), 5)  # 輸出 keys 全部唯一
        values = sorted(v for v in summary.values() if isinstance(v, str))
        self.assertEqual(
            values,
            ["value-a", "value-b", "value-raw-jwt",
             "value-raw-jwt2", "value-raw-jwt3"])
        raw = json.dumps(snapshot, ensure_ascii=False)
        self.assertNotIn("eyJ", raw)
        self.assertNotIn("sig-signature", raw)

        # 相同輸入重跑 → byte-for-byte deterministic
        self._post("/podcast/generate", payload)
        record2 = self.mem.recent(1)[0]
        self.assertEqual(record2.sanitized_query, record.sanitized_query)
        self.assertEqual(record2.query_hash, record.query_hash)


if __name__ == "__main__":
    unittest.main()
