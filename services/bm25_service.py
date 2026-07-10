"""
BM25 Sparse Retrieval Service — upgraded keyword retrieval with TF-IDF scoring.
Uses rank-bm25 for BM25 ranking. Falls back to internal TF-IDF if rank-bm25 unavailable.
Chinese tokenization via jieba if available, otherwise regex-based tokenization.
"""

import logging
import math
import os
import re
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Optional dependencies
_jieba_available = False
try:
    import jieba
    _jieba_available = True
except ImportError:
    logger.info("jieba not installed — using regex-based Chinese tokenization")

_bm25_available = False
try:
    from rank_bm25 import BM25Okapi
    _bm25_available = True
except ImportError:
    logger.info("rank-bm25 not installed — using internal TF-IDF fallback")


# ── stop words ────────────────────────────────────────────────

_STOP_ZH = {
    "的", "是", "了", "在", "和", "也", "就", "都", "要", "會", "可以", "使用",
    "一個", "這個", "那個", "什麼", "怎麼", "為什麼", "如何", "因為", "所以",
    "如果", "但是", "而且", "或者", "雖然", "不過", "還是", "已經", "沒有",
    "一些", "很多", "比較", "非常", "真的", "可能", "應該", "一定",
}
_STOP_EN = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "it", "its", "this", "that", "these", "those", "and", "or", "but",
    "not", "no", "if", "then", "than", "so", "just", "about", "up", "out",
    "when", "who", "how", "what", "which", "where", "why", "all", "any",
    "both", "each", "few", "more", "most", "other", "some", "such", "only",
}


def tokenize(text: str) -> List[str]:
    """Tokenize mixed Chinese/English text."""
    if not text:
        return []

    tokens: List[str] = []

    if _jieba_available:
        # Use jieba for Chinese + extract English words
        words = list(jieba.cut(text.lower()))
        for w in words:
            w = w.strip()
            if not w:
                continue
            # jieba may split English words; extract alphanumeric tokens
            if re.match(r"^[a-z0-9_-]+$", w):
                if w not in _STOP_EN and len(w) > 1:
                    tokens.append(w)
            else:
                # Chinese token
                if w not in _STOP_ZH and len(w) > 0:
                    tokens.append(w)
    else:
        # Regex-based fallback
        raw = re.findall(r"[\w一-鿿]+", text.lower())
        for t in raw:
            if t in _STOP_EN or t in _STOP_ZH or len(t) <= 1:
                continue
            tokens.append(t)

    return tokens


class BM25Service:
    """
    BM25 sparse retrieval service.
    Maintains a tokenized corpus index aligned with chunk structure.
    Falls back to internal TF-IDF if rank-bm25 is unavailable.
    """

    def __init__(self):
        self._corpus: List[Dict[str, Any]] = []       # chunk dicts
        self._tokenized: List[List[str]] = []          # tokenized corpus
        self._bm25: Any = None                         # BM25Okapi instance
        self._idf: Optional[Dict[str, float]] = None   # internal TF-IDF fallback
        self._avg_dl: float = 0.0
        self._available = False

    # ── public API ────────────────────────────────────────────────

    @property
    def available(self) -> bool:
        return self._available

    @property
    def corpus_size(self) -> int:
        return len(self._corpus)

    def build_index(self, chunks: List[Any]) -> int:
        """
        Build BM25 index from chunks.
        chunks: List of Chunk objects (from chunking_service).
        Returns number of indexed chunks.
        """
        self._corpus = [c.to_dict() for c in chunks]
        self._tokenized = [tokenize(c.content) for c in chunks]

        non_empty = [(i, t) for i, t in enumerate(self._tokenized) if t]
        if not non_empty:
            logger.warning("No tokenizable content in chunks, BM25 index empty")
            self._available = False
            return 0

        # Filter corpus to non-empty
        indices = [i for i, _ in non_empty]
        self._corpus = [self._corpus[i] for i in indices]
        self._tokenized = [self._tokenized[i] for i in indices]

        if _bm25_available and self._tokenized:
            try:
                self._bm25 = BM25Okapi(self._tokenized)
                self._available = True
                logger.info("BM25 index built: %d docs", len(self._tokenized))
                return len(self._tokenized)
            except Exception as exc:
                logger.warning("BM25Okapi failed, using TF-IDF fallback: %s", exc)

        # Internal TF-IDF fallback
        self._build_tfidf()
        self._available = self._idf is not None and len(self._idf) > 0
        logger.info("TF-IDF index built (fallback): %d docs, %d terms",
                     len(self._tokenized), len(self._idf or {}))
        return len(self._tokenized)

    def search(
        self,
        query: str,
        top_k: int = 10,
        filter_topics: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Search the sparse index for a query.
        Returns list of {chunk_id, content, source, topic, section, score, retrieval_method, metadata}.
        """
        if not self._available:
            return []

        query_tokens = tokenize(query)
        if not query_tokens:
            return []

        if self._bm25 is not None:
            scores = self._bm25.get_scores(query_tokens)
        else:
            scores = self._tfidf_scores(query_tokens)

        # Build ranked results
        ranked: List[Tuple[int, float]] = []
        for i, score in enumerate(scores):
            if score <= 0:
                continue
            if filter_topics and self._corpus[i].get("topic") not in filter_topics:
                continue
            ranked.append((i, float(score)))

        ranked.sort(key=lambda x: x[1], reverse=True)
        ranked = ranked[:top_k]

        # Normalize scores to [0, 1] for fusion
        max_score = max((s for _, s in ranked), default=1.0)

        results: List[Dict[str, Any]] = []
        for idx, score in ranked:
            chunk = self._corpus[idx]
            results.append({
                "chunk_id": chunk.get("chunk_id", ""),
                "content": chunk.get("content", ""),
                "source": chunk.get("source", ""),
                "topic": chunk.get("topic", ""),
                "section": chunk.get("section", ""),
                "score": score / max_score if max_score > 0 else 0.0,
                "retrieval_method": "sparse",
                "metadata": chunk,
            })

        return results

    # ── internal TF-IDF ───────────────────────────────────────────

    def _build_tfidf(self):
        """Build internal TF-IDF index."""
        self._idf = {}
        N = len(self._tokenized)
        if N == 0:
            return

        # Document frequency
        df: Dict[str, int] = defaultdict(int)
        doc_lengths: List[int] = []
        for tokens in self._tokenized:
            doc_lengths.append(len(tokens))
            for term in set(tokens):
                df[term] += 1

        self._avg_dl = sum(doc_lengths) / N if N > 0 else 0

        # IDF
        for term, count in df.items():
            self._idf[term] = math.log((N - count + 0.5) / (count + 0.5) + 1.0)

    def _tfidf_scores(self, query_tokens: List[str]) -> List[float]:
        """Score all docs against query tokens using TF-IDF."""
        if not self._idf:
            return [0.0] * len(self._tokenized)

        scores: List[float] = []
        k1 = 1.2
        b = 0.75

        for doc_tokens in self._tokenized:
            score = 0.0
            dl = len(doc_tokens)
            tf_map: Dict[str, int] = defaultdict(int)
            for t in doc_tokens:
                tf_map[t] += 1

            for qt in query_tokens:
                idf = self._idf.get(qt, 0.0)
                if idf == 0:
                    continue
                tf = tf_map.get(qt, 0)
                if tf == 0:
                    continue
                # BM25-like scoring
                numerator = tf * (k1 + 1)
                denominator = tf + k1 * (1 - b + b * dl / max(self._avg_dl, 1))
                score += idf * numerator / denominator

            scores.append(score)

        return scores


# ── singleton ────────────────────────────────────────────────────

_bm25_service: Optional[BM25Service] = None


def get_bm25() -> BM25Service:
    global _bm25_service
    if _bm25_service is None:
        _bm25_service = BM25Service()
    return _bm25_service
