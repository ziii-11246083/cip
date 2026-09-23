"""
Reranker Service — lightweight pluggable reranker interface.
Default backend: score fusion + metadata boosting + lexical overlap re-scoring.
No heavy model dependency. cross-encoder backend is optional and off by default.
"""

import logging
import os
import re
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class RerankerService:
    """
    Reranker with pluggable backend.
    Default: lightweight score-based rerank (fusion_score + metadata_boost + lexical_overlap).
    Optional: cross-encoder (requires config flag, not loaded by default).
    """

    def __init__(self, backend: Optional[str] = None):
        self._backend = backend or os.getenv("RAG_RERANK_BACKEND", "lightweight")
        self._cross_encoder: Any = None

    # ── public API ────────────────────────────────────────────────

    @property
    def available(self) -> bool:
        return True  # lightweight always available

    def rerank(
        self,
        query: str,
        candidates: List[Dict[str, Any]],
        top_k: int = 3,
    ) -> List[Dict[str, Any]]:
        """
        Rerank candidate chunks for a query.
        Each candidate must have: content, score, topic, section, source.
        Returns top_k reranked results with adjusted scores.
        """
        if not candidates:
            return []

        if self._backend == "cross-encoder" and self._cross_encoder_available:
            return self._cross_encoder_rerank(query, candidates, top_k)

        return self._lightweight_rerank(query, candidates, top_k)

    # ── lightweight rerank ────────────────────────────────────────

    def _lightweight_rerank(
        self, query: str, candidates: List[Dict[str, Any]], top_k: int
    ) -> List[Dict[str, Any]]:
        """Score-based rerank: fusion score + metadata boost + lexical overlap."""
        query_lower = query.lower()
        query_terms = set(re.findall(r"[\w一-鿿]+", query_lower))

        for c in candidates:
            base_score = c.get("score", 0.0)
            content = c.get("content", "")
            content_lower = content.lower()
            topic = c.get("topic", "")

            # Lexical overlap bonus
            content_terms = set(re.findall(r"[\w一-鿿]+", content_lower))
            if query_terms:
                overlap = len(query_terms & content_terms) / len(query_terms)
            else:
                overlap = 0.0
            lexical_bonus = min(overlap * 0.2, 0.2)

            # Metadata boost: prefer certain topics for certain query signals
            meta_boost = 0.0
            if _is_scam_query(query_lower) and topic == "詐騙模式":
                meta_boost += 0.15
            if _is_health_query(query_lower) and topic in ("健康度檢查", "投資原則"):
                meta_boost += 0.10
            if _is_market_query(query_lower) and topic in ("市場敘事", "市場情境"):
                meta_boost += 0.10
            if _is_investment_query(query_lower) and topic == "投資原則":
                meta_boost += 0.10

            # Source freshness bonus (placeholder — could use last_updated)
            freshness_bonus = 0.0

            # Section heading match bonus
            heading_bonus = 0.0
            section = c.get("section", "").lower()
            for term in query_terms:
                if term.lower() in section:
                    heading_bonus += 0.03

            final_score = base_score + lexical_bonus + meta_boost + freshness_bonus + heading_bonus
            c["original_score"] = base_score
            c["score"] = round(min(final_score, 1.0), 4)
            c["rerank_details"] = {
                "lexical_bonus": round(lexical_bonus, 3),
                "meta_boost": round(meta_boost, 3),
                "heading_bonus": round(heading_bonus, 3),
            }

        # Sort by adjusted score
        candidates.sort(key=lambda x: x.get("score", 0), reverse=True)
        return candidates[:top_k]

    # ── cross-encoder (optional) ──────────────────────────────────

    @property
    def _cross_encoder_available(self) -> bool:
        if self._cross_encoder is not None:
            return True
        try:
            # Lazy load — don't import unless configured
            if os.getenv("RAG_RERANK_CROSS_ENCODER_MODEL", ""):
                from sentence_transformers import CrossEncoder
                model_name = os.getenv("RAG_RERANK_CROSS_ENCODER_MODEL", "")
                self._cross_encoder = CrossEncoder(model_name)
                logger.info("Cross-encoder loaded: %s", model_name)
                return True
        except ImportError:
            logger.info("sentence-transformers not installed — cross-encoder unavailable")
        except Exception as exc:
            logger.warning("Failed to load cross-encoder: %s", exc)
        return False

    def _cross_encoder_rerank(
        self, query: str, candidates: List[Dict[str, Any]], top_k: int
    ) -> List[Dict[str, Any]]:
        """Cross-encoder reranking."""
        if not self._cross_encoder:
            return self._lightweight_rerank(query, candidates, top_k)

        try:
            pairs = [(query, c.get("content", "")) for c in candidates]
            scores = self._cross_encoder.predict(pairs)

            for i, c in enumerate(candidates):
                c["original_score"] = c.get("score", 0.0)
                c["score"] = round(float(scores[i]), 4)

            candidates.sort(key=lambda x: x.get("score", 0), reverse=True)
            return candidates[:top_k]
        except Exception as exc:
            logger.warning("Cross-encoder rerank failed, fallback to lightweight: %s", exc)
            return self._lightweight_rerank(query, candidates, top_k)


# ── query signal helpers ──────────────────────────────────────

def _is_scam_query(query: str) -> bool:
    signals = ["詐騙", "scam", "騙", "honeypot", "rug", "釣魚", "假", "可疑", "安全"]
    return any(s in query for s in signals)


def _is_health_query(query: str) -> bool:
    signals = ["配置", "組合", "健康", "集中", "波動", "回撤", "持倉", "分散", "佔比"]
    return any(s in query for s in signals)


def _is_market_query(query: str) -> bool:
    signals = ["市場", "行情", "牛市", "熊市", "趨勢", "走勢", "大盤", "market", "bull", "bear"]
    return any(s in query for s in signals)


def _is_investment_query(query: str) -> bool:
    signals = ["投資", "進場", "出場", "買", "賣", "策略", "配置", "比例", "DCA", "停損", "停利"]
    return any(s in query for s in signals)


# ── singleton ────────────────────────────────────────────────────

_reranker: Optional[RerankerService] = None


def get_reranker() -> RerankerService:
    global _reranker
    if _reranker is None:
        _reranker = RerankerService()
    return _reranker
