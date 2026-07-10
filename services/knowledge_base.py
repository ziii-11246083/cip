"""
Knowledge Base Loader — reads local markdown/json knowledge files
into structured in-memory store. MVP: file-based, no vector DB.
Ready for upgrade to embeddings/chunking pipeline.
"""

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

KNOWLEDGE_DIR = Path(__file__).resolve().parent.parent / "data" / "knowledge"


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception as exc:
        logger.warning("Failed to read %s: %s", path.name, exc)
        return ""


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed to parse %s: %s", path.name, exc)
        return {}


class KnowledgeBase:
    """In-memory knowledge base — loads all files under data/knowledge/."""

    def __init__(self, base_dir: Optional[Path] = None):
        self._dir = base_dir or KNOWLEDGE_DIR
        self._sections: Dict[str, str] = {}
        self._json_data: Dict[str, Any] = {}
        self._loaded = False

    # ── public API ──────────────────────────────────────────────

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load_all(self) -> bool:
        """Load all .md and .json files from the knowledge directory."""
        if not self._dir.exists():
            logger.warning("Knowledge directory not found: %s", self._dir)
            self._loaded = True
            return True

        try:
            self._sections.clear()
            self._json_data.clear()

            for path in sorted(self._dir.glob("*.md")):
                key = path.stem
                self._sections[key] = _read_text(path)

            for path in sorted(self._dir.glob("*.json")):
                key = path.stem
                self._json_data[key] = _read_json(path)

            self._loaded = True
            logger.info(
                "Knowledge base loaded: %d md sections, %d json files",
                len(self._sections),
                len(self._json_data),
            )
            return True
        except Exception as exc:
            logger.exception("Knowledge base load failed: %s", exc)
            self._loaded = True
            return False

    def get_section(self, name: str) -> Optional[str]:
        """Return raw markdown text of a named section."""
        return self._sections.get(name)

    def get_json(self, name: str) -> Optional[Dict[str, Any]]:
        """Return parsed JSON data."""
        return self._json_data.get(name)

    def search_keywords(self, query: str, max_sections: int = 3) -> List[Dict[str, Any]]:
        """
        Simple keyword-match retrieval across all markdown sections.
        Returns list of {section, snippet, score} dicts.
        """
        if not self._sections:
            return []

        terms = _tokenize(query)
        if not terms:
            return []

        scored: List[Dict[str, Any]] = []
        for name, text in self._sections.items():
            score = 0
            matched_lines: List[str] = []
            for term in terms:
                count = text.lower().count(term.lower())
                if count:
                    score += min(count, 5)  # cap per-term contribution

            if score > 0:
                # pull best snippet (first paragraph containing any term)
                for para in text.split("\n\n"):
                    if any(t.lower() in para.lower() for t in terms):
                        clean = para.strip().replace("\n", " ")[:300]
                        matched_lines.append(clean)
                        if len(matched_lines) >= 2:
                            break

                scored.append({
                    "section": name,
                    "snippets": matched_lines[:2],
                    "score": score,
                    "topic": _topic_from_name(name),
                })

        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:max_sections]

    def list_sections(self) -> List[str]:
        return sorted(self._sections.keys())

    def get_all_for_indexing(self) -> Dict[str, Any]:
        """
        Return all knowledge data for index rebuild.
        Returns {md_sections: {name: text}, json_data: {name: data}}.
        """
        return {
            "md_sections": dict(self._sections),
            "json_data": dict(self._json_data),
        }

    def get_section_metadata(self, name: str) -> Dict[str, Any]:
        """Return metadata for a section (for chunking pipeline)."""
        text = self._sections.get(name, "")
        return {
            "doc_id": name,
            "source": f"data/knowledge/{name}.md",
            "topic": _topic_from_name(name),
            "content": text,
            "doc_type": "markdown",
        }

    def get_json_metadata(self, name: str) -> Dict[str, Any]:
        """Return metadata for a JSON knowledge file."""
        data = self._json_data.get(name, {})
        return {
            "doc_id": name,
            "source": f"data/knowledge/{name}.json",
            "topic": _topic_from_name(name),
            "content": data,
            "doc_type": "json",
        }

    # ── coin-specific helpers ───────────────────────────────────

    def coin_profile(self, symbol: str) -> Optional[Dict[str, Any]]:
        profiles = self._json_data.get("coin_profiles", {})
        return profiles.get(symbol.upper())

    def coin_narrative(self, symbol: str) -> List[str]:
        profile = self.coin_profile(symbol)
        return profile.get("narrative_tags", []) if profile else []

    def coin_risks(self, symbol: str) -> List[str]:
        profile = self.coin_profile(symbol)
        return profile.get("typical_risks", []) if profile else []


# ── helpers ─────────────────────────────────────────────────

def _tokenize(text: str) -> List[str]:
    """Extract meaningful tokens for keyword matching."""
    tokens = re.findall(r"[\w一-鿿]+", text.lower())
    stop = {
        "的", "是", "了", "在", "和", "也", "就", "都", "要", "會", "可以", "使用",
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "can", "shall", "to", "of", "in", "for",
        "on", "with", "at", "by", "from", "as", "into", "through", "during",
    }
    return [t for t in tokens if t not in stop and len(t) > 1]


def _topic_from_name(name: str) -> str:
    mapping = {
        "investment_rules": "投資原則",
        "risk_health_guide": "健康度檢查",
        "scam_patterns": "詐騙模式",
        "market_narratives": "市場敘事",
        "scenario_playbooks": "市場情境",
        "podcast_style_guide": "Podcast風格",
    }
    return mapping.get(name, name)


# ── singleton ────────────────────────────────────────────────

_kb: Optional[KnowledgeBase] = None


def get_kb() -> KnowledgeBase:
    global _kb
    if _kb is None:
        _kb = KnowledgeBase()
        _kb.load_all()
    return _kb
