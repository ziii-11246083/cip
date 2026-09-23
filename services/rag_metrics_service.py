"""
RAG Metrics Service — observability layer for RAG pipeline.
Logs structured metrics per RAG call. Lightweight: file-based JSON Lines output.
Architecture-ready for future DB integration.
"""

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from services.rag_trace_service import sanitize_text

logger = logging.getLogger(__name__)

METRICS_DIR = Path(__file__).resolve().parent.parent / "data" / "rag_metrics"
METRICS_FILE = METRICS_DIR / "rag_metrics.jsonl"

# In-memory ring buffer for recent metrics (avoids disk I/O on every call)
_RING_SIZE = 200
_metrics_buffer: List[Dict[str, Any]] = []


class RAGMetricsService:
    """
    Collects and records RAG pipeline metrics.
    Thread-safe for Flask's multi-threaded mode via the GIL.
    """

    def __init__(self, enabled: Optional[bool] = None):
        self._enabled = enabled if enabled is not None else (
            os.getenv("RAG_DEBUG_LOGGING", "0") == "1"
        )

    # ── public API ────────────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        return self._enabled

    def log_call(self, record: Dict[str, Any]) -> None:
        """Log a complete RAG call record."""
        if not self._enabled:
            return

        # Add timestamp
        record.setdefault("timestamp", time.time())

        # In-memory buffer
        global _metrics_buffer
        _metrics_buffer.append(record)
        if len(_metrics_buffer) > _RING_SIZE:
            _metrics_buffer = _metrics_buffer[-_RING_SIZE:]

        # Also write to file (append-only)
        try:
            METRICS_DIR.mkdir(parents=True, exist_ok=True)
            with open(METRICS_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as exc:
            logger.debug("Failed to write metrics: %s", exc)

    def get_recent(self, n: int = 20) -> List[Dict[str, Any]]:
        """Get the most recent n records from the in-memory buffer."""
        return _metrics_buffer[-n:]

    def get_stats(self, endpoint: Optional[str] = None) -> Dict[str, Any]:
        """Get aggregate stats from recent records."""
        records = _metrics_buffer
        if endpoint:
            records = [r for r in records if r.get("endpoint") == endpoint]

        if not records:
            return {"count": 0}

        latencies = [r.get("total_rag_latency_ms", 0) for r in records if r.get("total_rag_latency_ms")]
        fallbacks = sum(1 for r in records if r.get("fallback_reason"))
        empty = sum(1 for r in records if r.get("empty_context"))
        routes = {"fast": 0, "deep": 0}
        for r in records:
            rt = r.get("route_type", "")
            if rt in routes:
                routes[rt] += 1

        return {
            "count": len(records),
            "avg_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else 0,
            "max_latency_ms": max(latencies) if latencies else 0,
            "fallback_rate": round(fallbacks / len(records), 3),
            "empty_context_rate": round(empty / len(records), 3),
            "route_distribution": routes,
            "avg_sparse_hits": round(
                sum(r.get("sparse_hit_count", 0) for r in records) / len(records), 1
            ),
            "avg_dense_hits": round(
                sum(r.get("dense_hit_count", 0) for r in records) / len(records), 1
            ),
            "avg_final_context_count": round(
                sum(r.get("final_context_count", 0) for r in records) / len(records), 1
            ),
        }

    def build_record(
        self,
        endpoint: str = "",
        query: str = "",
        route_type: str = "",
        rewrite_result: Optional[Dict[str, Any]] = None,
        sparse_hit_count: int = 0,
        dense_hit_count: int = 0,
        final_context_count: int = 0,
        top_sources: Optional[List[str]] = None,
        retrieval_latency_ms: float = 0.0,
        rerank_latency_ms: float = 0.0,
        total_rag_latency_ms: float = 0.0,
        fallback_reason: str = "",
        empty_context: bool = False,
    ) -> Dict[str, Any]:
        """Build a standardized metrics record."""
        return {
            "endpoint": endpoint,
            # 安全化後才落盤（TASK 02）：raw query 不進入 legacy metrics/JSONL
            "query": sanitize_text(query, max_len=200),
            "route_type": route_type,
            "rewrite_used": rewrite_result.get("used", False) if rewrite_result else False,
            "rewrite_rejected": rewrite_result.get("rejected", False) if rewrite_result else False,
            "rewrite_similarity": rewrite_result.get("similarity", 1.0) if rewrite_result else 1.0,
            "sparse_hit_count": sparse_hit_count,
            "dense_hit_count": dense_hit_count,
            "final_context_count": final_context_count,
            "top_sources": (top_sources or [])[:5],
            "retrieval_latency_ms": round(retrieval_latency_ms, 1),
            "rerank_latency_ms": round(rerank_latency_ms, 1),
            "total_rag_latency_ms": round(total_rag_latency_ms, 1),
            "fallback_reason": fallback_reason,
            "empty_context": empty_context,
            "timestamp": time.time(),
        }


# ── singleton ────────────────────────────────────────────────────

_metrics: Optional[RAGMetricsService] = None


def get_metrics() -> RAGMetricsService:
    global _metrics
    if _metrics is None:
        _metrics = RAGMetricsService()
    return _metrics
