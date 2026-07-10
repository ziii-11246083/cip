"""
Embedding Service — abstraction layer for text embeddings.
Uses OpenAI text-embedding-3-small by default.
Falls back gracefully when no API key or on any error.
Includes simple content-hash-based cache to avoid redundant API calls.
"""

import hashlib
import logging
import os
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
}


class EmbeddingService:
    """
    Manages text embeddings via OpenAI API.
    Stateless; caching is hash-based so identical content is never re-embedded
    within the same session.
    """

    def __init__(self, model: Optional[str] = None, api_key: Optional[str] = None):
        self._model = model or os.getenv("RAG_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)
        self._api_key = api_key or os.getenv("OPENAI_API_KEY", "").strip().strip('"').strip("'")
        self._dim = EMBEDDING_DIMS.get(self._model, 1536)
        self._cache: Dict[str, List[float]] = {}
        self._available: Optional[bool] = None
        self._client: Any = None

    # ── public API ────────────────────────────────────────────────

    @property
    def available(self) -> bool:
        """Check if embeddings are actually usable."""
        if self._available is None:
            if not self._api_key or "sk-" not in self._api_key:
                self._available = False
            else:
                try:
                    from openai import OpenAI
                    self._client = OpenAI(api_key=self._api_key)
                    self._available = True
                except Exception:
                    self._available = False
        return self._available

    @property
    def dimensions(self) -> int:
        return self._dim

    def embed_query(self, text: str) -> Optional[List[float]]:
        """Embed a single query. Returns None on failure."""
        return self._embed(text)

    def embed_chunks(self, texts: List[str], batch_size: int = 20) -> List[Optional[List[float]]]:
        """Embed a list of chunk texts. Returns list of embeddings (None for failures)."""
        results: List[Optional[List[float]]] = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            batch_results = self._embed_batch(batch)
            results.extend(batch_results)
        return results

    def similarity(self, a: List[float], b: List[float]) -> float:
        """Cosine similarity between two embeddings."""
        if not a or not b:
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    def cache_stats(self) -> Dict[str, int]:
        return {"cached_entries": len(self._cache)}

    # ── internal ──────────────────────────────────────────────────

    def _hash(self, text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def _embed(self, text: str) -> Optional[List[float]]:
        if not self.available:
            return None

        key = self._hash(text)
        if key in self._cache:
            return self._cache[key]

        try:
            resp = self._client.embeddings.create(model=self._model, input=text)
            emb = list(resp.data[0].embedding)
            self._cache[key] = emb
            return emb
        except Exception as exc:
            logger.warning("Embedding API call failed: %s", exc)
            self._available = False
            return None

    def _embed_batch(self, texts: List[str]) -> List[Optional[List[float]]]:
        results: List[Optional[List[float]]] = []
        uncached_texts: List[str] = []
        uncached_indices: List[int] = []

        for i, text in enumerate(texts):
            key = self._hash(text)
            if key in self._cache:
                results.append(self._cache[key])
            else:
                results.append(None)  # placeholder
                uncached_texts.append(text)
                uncached_indices.append(i)

        if not uncached_texts:
            return results

        if not self.available:
            return [None] * len(texts)

        try:
            resp = self._client.embeddings.create(model=self._model, input=uncached_texts)
            for j, data_item in enumerate(resp.data):
                emb = list(data_item.embedding)
                orig_idx = uncached_indices[j]
                results[orig_idx] = emb
                key = self._hash(uncached_texts[j])
                self._cache[key] = emb
        except Exception as exc:
            logger.warning("Batch embedding failed: %s", exc)
            self._available = False

        return results


# ── singleton ────────────────────────────────────────────────────

_embedding_service: Optional[EmbeddingService] = None


def get_embedding_service() -> EmbeddingService:
    global _embedding_service
    if _embedding_service is None:
        _embedding_service = EmbeddingService()
    return _embedding_service
