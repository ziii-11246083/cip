"""
Retrieval Service — MVP keyword retrieval with abstraction for future
embedding/vector-DB backends (BM25, TF-IDF, dense embeddings).
"""

import logging
from typing import Any, Dict, List, Optional

from services.knowledge_base import KnowledgeBase, get_kb

logger = logging.getLogger(__name__)


class RetrievalResult:
    """Single retrieval hit."""
    def __init__(
        self,
        snippet: str,
        source: str,
        topic: str,
        score: float = 0.0,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        self.snippet = snippet
        self.source = source
        self.topic = topic
        self.score = score
        self.metadata = metadata or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "snippet": self.snippet,
            "source": self.source,
            "topic": self.topic,
            "score": self.score,
            "metadata": self.metadata,
        }


class RetrievalService:
    """
    Retrieval abstraction layer.
    Currently: keyword-match via KnowledgeBase.
    Future: pluggable backends (BM25, dense embeddings, vector DB).
    """

    def __init__(self, kb: Optional[KnowledgeBase] = None):
        self._kb = kb or get_kb()

    # ── public API ──────────────────────────────────────────────

    def retrieve(
        self,
        query: str,
        topics: Optional[List[str]] = None,
        max_results: int = 3,
    ) -> List[RetrievalResult]:
        """Main retrieval entry point. Returns ranked results."""
        if not self._kb.is_loaded:
            logger.warning("Knowledge base not loaded, retrieval skipped.")
            return []

        raw = self._kb.search_keywords(query, max_sections=max_results)

        results: List[RetrievalResult] = []
        for item in raw:
            snippets = item.get("snippets", [])
            combined = " | ".join(snippets) if snippets else ""
            if topics and item.get("topic") not in topics:
                continue
            results.append(RetrievalResult(
                snippet=combined[:500],
                source=item.get("section", ""),
                topic=item.get("topic", ""),
                score=float(item.get("score", 0)),
                metadata={"section": item.get("section", "")},
            ))

        return results[:max_results]

    def retrieve_for_context(
        self,
        query: str,
        topics: Optional[List[str]] = None,
        max_results: int = 3,
        max_tokens: int = 800,
    ) -> str:
        """Retrieve and format into a compact context string for prompt injection."""
        results = self.retrieve(query, topics=topics, max_results=max_results)
        if not results:
            return ""

        parts: List[str] = []
        total_chars = 0
        for r in results:
            block = f"[{r.topic}] {r.snippet}"
            if total_chars + len(block) > max_tokens * 3:
                break
            parts.append(block)
            total_chars += len(block)

        return "\n".join(parts)

    def coin_knowledge(self, symbol: str) -> Dict[str, Any]:
        """Get structured knowledge about a specific coin."""
        profile = self._kb.coin_profile(symbol)
        if not profile:
            return {"symbol": symbol, "profile": None, "narratives": [], "risks": []}
        return {
            "symbol": symbol,
            "profile": profile,
            "narratives": profile.get("narrative_tags", []),
            "risks": profile.get("typical_risks", []),
        }

    def scenario_context(self, scenario_key: str) -> Dict[str, Any]:
        """Get scenario playbook context."""
        section = self._kb.get_section("scenario_playbooks") or ""
        # extract the relevant scenario block
        marker = f"## {scenario_key.replace('_', ' ').title()}"
        if marker.lower() not in section.lower():
            # try Chinese labels
            label_map = {
                "normal": "Normal（一般市場）",
                "bull": "Bull（牛市）",
                "bear": "Bear（熊市）",
                "black_swan": "Black Swan（黑天鵝）",
            }
            label = label_map.get(scenario_key, scenario_key)
            for alt_marker in [f"## {label}", f"## {scenario_key.replace('_', ' ')}"]:
                if alt_marker.lower() in section.lower():
                    marker = alt_marker
                    break

        idx = section.lower().find(marker.lower())
        if idx < 0:
            return {"scenario": scenario_key, "context": ""}

        # grab until next ## heading
        rest = section[idx + len(marker):]
        next_h2 = rest.find("\n## ")
        block = rest[:next_h2] if next_h2 > 0 else rest[:600]
        return {"scenario": scenario_key, "context": block.strip()[:600]}


# ── singleton ────────────────────────────────────────────────

_retrieval: Optional[RetrievalService] = None


def get_retrieval() -> RetrievalService:
    global _retrieval
    if _retrieval is None:
        _retrieval = RetrievalService()
    return _retrieval
