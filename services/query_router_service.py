"""
Query Strategy Router — decides fast vs deep retrieval path based on query complexity.
Simple, readable, configurable rules — not an agent system.
"""

import logging
import os
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class RouteDecision:
    """Routing decision for a query."""

    def __init__(
        self,
        route: str,            # "fast" or "deep"
        reason: str,
        complexity: float,     # 0.0–1.0
        intent_count: int = 1,
        entity_count: int = 0,
    ):
        self.route = route
        self.reason = reason
        self.complexity = complexity
        self.intent_count = intent_count
        self.entity_count = entity_count

    def to_dict(self) -> Dict[str, Any]:
        return {
            "route": self.route,
            "reason": self.reason,
            "complexity": self.complexity,
            "intent_count": self.intent_count,
            "entity_count": self.entity_count,
        }


class QueryRouterService:
    """
    Routes queries to fast or deep retrieval path.
    Fast path: simple query → hybrid retrieval only (skip rewrite, skip rerank).
    Deep path: complex query → rewrite + hybrid + rerank.
    """

    # Endpoints that always use deep path (analysis-heavy)
    DEEP_ENDPOINTS = {"health", "agent"}

    # Endpoints preferring fast path (latency-sensitive)
    FAST_ENDPOINTS = {"scam", "podcast"}

    # Complexity thresholds
    COMPLEXITY_THRESHOLD = float(os.getenv("RAG_ROUTE_COMPLEXITY_THRESHOLD", "0.4"))

    # Multi-intent markers
    MULTI_INTENT_MARKERS = [
        r"(而且|還有|另外|同時|也|以及|並且|再加上|以及)",
        r"(and|also|plus|additionally|furthermore)",
        r"[?？].*[?？]",              # multiple questions
        r"(比較|對比|vs|versus)",     # comparison
        r"(優缺點|好壞|利弊|pros?.?cons?)",
    ]

    # Entity detection patterns
    ENTITY_PATTERNS = [
        r'\b(BTC|ETH|SOL|XRP|BNB|DOGE|USDT|USDC|ADA|TRX|AVAX)\b',
        r'(比特幣|以太幣|以太坊|索拉納|瑞波幣|幣安幣|狗狗幣|泰達幣)',
        r'(AI|RWA|DeFi|L2|NFT|Meme|Layer\s*[12])',
        r'(牛市|熊市|黑天鵝|bull|bear|black.?swan)',
    ]

    def __init__(self):
        pass

    # ── public API ────────────────────────────────────────────────

    def route(self, query: str, endpoint: str = "chat") -> RouteDecision:
        """
        Decide the retrieval strategy for a query.
        """
        # Endpoint-based overrides
        if endpoint in self.DEEP_ENDPOINTS:
            complexity = self._estimate_complexity(query)
            return RouteDecision(
                route="deep",
                reason=f"Endpoint '{endpoint}' requires deep analysis",
                complexity=max(complexity, 0.6),
                intent_count=self._count_intents(query),
                entity_count=self._count_entities(query),
            )

        if endpoint in self.FAST_ENDPOINTS:
            return RouteDecision(
                route="fast",
                reason=f"Endpoint '{endpoint}' prefers fast path",
                complexity=self._estimate_complexity(query),
                intent_count=1,
                entity_count=self._count_entities(query),
            )

        # Query-based routing
        complexity = self._estimate_complexity(query)
        intent_count = self._count_intents(query)
        entity_count = self._count_entities(query)
        query_len = len(query)

        if complexity >= self.COMPLEXITY_THRESHOLD:
            return RouteDecision(
                route="deep",
                reason=f"High complexity ({complexity:.2f}), {intent_count} intents",
                complexity=complexity,
                intent_count=intent_count,
                entity_count=entity_count,
            )

        # Short queries with many entities → deep (disambiguation needed)
        if entity_count >= 3:
            return RouteDecision(
                route="deep",
                reason=f"Multiple entities ({entity_count}) → deep for disambiguation",
                complexity=complexity,
                intent_count=intent_count,
                entity_count=entity_count,
            )

        # Default: fast
        return RouteDecision(
            route="fast",
            reason=f"Simple query (complexity={complexity:.2f}, len={query_len})",
            complexity=complexity,
            intent_count=intent_count,
            entity_count=entity_count,
        )

    # ── internal ──────────────────────────────────────────────────

    def _estimate_complexity(self, query: str) -> float:
        """Heuristic complexity score 0–1."""
        if not query:
            return 0.0

        score = 0.0
        qlen = len(query)

        # Length factor: short=simple, medium=normal, long=complex
        if qlen < 15:
            score += 0.0
        elif qlen < 50:
            score += 0.1
        elif qlen < 100:
            score += 0.3
        else:
            score += 0.5

        # Multi-intent markers
        for marker in self.MULTI_INTENT_MARKERS:
            if re.search(marker, query, re.IGNORECASE):
                score += 0.2
                break

        # Entity count
        entity_count = self._count_entities(query)
        score += min(entity_count * 0.1, 0.3)

        # Question complexity markers
        complex_markers = [
            r'(為什麼|原因|因素|影響|後果|效果)',
            r'(how|why|explain|analyze|compare)',
            r'(建議|推薦|應該|怎麼|如何|怎樣)',
            r'(策略|規劃|計畫|方案)',
        ]
        for marker in complex_markers:
            if re.search(marker, query, re.IGNORECASE):
                score += 0.1
                break

        return min(score, 1.0)

    def _count_intents(self, query: str) -> int:
        """Estimate number of distinct intents in query."""
        count = 1
        # Multiple questions
        qmarks = query.count("?") + query.count("？")
        if qmarks > 1:
            count = max(count, qmarks)

        # Comma-separated distinct topics
        segments = re.split(r"[，,;；、]", query)
        meaningful = [s.strip() for s in segments if len(s.strip()) > 5]
        if len(meaningful) > 2:
            count = max(count, len(meaningful) // 2)

        # Multi-intent markers
        for marker in self.MULTI_INTENT_MARKERS[:3]:
            if re.search(marker, query, re.IGNORECASE):
                count += 1
                break

        return min(count, 5)

    def _count_entities(self, query: str) -> int:
        """Count recognized entities in query."""
        found = set()
        for pattern in self.ENTITY_PATTERNS:
            for match in re.finditer(pattern, query, re.IGNORECASE):
                found.add(match.group(0).upper())
        return len(found)


# ── singleton ────────────────────────────────────────────────────

_router: Optional[QueryRouterService] = None


def get_router() -> QueryRouterService:
    global _router
    if _router is None:
        _router = QueryRouterService()
    return _router
