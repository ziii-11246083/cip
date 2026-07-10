"""
Semantic Chunking Service — splits knowledge files into semantically coherent
chunks with overlap, metadata, and content hashing. Supports markdown and JSON.

Markdown: respects H1/H2/H3 headings, paragraphs, lists, tables, code fences.
JSON: one chunk per logical record (e.g., coin profile per entry).
"""

import hashlib
import json
import logging
import re
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

KNOWLEDGE_DIR = Path(__file__).resolve().parent.parent / "data" / "knowledge"

# ── constants ─────────────────────────────────────────────────
CHUNK_OVERLAP_RATIO = 0.15        # 15% overlap between consecutive chunks
MAX_CHUNK_CHARS = 1200            # soft max chars per chunk (~300-400 tokens for mixed CN/EN)
MIN_CHUNK_CHARS = 80              # skip chunks shorter than this
TOPIC_MAP = {
    "investment_rules": "投資原則",
    "risk_health_guide": "健康度檢查",
    "scam_patterns": "詐騙模式",
    "market_narratives": "市場敘事",
    "scenario_playbooks": "市場情境",
    "podcast_style_guide": "Podcast風格",
    "coin_profiles": "幣種檔案",
}


class Chunk:
    """A single semantic chunk with metadata."""

    def __init__(
        self,
        chunk_id: str,
        content: str,
        doc_id: str,
        source: str,
        topic: str,
        section: str,
        chunk_index: int,
        doc_type: str,
        last_updated: str,
        content_hash: str,
    ):
        self.chunk_id = chunk_id
        self.content = content
        self.doc_id = doc_id
        self.source = source
        self.topic = topic
        self.section = section
        self.chunk_index = chunk_index
        self.doc_type = doc_type
        self.last_updated = last_updated
        self.content_hash = content_hash

    def to_dict(self) -> Dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "content": self.content,
            "doc_id": self.doc_id,
            "source": self.source,
            "topic": self.topic,
            "section": self.section,
            "chunk_index": self.chunk_index,
            "doc_type": self.doc_type,
            "last_updated": self.last_updated,
            "content_hash": self.content_hash,
        }

    def metadata_dict(self) -> Dict[str, Any]:
        """Return metadata-only dict (for vector store)."""
        d = self.to_dict()
        d.pop("content", None)
        return d


# ── markdown chunking ─────────────────────────────────────────

def _split_md_by_headings(text: str) -> List[Dict[str, Any]]:
    """Split markdown into sections by H1/H2/H3 boundaries."""
    heading_pattern = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)
    matches = list(heading_pattern.finditer(text))

    if not matches:
        return [{"heading": "", "level": 0, "content": text.strip()}]

    sections = []
    for i, m in enumerate(matches):
        level = len(m.group(1))
        heading = m.group(2).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        sections.append({"heading": heading, "level": level, "content": body})

    return sections


def _split_section_into_chunks(
    section_body: str, heading: str, max_chars: int = MAX_CHUNK_CHARS
) -> List[str]:
    """Split a section body into overlapping chunks at natural boundaries."""
    # Split at natural boundaries: double-newline, then list items, then sentences
    paragraphs = re.split(r"\n\n+", section_body.strip())
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        para_len = len(para)

        # If a single paragraph exceeds max, split it further at sentence/line boundaries
        if para_len > max_chars:
            # flush current chunk
            if current:
                chunks.append("\n\n".join(current))
                current = []
                current_len = 0
            # split long paragraph at line boundaries
            sub_chunks = _split_long_paragraph(para, max_chars)
            chunks.extend(sub_chunks)
            continue

        if current_len + para_len > max_chars and current:
            chunks.append("\n\n".join(current))
            # overlap: keep last paragraph as overlap seed
            overlap = _overlap_text(current[-1])
            current = [overlap] if overlap else []
            current_len = len(overlap) if overlap else 0

        current.append(para)
        current_len += para_len

    if current:
        chunks.append("\n\n".join(current))

    return chunks


def _split_long_paragraph(text: str, max_chars: int) -> List[str]:
    """Split an overly long paragraph at line/sentence boundaries."""
    lines = text.split("\n")
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for line in lines:
        line = line.strip()
        if not line:
            continue
        line_len = len(line)
        if current_len + line_len > max_chars and current:
            chunks.append("\n".join(current))
            overlap = _overlap_text(current[-1]) if current else ""
            current = [overlap] if overlap else []
            current_len = len(overlap) if overlap else 0
        current.append(line)
        current_len += line_len

    if current:
        chunks.append("\n".join(current))

    return chunks


def _overlap_text(text: str, ratio: float = CHUNK_OVERLAP_RATIO) -> str:
    """Extract tail portion of text for overlap between chunks."""
    if not text:
        return ""
    # take last ~15% of text as overlap seed, at sentence/line boundary
    take_chars = max(40, int(len(text) * ratio))
    tail = text[-take_chars:]
    # try to start at a sentence or line boundary
    for sep in ["\n", "。", ". ", "！", "？"]:
        idx = tail.find(sep)
        if idx > 10:
            return tail[idx + 1:].strip()
    return tail.strip()


def chunk_markdown(
    text: str, doc_id: str, source: str, topic: str, last_updated: str
) -> List[Chunk]:
    """Chunk a markdown document semantically."""
    sections = _split_md_by_headings(text)
    chunks: List[Chunk] = []
    chunk_index = 0

    for sec in sections:
        heading = sec["heading"]
        body = sec["content"]
        if len(body) < MIN_CHUNK_CHARS:
            if body.strip():
                # Small section → treat as single chunk
                content = f"## {heading}\n\n{body}" if heading else body
                chunks.append(_make_chunk(
                    content=content.strip(),
                    doc_id=doc_id,
                    source=source,
                    topic=topic,
                    section=heading or doc_id,
                    chunk_index=chunk_index,
                    doc_type="markdown",
                    last_updated=last_updated,
                ))
                chunk_index += 1
            continue

        body_chunks = _split_section_into_chunks(body, heading)
        for bc in body_chunks:
            content = f"## {heading}\n\n{bc}" if heading else bc
            if len(content.strip()) < MIN_CHUNK_CHARS:
                continue
            chunks.append(_make_chunk(
                content=content.strip(),
                doc_id=doc_id,
                source=source,
                topic=topic,
                section=heading or doc_id,
                chunk_index=chunk_index,
                doc_type="markdown",
                last_updated=last_updated,
            ))
            chunk_index += 1

    return chunks


# ── JSON chunking ─────────────────────────────────────────────

def chunk_json(
    data: Dict[str, Any], doc_id: str, source: str, topic: str, last_updated: str
) -> List[Chunk]:
    """Chunk JSON data — one chunk per logical record."""
    chunks: List[Chunk] = []
    chunk_index = 0

    if isinstance(data, dict):
        for key, record in data.items():
            if isinstance(record, dict):
                # Flatten record into readable text
                parts = [f"{key}:"]
                for k, v in record.items():
                    if isinstance(v, list):
                        parts.append(f"  {k}: {', '.join(str(x) for x in v)}")
                    else:
                        parts.append(f"  {k}: {v}")
                content = "\n".join(parts)
            else:
                content = f"{key}: {record}"

            if len(content.strip()) >= MIN_CHUNK_CHARS:
                chunks.append(_make_chunk(
                    content=content.strip(),
                    doc_id=doc_id,
                    source=source,
                    topic=topic,
                    section=str(key),
                    chunk_index=chunk_index,
                    doc_type="json",
                    last_updated=last_updated,
                ))
                chunk_index += 1
    elif isinstance(data, list):
        for i, record in enumerate(data):
            content = json.dumps(record, ensure_ascii=False, indent=2)
            if len(content.strip()) >= MIN_CHUNK_CHARS:
                chunks.append(_make_chunk(
                    content=content.strip(),
                    doc_id=doc_id,
                    source=source,
                    topic=topic,
                    section=f"item_{i}",
                    chunk_index=chunk_index,
                    doc_type="json",
                    last_updated=last_updated,
                ))
                chunk_index += 1

    return chunks


# ── helpers ──────────────────────────────────────────────────

def _make_chunk(
    content: str,
    doc_id: str,
    source: str,
    topic: str,
    section: str,
    chunk_index: int,
    doc_type: str,
    last_updated: str,
) -> Chunk:
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
    chunk_id = f"{doc_id}#{chunk_index}"
    return Chunk(
        chunk_id=chunk_id,
        content=content,
        doc_id=doc_id,
        source=source,
        topic=topic,
        section=section,
        chunk_index=chunk_index,
        doc_type=doc_type,
        last_updated=last_updated,
        content_hash=content_hash,
    )


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


def _topic_from_filename(filename: str) -> str:
    stem = filename.replace(".md", "").replace(".json", "")
    return TOPIC_MAP.get(stem, stem)


# ── main entry point ──────────────────────────────────────────

def build_all_chunks(base_dir: Optional[Path] = None) -> List[Chunk]:
    """Build chunks from all knowledge files. Reproducible and repeatable."""
    base = base_dir or KNOWLEDGE_DIR
    if not base.exists():
        logger.warning("Knowledge directory not found: %s", base)
        return []

    today = date.today().isoformat()
    all_chunks: List[Chunk] = []

    for path in sorted(base.glob("*.md")):
        text = _read_text(path)
        if not text.strip():
            continue
        doc_id = path.stem
        topic = _topic_from_filename(path.name)
        source = f"data/knowledge/{path.name}"
        chunks = chunk_markdown(text, doc_id=doc_id, source=source, topic=topic, last_updated=today)
        all_chunks.extend(chunks)
        logger.info("Chunked %s → %d chunks", path.name, len(chunks))

    for path in sorted(base.glob("*.json")):
        data = _read_json(path)
        if not data:
            continue
        doc_id = path.stem
        topic = _topic_from_filename(path.name)
        source = f"data/knowledge/{path.name}"
        chunks = chunk_json(data, doc_id=doc_id, source=source, topic=topic, last_updated=today)
        all_chunks.extend(chunks)
        logger.info("Chunked %s → %d chunks", path.name, len(chunks))

    logger.info("Total chunks built: %d", len(all_chunks))
    return all_chunks


# ── singleton cache ───────────────────────────────────────────

_chunk_cache: Optional[List[Chunk]] = None


def get_all_chunks(force_rebuild: bool = False) -> List[Chunk]:
    global _chunk_cache
    if _chunk_cache is None or force_rebuild:
        _chunk_cache = build_all_chunks()
    return _chunk_cache
