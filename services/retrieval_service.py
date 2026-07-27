"""
Retrieval Service — hybrid retrieval pipeline.
Combines: BM25 sparse + dense (embeddings/vector store) + RRF fusion + reranker.
Graceful fallback chain: hybrid → sparse-only → keyword-only.
Backward-compatible public API.
"""

import logging
import os
import time
from typing import Any, Dict, List, Optional

from services.knowledge_base import KnowledgeBase, get_kb

logger = logging.getLogger(__name__)

# ── config defaults ───────────────────────────────────────────
_RRF_K = int(os.getenv("RAG_RRF_K", "60"))
_DENSE_WEIGHT = float(os.getenv("RAG_DENSE_WEIGHT", "0.5"))
_SPARSE_WEIGHT = float(os.getenv("RAG_SPARSE_WEIGHT", "0.5"))
_TOP_K_SPARSE = int(os.getenv("RAG_TOP_K_SPARSE", "10"))
_TOP_K_DENSE = int(os.getenv("RAG_TOP_K_DENSE", "10"))
_TOP_K_FINAL = int(os.getenv("RAG_TOP_K_FINAL", "5"))
_ENABLE_EMBEDDINGS = os.getenv("RAG_ENABLE_EMBEDDINGS", "1") == "1"
_ENABLE_VECTOR_STORE = os.getenv("RAG_ENABLE_VECTOR_STORE", "1") == "1"
_ENABLE_RERANK = os.getenv("RAG_ENABLE_RERANK", "1") == "1"


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
    Hybrid retrieval: BM25 sparse + dense (embeddings via vector store).
    Falls back gracefully:
      hybrid → sparse (BM25) → keyword (legacy KnowledgeBase)
    Uses Reciprocal Rank Fusion (RRF) for combining sparse + dense results.
    """

    def __init__(self, kb: Optional[KnowledgeBase] = None):
        self._kb = kb or get_kb()
        self._bm25: Any = None
        self._vector_store: Any = None
        self._embedding: Any = None
        self._reranker: Any = None
        self._initialized = False

        # Lazy init on first use
        self._bm25_available = False
        self._dense_available = False
        self._reranker_available = False

    # ── public API (backward compatible) ───────────────────────

    def retrieve(
        self,
        query: str,
        topics: Optional[List[str]] = None,
        max_results: int = 3,
    ) -> List[RetrievalResult]:
        """
        Main retrieval entry point. Uses hybrid pipeline when available.
        Falls back to keyword when components are unavailable.
        """
        self._ensure_init()

        # Try hybrid path
        if self._bm25_available or self._dense_available:
            try:
                return self._hybrid_retrieve(query, topics, max_results)
            except Exception as exc:
                logger.warning("Hybrid retrieval failed, falling back to keyword: %s", exc)

        # Fallback: legacy keyword retrieval
        return self._keyword_retrieve(query, topics, max_results)

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

    def retrieve_with_meta(
        self,
        query: str,
        topics: Optional[List[str]] = None,
        max_results: int = 5,
    ) -> Dict[str, Any]:
        """
        Extended retrieval returning results + metadata about the retrieval process.
        Used by RAG metrics pipeline.
        Returns: {results, sparse_hits, dense_hits, final_count, method}.
        """
        self._ensure_init()

        sparse_hits: List[Dict[str, Any]] = []
        dense_hits: List[Dict[str, Any]] = []
        method = "keyword"

        # Sparse retrieval
        if self._bm25_available:
            try:
                sparse_hits = self._bm25.search(query, top_k=_TOP_K_SPARSE, filter_topics=topics)
            except Exception as exc:
                logger.warning("BM25 search failed: %s", exc)

        # Dense retrieval
        if self._dense_available and _ENABLE_EMBEDDINGS:
            try:
                q_emb = self._embedding.embed_query(query)
                if q_emb:
                    dense_hits = self._vector_store.query(
                        q_emb, top_k=_TOP_K_DENSE, filter_topics=topics
                    )
            except Exception as exc:
                logger.warning("Dense retrieval failed: %s", exc)

        # Merge
        if sparse_hits or dense_hits:
            method = "hybrid" if (sparse_hits and dense_hits) else ("sparse" if sparse_hits else "dense")
            merged = _rrf_fusion(sparse_hits, dense_hits, k=_RRF_K, top_k=max_results * 2)

            # Rerank
            if self._reranker_available and _ENABLE_RERANK and len(merged) > max_results:
                try:
                    merged = self._reranker.rerank(query, merged, top_k=max_results)
                except Exception as exc:
                    logger.warning("Rerank failed: %s", exc)
            else:
                merged = merged[:max_results]

            results = [_hit_to_result(h) for h in merged]
        else:
            results = self._keyword_retrieve(query, topics, max_results)

        return {
            "results": results,
            "sparse_hit_count": len(sparse_hits),
            "dense_hit_count": len(dense_hits),
            "final_context_count": len(results),
            "method": method,
            "sparse_hits": sparse_hits,
            "dense_hits": dense_hits,
        }

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
        marker = f"## {scenario_key.replace('_', ' ').title()}"
        if marker.lower() not in section.lower():
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

        rest = section[idx + len(marker):]
        next_h2 = rest.find("\n## ")
        block = rest[:next_h2] if next_h2 > 0 else rest[:600]
        return {"scenario": scenario_key, "context": block.strip()[:600]}

    def rebuild_index(self) -> int:
        """
        Full index rebuild: chunk → embed → vector store + BM25.
        Returns total chunks indexed.
        """
        from services.chunking_service import get_all_chunks
        from services.embedding_service import get_embedding_service

        chunks = get_all_chunks(force_rebuild=True)
        logger.info("Rebuilding index with %d chunks", len(chunks))

        # BM25
        self._ensure_bm25()
        bm25_count = 0
        if self._bm25:
            bm25_count = self._bm25.build_index(chunks)

        # Vector store
        vs_count = 0
        emb_svc = get_embedding_service()
        if emb_svc.available and _ENABLE_VECTOR_STORE:
            self._ensure_vector_store()
            if self._vector_store and self._vector_store.available:
                texts = [c.content for c in chunks]
                embeddings = emb_svc.embed_chunks(texts)
                vs_count = self._vector_store.rebuild_index(chunks, embeddings)

        logger.info("Index rebuild done: BM25=%d, Vector=%d", bm25_count, vs_count)
        return max(bm25_count, vs_count)

    # ── internal ───────────────────────────────────────────────

    def _ensure_init(self):
        if self._initialized:
            return
        self._initialized = True

        if _ENABLE_EMBEDDINGS:
            self._ensure_embedding()
        self._ensure_bm25()
        if _ENABLE_VECTOR_STORE:
            self._ensure_vector_store()
        self._ensure_reranker()

    def _ensure_embedding(self):
        try:
            from services.embedding_service import get_embedding_service
            self._embedding = get_embedding_service()
            if self._embedding.available:
                logger.info("Embedding service ready")
        except Exception as exc:
            logger.warning("Embedding service init failed: %s", exc)

    def _ensure_bm25(self):
        try:
            from services.bm25_service import get_bm25
            from services.chunking_service import get_all_chunks
            self._bm25 = get_bm25()
            if not self._bm25.available:
                # Build index on first use
                chunks = get_all_chunks()
                if chunks:
                    self._bm25.build_index(chunks)
            self._bm25_available = self._bm25.available
            if self._bm25_available:
                logger.info("BM25 service ready: %d docs", self._bm25.corpus_size)
        except Exception as exc:
            logger.warning("BM25 service init failed: %s", exc)
            self._bm25_available = False

    def _ensure_vector_store(self):
        try:
            from services.vector_store_service import get_vector_store
            from services.chunking_service import get_all_chunks
            from services.embedding_service import get_embedding_service
            self._vector_store = get_vector_store()
            self._dense_available = self._vector_store.available and (
                self._embedding is not None and self._embedding.available
            )

            # If vector store exists but has no chunks, auto-rebuild
            if self._dense_available and self._vector_store._collection:
                try:
                    count = self._vector_store._collection.count()
                    if count == 0:
                        logger.info("Vector store empty — auto-building index")
                        chunks = get_all_chunks()
                        emb_svc = get_embedding_service()
                        if emb_svc.available:
                            texts = [c.content for c in chunks]
                            embeddings = emb_svc.embed_chunks(texts)
                            self._vector_store.rebuild_index(chunks, embeddings)
                except Exception:
                    pass

            if self._dense_available:
                logger.info("Vector store ready")
        except Exception as exc:
            logger.warning("Vector store init failed: %s", exc)
            self._dense_available = False

    def _ensure_reranker(self):
        try:
            from services.reranker_service import get_reranker
            self._reranker = get_reranker()
            self._reranker_available = self._reranker.available
        except Exception as exc:
            logger.warning("Reranker init failed: %s", exc)
            self._reranker_available = False

    def _hybrid_retrieve(
        self, query: str, topics: Optional[List[str]], max_results: int
    ) -> List[RetrievalResult]:
        """Full hybrid retrieval with sparse + dense + rerank."""
        result = self.retrieve_with_meta(query, topics=topics, max_results=max_results)
        return result["results"]

    def _keyword_retrieve(
        self, query: str, topics: Optional[List[str]], max_results: int
    ) -> List[RetrievalResult]:
        """Legacy keyword retrieval (fallback)."""
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
                metadata={"section": item.get("section", ""), "method": "keyword"},
            ))

        return results[:max_results]


# ── RRF fusion ────────────────────────────────────────────────

def _rrf_fusion(
    sparse_hits: List[Dict[str, Any]],
    dense_hits: List[Dict[str, Any]],
    k: int = 60,
    top_k: int = 10,
) -> List[Dict[str, Any]]:
    """
    Reciprocal Rank Fusion: combines sparse and dense rankings.
    Returns merged list sorted by RRF score descending.
    """
    scores: Dict[str, float] = {}
    hits_map: Dict[str, Dict[str, Any]] = {}

    for rank, hit in enumerate(sparse_hits):
        cid = hit.get("chunk_id", f"sparse_{rank}")
        rrf = 1.0 / (k + rank + 1)
        scores[cid] = scores.get(cid, 0.0) + rrf * _SPARSE_WEIGHT
        hits_map[cid] = hit

    for rank, hit in enumerate(dense_hits):
        cid = hit.get("chunk_id", f"dense_{rank}")
        rrf = 1.0 / (k + rank + 1)
        scores[cid] = scores.get(cid, 0.0) + rrf * _DENSE_WEIGHT
        if cid not in hits_map:
            hits_map[cid] = hit

    # Normalize
    max_score = max(scores.values()) if scores else 1.0
    merged: List[Dict[str, Any]] = []
    for cid, rrf_score in sorted(scores.items(), key=lambda x: x[1], reverse=True):
        hit = hits_map[cid].copy()
        hit["score"] = round(rrf_score / max_score, 4) if max_score > 0 else 0.0
        hit["retrieval_method"] = "hybrid_rrf"
        merged.append(hit)

    return merged[:top_k]


def _hit_to_result(hit: Dict[str, Any]) -> RetrievalResult:
    """Convert a hit dict to RetrievalResult."""
    return RetrievalResult(
        snippet=hit.get("content", "")[:500],
        source=hit.get("source", ""),
        topic=hit.get("topic", ""),
        score=hit.get("score", 0.0),
        metadata={
            "chunk_id": hit.get("chunk_id", ""),
            "section": hit.get("section", ""),
            "method": hit.get("retrieval_method", ""),
        },
    )


# ── singleton ────────────────────────────────────────────────

_retrieval: Optional[RetrievalService] = None


def get_retrieval() -> RetrievalService:
    global _retrieval
    if _retrieval is None:
        _retrieval = RetrievalService()
    return _retrieval
