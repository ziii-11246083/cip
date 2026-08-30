"""
RAG Service — main orchestrator.
Wires KnowledgeBase → Retrieval → PromptBuilder → LLM call.
Provides fallback-safe wrappers for all AI endpoints.
"""

import logging
from typing import Any, Callable, Dict, List, Optional

from services.knowledge_base import get_kb
from services.retrieval_service import RetrievalResult, get_retrieval
from services.prompt_builder import PromptBuilder
from services.ai_guardrails import check_input, check_output, safe_fallback_response

logger = logging.getLogger(__name__)


class RAGService:
    """
    Central RAG orchestrator.
    Each method:
    1. Determines relevant knowledge topics
    2. Retrieves context
    3. Builds augmented prompts
    4. Falls back gracefully on retrieval failure
    """

    def __init__(self):
        self._kb = get_kb()
        self._retrieval = get_retrieval()
        self._builder = PromptBuilder()

    @property
    def kb_loaded(self) -> bool:
        return self._kb.is_loaded and len(self._kb.list_sections()) > 0

    # ── per-endpoint retrieval helpers ─────────────────────────

    def _retrieve_chat_context(self, query: str, risk_profile: str) -> List[RetrievalResult]:
        """Retrieve relevant knowledge for AI chat."""
        topics = ["投資原則", "市場情境", "市場敘事", "健康度檢查"]
        return self._retrieval.retrieve(query, topics=topics, max_results=3)

    def _retrieve_agent_context(self, goal: str) -> List[RetrievalResult]:
        """Retrieve relevant knowledge for Agent plan."""
        topics = ["投資原則", "市場情境", "健康度檢查", "市場敘事"]
        return self._retrieval.retrieve(goal, topics=topics, max_results=4)

    def _retrieve_podcast_context(self, topic: str) -> List[RetrievalResult]:
        """Retrieve style guide + market narratives for Podcast."""
        topics = ["Podcast風格", "市場敘事", "市場情境"]
        return self._retrieval.retrieve(topic, topics=topics, max_results=3)

    def _retrieve_scam_context(self, content: str) -> List[RetrievalResult]:
        """Retrieve scam patterns for education/supplement."""
        topics = ["詐騙模式"]
        return self._retrieval.retrieve(content, topics=topics, max_results=2)

    def _retrieve_health_context(self) -> List[RetrievalResult]:
        """Retrieve health guide for portfolio analysis narrative."""
        topics = ["健康度檢查", "投資原則", "市場情境"]
        # use a synthetic query since we want broad health knowledge
        return self._retrieval.retrieve("配置風險波動集中度", topics=topics, max_results=3)

    # ── public API ─────────────────────────────────────────────

    def augment_chat(
        self,
        user_message: str,
        risk_profile: str = "穩健型",
        user_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build RAG-augmented context for /api/ai-chat. Safe to call even without KB."""
        results: List[RetrievalResult] = []
        try:
            if self.kb_loaded:
                results = self._retrieve_chat_context(user_message, risk_profile)
            else:
                logger.info("RAG kb not loaded, skipping chat retrieval")
        except Exception as exc:
            logger.warning("RAG retrieval failed for chat, falling back: %s", exc)

        return self._builder.build_chat_prompt(
            user_message=user_message,
            risk_profile=risk_profile,
            retrieval_results=results,
            user_context=user_context,
        )

    def augment_agent(
        self,
        goal: str,
        risk_profile: str,
        budget: str,
    ) -> Dict[str, Any]:
        """Build RAG-augmented context for /api/agent-plan."""
        results: List[RetrievalResult] = []
        try:
            if self.kb_loaded:
                results = self._retrieve_agent_context(goal)
        except Exception as exc:
            logger.warning("RAG retrieval failed for agent, falling back: %s", exc)

        return self._builder.build_agent_prompt(
            goal=goal,
            risk_profile=risk_profile,
            budget=budget,
            retrieval_results=results,
        )

    def augment_podcast(
        self,
        topic: str,
        market_context: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Build RAG-augmented context for /podcast/generate."""
        results: List[RetrievalResult] = []
        try:
            if self.kb_loaded:
                results = self._retrieve_podcast_context(topic)
        except Exception as exc:
            logger.warning("RAG retrieval failed for podcast, falling back: %s", exc)

        return self._builder.build_podcast_prompt(
            topic=topic,
            retrieval_results=results,
            market_context=market_context,
        )

    def augment_scam(self, content: str) -> Dict[str, Any]:
        """Build RAG context for scam detection education supplement."""
        results: List[RetrievalResult] = []
        try:
            if self.kb_loaded:
                results = self._retrieve_scam_context(content)
        except Exception as exc:
            logger.warning("RAG retrieval failed for scam, falling back: %s", exc)

        # Return knowledge snippets for the scam endpoint to use
        snippets = []
        for r in results:
            snippets.append(f"[{r.topic}] {r.snippet[:300]}")
        return {
            "rag_snippets": snippets,
            "retrieval_count": len(results),
            "kb_available": self.kb_loaded,
        }

    def augment_health(
        self,
        risk_health: Dict[str, Any],
        holdings_text: str,
    ) -> Dict[str, Any]:
        """Build RAG-augmented context for /portfolio/analyze-llm."""
        results: List[RetrievalResult] = []
        try:
            if self.kb_loaded:
                results = self._retrieve_health_context()
        except Exception as exc:
            logger.warning("RAG retrieval failed for health, falling back: %s", exc)

        return self._builder.build_health_prompt(
            risk_health=risk_health,
            holdings_text=holdings_text,
            retrieval_results=results,
        )


# ── safe wrapper for LLM calls ──────────────────────────────

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
    # input guard
    if "user_message" in kwargs:
        g = check_input(kwargs["user_message"])
        if not g.passed:
            return fallback_fn() if callable(fallback_fn) else {"reply": g.reason}

    try:
        result = fallback_fn()
        # output guard
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
