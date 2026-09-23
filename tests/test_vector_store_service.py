import logging
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.vector_store_service import VectorStoreService


class _Chunk:
    def __init__(self, chunk_id: str, content: str, topic: str):
        self.chunk_id = chunk_id
        self.content = content
        self._topic = topic

    def metadata_dict(self):
        return {
            "source": "qa.md",
            "topic": self._topic,
            "section": "quality-gate",
        }


class VectorStoreServiceTests(unittest.TestCase):
    def test_clean_store_rebuild_and_query(self):
        chunks = [
            _Chunk("bitcoin", "Bitcoin basics", "general"),
            _Chunk("scam", "Scam warning", "scam"),
        ]
        embeddings = [[1.0, 0.0], [0.0, 1.0]]

        temp_dir = self.enterContext(tempfile.TemporaryDirectory())
        with self.assertNoLogs(level=logging.ERROR):
            store = VectorStoreService(Path(temp_dir))
            if store._client is not None:
                # Chroma 0.5 owns SQLite/index handles that Windows cannot unlink.
                # Cleanups run in reverse order: stop the client before the directory.
                self.addCleanup(store._client._system.stop)
            self.assertTrue(store.available)
            self.assertEqual(store.rebuild_index(chunks, embeddings), 2)
            hits = store.query([1.0, 0.0], top_k=1)

        self.assertEqual([hit["chunk_id"] for hit in hits], ["bitcoin"])

    def test_environment_path_is_used_when_no_explicit_path_is_given(self):
        temp_dir = self.enterContext(tempfile.TemporaryDirectory())
        with patch.dict(os.environ, {"RAG_VECTOR_DB_PATH": temp_dir}):
            store = VectorStoreService()
        if store._client is not None:
            self.addCleanup(store._client._system.stop)

        self.assertTrue(store.available)
        self.assertEqual(Path(store._persist_dir), Path(temp_dir))


if __name__ == "__main__":
    unittest.main()
