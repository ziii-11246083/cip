"""
RAG Service — main orchestrator (upgraded for hybrid RAG).
Wires: QueryRouter → QueryRewrite → HybridRetrieval → Rerank → PromptBuilder → LLM.
Each endpoint has its own topic priors, routing strategy, and context budget.
Full graceful degradation: falls back to keyword-only when components unavailable.
"""

import logging
import os
import time
from typing import Any, Callable, Dict, List, Optional

from services.knowledge_base import get_kb
from services.retrieval_service import RetrievalResult, get_retrieval
from services.prompt_builder import PromptBuilder
from services.ai_guardrails import check_input, check_output, safe_fallback_response

logger = logging.getLogger(__name__)

_ENABLE_REWRITE = os.getenv("RAG_ENABLE_QUERY_REWRITE", "1") == "1"
_ENABLE_ROUTING = os.getenv("RAG_ENABLE_ROUTING", "1") == "1"


class RAGService:
    """
    Central RAG orchestrator with hybrid retrieval pipeline.
    Each endpoint method:
    1. Routes query (fast/deep)
    2. Rewrites query (if deep path)
    3. Retrieves context via hybrid pipeline
    4. Builds augmented prompts
    5. Records metrics
    6. Falls back gracefully on failure
    """

    def __init__(self):
        self._kb = get_kb()
        self._retrieval = get_retrieval()
        self._builder = PromptBuilder()
        self._router: Any = None
        self._rewriter: Any = None
        self._metrics: Any = None

    @property
    def kb_loaded(self) -> bool:
        return self._kb.is_loaded and len(self._kb.list_sections()) > 0

    # ── per-endpoint retrieval ────────────────────────────────

    def _retrieve_for_endpoint(
        self,
        query: str,
        endpoint: str,
        topics: Optional[List[str]] = None,
        max_results: int = 3,
    ) -> Dict[str, Any]:
        """
        Full retrieval pipeline for an endpoint.
        Returns {results, meta, rewrite_result, route_decision, metrics_record}.
        """
        t_start = time.time()
        route_decision = None
        rewrite_result = None
        retrieval_meta: Dict[str, Any] = {}
        fallback_reason = ""

        # Step 1: Route
        if _ENABLE_ROUTING:
            try:
                route_decision = self._ensure_router().route(query, endpoint)
                logger.debug("Route decided: %s", route_decision.route)
            except Exception:
                logger.warning("Router failed (code=router_error)")
                fallback_reason = "router_error"
        else:
            route_decision = type('obj', (object,), {
                'route': 'fast', 'reason': 'routing_disabled',
                'complexity': 0.0, 'intent_count': 1, 'entity_count': 0,
                'to_dict': lambda: {'route': 'fast'}
            })()

        is_deep = route_decision and route_decision.route == "deep"

        # Step 2: Rewrite (deep path only)
        if is_deep and _ENABLE_REWRITE:
            try:
                rewrite_result = self._ensure_rewriter().rewrite(query, endpoint)
                if rewrite_result.used:
                    query = rewrite_result.rewritten
                    logger.debug("Rewrite applied (sim=%.3f)", rewrite_result.similarity)
            except Exception:
                # 固定安全代碼；仍以原 query 繼續 retrieval（不得 fatal）
                logger.warning("Rewrite failed (code=rewrite_error)")
                fallback_reason = "rewrite_error"

        # Step 3: Retrieve
        try:
            retrieval_meta = self._retrieval.retrieve_with_meta(
                query, topics=topics, max_results=max_results * 2 if is_deep else max_results
            )
        except Exception:
            logger.warning("Retrieval failed (code=retrieval_error)")
            fallback_reason = "retrieval_error"
            retrieval_meta = {
                "results": [], "sparse_hit_count": 0, "dense_hit_count": 0,
                "final_context_count": 0, "method": "failed",
            }

        # For fast path, trim to max_results
        results = retrieval_meta.get("results", [])
        if not is_deep:
            results = results[:max_results]

        retrieval_latency = (time.time() - t_start) * 1000

        # Step 4: Metrics record
        metrics_record = {}
        try:
            m = self._ensure_metrics()
            metrics_record = m.build_record(
                endpoint=endpoint,
                query=query,
                route_type=route_decision.route if route_decision else "unknown",
                rewrite_result=rewrite_result.to_dict() if rewrite_result else None,
                sparse_hit_count=retrieval_meta.get("sparse_hit_count", 0),
                dense_hit_count=retrieval_meta.get("dense_hit_count", 0),
                final_context_count=len(results),
                top_sources=[r.source if hasattr(r, 'source') else r.get('source', '')
                            for r in results[:5]],
                retrieval_latency_ms=retrieval_latency,
                total_rag_latency_ms=retrieval_latency,
                fallback_reason=fallback_reason,
                empty_context=len(results) == 0,
            )
            m.log_call(metrics_record)
        except Exception:
            pass

        return {
            "results": results,
            "meta": retrieval_meta,
            "rewrite_result": rewrite_result,
            "route_decision": route_decision,
            "metrics_record": metrics_record,
        }

    # ── endpoint-specific retrieval helpers ───────────────────

    def _retrieve_chat_context(self, query: str, risk_profile: str) -> List[RetrievalResult]:
        topics = ["投資原則", "市場情境", "市場敘事", "健康度檢查"]
        return self._retrieve_for_endpoint(query, "chat", topics=topics, max_results=3)["results"]

    def _retrieve_agent_context(self, goal: str) -> List[RetrievalResult]:
        topics = ["投資原則", "市場情境", "健康度檢查", "市場敘事"]
        return self._retrieve_for_endpoint(goal, "agent", topics=topics, max_results=4)["results"]

    def _retrieve_podcast_context(self, topic: str) -> List[RetrievalResult]:
        topics = ["Podcast風格", "市場敘事", "市場情境"]
        return self._retrieve_for_endpoint(topic, "podcast", topics=topics, max_results=3)["results"]

    def _retrieve_scam_context(self, content: str) -> List[RetrievalResult]:
        topics = ["詐騙模式"]
        return self._retrieve_for_endpoint(content, "scam", topics=topics, max_results=2)["results"]

    def _retrieve_health_context(self) -> List[RetrievalResult]:
        topics = ["健康度檢查", "投資原則", "市場情境"]
        return self._retrieve_for_endpoint(
            "配置風險波動集中度", "health", topics=topics, max_results=3
        )["results"]

    # ── public API ────────────────────────────────────────────

    def augment_chat(
        self,
        user_message: str,
        risk_profile: str = "穩健型",
        user_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build RAG-augmented context for /api/ai-chat."""
        results: List[RetrievalResult] = []
        retrieval_meta: Dict[str, Any] = {}
        # 安全 metrics：無論成功或降級都回傳足以判定狀態的紀錄；
        # fallback_reason 只使用固定代碼（不含 provider exception text）。
        pipe: Optional[Dict[str, Any]] = None
        try:
            if self.kb_loaded:
                pipe = self._retrieve_for_endpoint(
                    user_message, "chat",
                    topics=["投資原則", "市場情境", "市場敘事", "健康度檢查"],
                    max_results=3,
                )
                results = pipe["results"]
                retrieval_meta = pipe["meta"]
            else:
                logger.info("RAG kb not loaded, skipping chat retrieval")
                pipe = {
                    "results": [],
                    "meta": {},
                    "metrics_record": {
                        "empty_context": True,
                        "fallback_reason": "kb_unavailable",
                    },
                }
        except Exception:
            logger.warning("RAG retrieval failed for chat, falling back (code=retrieval_error)")
            pipe = {
                "results": [],
                "meta": {},
                "metrics_record": {
                    "empty_context": True,
                    "fallback_reason": "retrieval_error",
                },
            }

        prompt = self._builder.build_chat_prompt(
            user_message=user_message,
            risk_profile=risk_profile,
            retrieval_results=results,
            user_context=user_context,
            retrieval_meta=retrieval_meta,
        )
        # Trace payloads (additive; TASK 02): retrieval sources + pipeline metrics
        prompt["retrieval_results"] = results
        prompt["metrics_record"] = pipe.get("metrics_record", {}) if pipe else {}
        return prompt

    def augment_agent(
        self,
        goal: str,
        risk_profile: str,
        budget: str,
    ) -> Dict[str, Any]:
        """Build RAG-augmented context for /api/agent-plan."""
        results: List[RetrievalResult] = []
        retrieval_meta: Dict[str, Any] = {}
        pipe: Optional[Dict[str, Any]] = None
        try:
            if self.kb_loaded:
                pipe = self._retrieve_for_endpoint(
                    goal, "agent",
                    topics=["投資原則", "市場情境", "健康度檢查", "市場敘事"],
                    max_results=4,
                )
                results = pipe["results"]
                retrieval_meta = pipe["meta"]
            else:
                pipe = {
                    "results": [],
                    "meta": {},
                    "metrics_record": {
                        "empty_context": True,
                        "fallback_reason": "kb_unavailable",
                    },
                }
        except Exception:
            logger.warning("RAG retrieval failed for agent, falling back (code=retrieval_error)")
            pipe = {
                "results": [],
                "meta": {},
                "metrics_record": {
                    "empty_context": True,
                    "fallback_reason": "retrieval_error",
                },
            }

        prompt = self._builder.build_agent_prompt(
            goal=goal,
            risk_profile=risk_profile,
            budget=budget,
            retrieval_results=results,
            retrieval_meta=retrieval_meta,
        )
        # Trace payloads (additive; TASK 03)
        prompt["retrieval_results"] = results
        prompt["metrics_record"] = pipe.get("metrics_record", {}) if pipe else {}
        return prompt

    def augment_podcast(
        self,
        topic: str,
        market_context: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Build RAG-augmented context for /podcast/generate."""
        results: List[RetrievalResult] = []
        retrieval_meta: Dict[str, Any] = {}
        pipe: Optional[Dict[str, Any]] = None
        try:
            if self.kb_loaded:
                pipe = self._retrieve_for_endpoint(
                    topic, "podcast",
                    topics=["Podcast風格", "市場敘事", "市場情境"],
                    max_results=3,
                )
                results = pipe["results"]
                retrieval_meta = pipe["meta"]
            else:
                pipe = {
                    "results": [],
                    "meta": {},
                    "metrics_record": {
                        "empty_context": True,
                        "fallback_reason": "kb_unavailable",
                    },
                }
        except Exception:
            logger.warning("RAG retrieval failed for podcast, falling back (code=retrieval_error)")
            pipe = {
                "results": [],
                "meta": {},
                "metrics_record": {
                    "empty_context": True,
                    "fallback_reason": "retrieval_error",
                },
            }

        prompt = self._builder.build_podcast_prompt(
            topic=topic,
            retrieval_results=results,
            market_context=market_context,
            retrieval_meta=retrieval_meta,
        )
        # Trace payloads (additive; TASK 03)
        prompt["retrieval_results"] = results
        prompt["metrics_record"] = pipe.get("metrics_record", {}) if pipe else {}
        return prompt

    def augment_scam(self, content: str) -> Dict[str, Any]:
        """Build RAG context for scam detection education supplement."""
        results: List[RetrievalResult] = []
        retrieval_meta: Dict[str, Any] = {}
        pipe: Optional[Dict[str, Any]] = None
        try:
            if self.kb_loaded:
                pipe = self._retrieve_for_endpoint(
                    content, "scam",
                    topics=["詐騙模式"],
                    max_results=2,
                )
                results = pipe["results"]
                retrieval_meta = pipe["meta"]
            else:
                pipe = {
                    "results": [],
                    "meta": {},
                    "metrics_record": {
                        "empty_context": True,
                        "fallback_reason": "kb_unavailable",
                    },
                }
        except Exception:
            logger.warning("RAG retrieval failed for scam, falling back (code=retrieval_error)")
            pipe = {
                "results": [],
                "meta": {},
                "metrics_record": {
                    "empty_context": True,
                    "fallback_reason": "retrieval_error",
                },
            }

        snippets = []
        for r in results:
            snippets.append(f"[{r.topic}] {r.snippet[:300]}")
        # route 只使用 snippets[:2]，且 max_results=2 → 全部 retrieved 均為 injected
        return {
            "rag_snippets": snippets,
            "retrieval_count": len(results),
            "kb_available": self.kb_loaded,
            "retrieval_method": retrieval_meta.get("method", "keyword"),
            # Trace payloads (additive; TASK 03)
            "retrieval_results": results,
            "metrics_record": pipe.get("metrics_record", {}) if pipe else {},
            "citations": [],
            "confidence": None,
            "injected_count": len(results),
        }

    def augment_health(
        self,
        risk_health: Dict[str, Any],
        holdings_text: str,
    ) -> Dict[str, Any]:
        """Build RAG-augmented context for /portfolio/analyze-llm."""
        results: List[RetrievalResult] = []
        retrieval_meta: Dict[str, Any] = {}
        pipe: Optional[Dict[str, Any]] = None
        try:
            if self.kb_loaded:
                pipe = self._retrieve_for_endpoint(
                    "配置風險波動集中度", "health",
                    topics=["健康度檢查", "投資原則", "市場情境"],
                    max_results=3,
                )
                results = pipe["results"]
                retrieval_meta = pipe["meta"]
            else:
                pipe = {
                    "results": [],
                    "meta": {},
                    "metrics_record": {
                        "empty_context": True,
                        "fallback_reason": "kb_unavailable",
                    },
                }
        except Exception:
            logger.warning("RAG retrieval failed for health, falling back (code=retrieval_error)")
            pipe = {
                "results": [],
                "meta": {},
                "metrics_record": {
                    "empty_context": True,
                    "fallback_reason": "retrieval_error",
                },
            }

        prompt = self._builder.build_health_prompt(
            risk_health=risk_health,
            holdings_text=holdings_text,
            retrieval_results=results,
            retrieval_meta=retrieval_meta,
        )
        # Trace payloads (additive; TASK 03)
        prompt["retrieval_results"] = results
        prompt["metrics_record"] = pipe.get("metrics_record", {}) if pipe else {}
        return prompt

    # ── lazy service accessors ────────────────────────────────

    def _ensure_router(self):
        if self._router is None:
            from services.query_router_service import get_router
            self._router = get_router()
        return self._router

    def _ensure_rewriter(self):
        if self._rewriter is None:
            from services.query_rewrite_service import get_rewriter
            self._rewriter = get_rewriter()
        return self._rewriter

    def _ensure_metrics(self):
        if self._metrics is None:
            from services.rag_metrics_service import get_metrics
            self._metrics = get_metrics()
        return self._metrics


# ── safe wrapper for LLM calls ───────────────────────────────

def safe_llm_call(
    rag_service: RAGService,
    endpoint: str,
    fallback_fn: Callable[[], Any],
    **kwargs,
) -> Any:
    """
    Wraps an LLM endpoint with guardrails + RAG fallback.
    If guardrails block or RAG fails, falls back to deterministic response.
    """
    if "user_message" in kwargs:
        g = check_input(kwargs["user_message"])
        if not g.passed:
            return fallback_fn() if callable(fallback_fn) else {"reply": g.reason}

    try:
        result = fallback_fn()
        if isinstance(result, dict) and "reply" in result:
            g = check_output(result["reply"], context=endpoint)
            if not g.passed:
                result["reply"] = safe_fallback_response(endpoint)
                result["guardrail_flagged"] = True
        return result
    except Exception as exc:
        logger.exception("LLM call failed for %s: %s", endpoint, exc)
        return safe_fallback_response(endpoint)


# ── singleton ────────────────────────────────────────────────

_rag: Optional[RAGService] = None


def get_rag() -> RAGService:
    global _rag
    if _rag is None:
        _rag = RAGService()
    return _rag
