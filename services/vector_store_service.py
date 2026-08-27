"""
Vector Store Service — persistent local vector store using ChromaDB.
Stores chunk + metadata + embedding for dense retrieval.
Graceful fallback if ChromaDB is not installed or unavailable.
"""

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Runtime-generated cache.  Keep a schema namespace in the directory name so
# an older, incompatible Chroma cache cannot disable dense retrieval after an
# application upgrade.  The old cache is intentionally left untouched.
DEFAULT_VECTOR_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "vector_store_v2"

_chromadb_available = False
try:
    import chromadb
    from chromadb.config import Settings
    _chromadb_available = True
except ImportError:
    logger.info("ChromaDB not installed — vector store disabled (dense retrieval will fallback)")


class VectorStoreService:
    """
    Persistent vector store backed by ChromaDB.
    Supports: write chunks+embeddings, query by embedding, rebuild index.
    Falls back gracefully when ChromaDB is unavailable.
    """

    def __init__(self, persist_dir: Optional[Path] = None):
        configured_dir = os.getenv("RAG_VECTOR_DB_PATH") if persist_dir is None else None
        self._persist_dir = str(persist_dir or configured_dir or DEFAULT_VECTOR_DB_PATH)
        self._client: Any = None
        self._collection: Any = None
        self._available = _chromadb_available

        if self._available:
            self._init_client()

    # ── public API ────────────────────────────────────────────────

    @property
    def available(self) -> bool:
        return self._available and self._collection is not None

    def rebuild_index(
        self,
        chunks: List[Any],        # List[Chunk]
        embeddings: List[Optional[List[float]]],
    ) -> int:
        """
        Rebuild the entire vector index from chunks and their embeddings.
        Chunks with None embeddings are skipped.
        Returns count of indexed chunks.
        """
        if not self._available:
            logger.warning("Vector store unavailable — skipping index rebuild")
            return 0

        try:
            self._reset_collection()
            count = 0
            ids: List[str] = []
            docs: List[str] = []
            metas: List[Dict[str, Any]] = []
            embs: List[List[float]] = []

            for chunk, emb in zip(chunks, embeddings):
                if emb is None:
                    continue
                ids.append(chunk.chunk_id)
                docs.append(chunk.content)
                metas.append(chunk.metadata_dict())
                embs.append(emb)
                count += 1

            if ids:
                self._collection.add(ids=ids, documents=docs, metadatas=metas, embeddings=embs)
                logger.info("Vector store indexed %d chunks", count)

            return count
        except Exception as exc:
            logger.exception("Vector store rebuild failed: %s", exc)
            self._available = False
            return 0

    def query(
        self,
        query_embedding: List[float],
        top_k: int = 5,
        filter_topics: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Dense retrieval: query by embedding, return top_k results.
        Each result: {chunk_id, content, source, topic, section, score, metadata}.
        """
        if not self.available:
            return []

        try:
            where_filter = None
            if filter_topics:
                where_filter = {"topic": {"$in": filter_topics}}

            results = self._collection.query(
                query_embeddings=[query_embedding],
                n_results=top_k,
                where=where_filter,
                include=["documents", "metadatas", "distances"],
            )

            hits: List[Dict[str, Any]] = []
            if not results or not results.get("ids") or not results["ids"][0]:
                return hits

            for i, chunk_id in enumerate(results["ids"][0]):
                meta = (results["metadatas"][0] or [{}])[i] if i < len(results["metadatas"][0]) else {}
                distance = (results["distances"][0] or [0])[i] if i < len(results["distances"][0]) else 0.0
                doc = (results["documents"][0] or [""])[i] if i < len(results["documents"][0]) else ""

                hits.append({
                    "chunk_id": chunk_id,
                    "content": doc,
                    "source": meta.get("source", ""),
                    "topic": meta.get("topic", ""),
                    "section": meta.get("section", ""),
                    "score": _distance_to_score(distance),
                    "retrieval_method": "dense",
                    "metadata": meta,
                })

            return hits
        except Exception as exc:
            logger.warning("Vector store query failed: %s", exc)
            return []

    def delete_collection(self) -> bool:
        """Delete the collection (for rebuild)."""
        if not self._available or not self._client:
            return False
        try:
            self._client.delete_collection(name="knowledge_chunks")
            self._collection = None
            return True
        except Exception:
            return False

    # ── internal ──────────────────────────────────────────────────

    def _init_client(self):
        try:
            Path(self._persist_dir).mkdir(parents=True, exist_ok=True)
            self._client = chromadb.PersistentClient(
                path=self._persist_dir,
                settings=Settings(anonymized_telemetry=False),
            )
            self._collection = self._client.get_or_create_collection(
                name="knowledge_chunks",
                metadata={"hnsw:space": "cosine"},
            )
            logger.info("Vector store ready: %s (collection: %d docs)",
                        self._persist_dir, self._collection.count())
        except Exception as exc:
            logger.warning("Failed to initialize ChromaDB: %s", exc)
            self._available = False
            self._client = None
            self._collection = None

    def _reset_collection(self):
        try:
            self._client.delete_collection(name="knowledge_chunks")
        except Exception:
            pass
        self._collection = self._client.create_collection(
            name="knowledge_chunks",
            metadata={"hnsw:space": "cosine"},
        )


def _distance_to_score(distance: float) -> float:
    """Convert cosine distance (0=identical, 2=opposite) to similarity score (1=best, 0=worst)."""
    return max(0.0, 1.0 - distance / 2.0)


# ── singleton ────────────────────────────────────────────────────

_vector_store: Optional[VectorStoreService] = None


def get_vector_store() -> VectorStoreService:
    global _vector_store
    if _vector_store is None:
        _vector_store = VectorStoreService()
    return _vector_store
