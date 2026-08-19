"""
RAG Trace Service — traceability layer for RAG answers (TASK 02).

One AI Chat call produces one TraceRun with a unique trace_id linking:
sanitized query, retrieval sources (actually injected), final answer,
model/versions, token/latency, fallback/error/status, conversation_id.

Design rules (TASK 02 + Codex review):
  - Stores are injectable; tests never touch a real database.
  - Every store failure (primary or DB) is isolated: start/record/finish
    never raise to the caller; Chat must always succeed.
  - The DB writer is fail-closed: it only writes with an explicit
    service-role credential. SupabaseDB.key / _table() are never used.
  - query_hash = keyed HMAC-SHA-256(server_secret, normalized sanitized
    query). The secret must be >= 32 bytes; weaker secrets fail closed.
  - fallback_reason / error persist fixed codes only (no provider
    exception text); logs carry codes only — never query/answer/secret.
  - If source insert fails after run insert, a compensation delete for
    THIS trace only is attempted (best-effort, not a real transaction).
"""

import hashlib
import hmac
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
KNOWLEDGE_DIR = PROJECT_ROOT / "data" / "knowledge"

# ── error codes (safe to log; never embed query/answer/secret) ──────
TRACE_SR_MISSING = "trace_sr_missing"
TRACE_SR_AMBIGUOUS = "trace_sr_ambiguous"
TRACE_CLIENT_INIT_FAILED = "trace_client_init_failed"
TRACE_HMAC_SECRET_MISSING = "trace_hmac_secret_missing"
TRACE_HMAC_SECRET_WEAK = "trace_hmac_secret_weak"
TRACE_RUN_WRITE_FAILED = "trace_run_write_failed"
TRACE_RUN_ID_MISSING = "trace_run_id_missing"
TRACE_SOURCE_WRITE_FAILED = "trace_source_write_failed"
TRACE_STORE_ERROR = "trace_store_error"
TRACE_CLEANUP_FAILED = "trace_cleanup_failed"
TRACE_FINISH_FAILED = "trace_finish_failed"
TRACE_ENDPOINT_REJECTED = "trace_endpoint_rejected"

# Fixed codes persisted in fallback_reason / error (no exception text)
_ALLOWED_FALLBACK_CODES = {
    "router_error", "retrieval_error", "rewrite_error", "kb_unavailable",
    "llm_unavailable", "rag_error", "rag_fallback",
}
_ALLOWED_ERROR_CODES = {"ai_chat_error", "llm_error"}

# Endpoints allowed to open a trace run (Task 01 contract endpoint CHECK)
_ALLOWED_ENDPOINTS = {"chat", "agent", "scam", "podcast", "health"}

# HMAC secret minimum strength (bytes, utf-8 encoded)
_MIN_HMAC_SECRET_BYTES = 32

# ── PII masking (contract §6.1: raw query never stored) ─────────────
# 高風險 secret 整段替換；regex 無法保證辨識所有自然語言姓名（如未標示的
# 中文姓名），此為已知限制（見 docs/RAG_TRACE_DATA_CONTRACT.md §6.1）。
_PII_PATTERNS = [
    (re.compile(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^-]*-----END [A-Z0-9 ]*PRIVATE KEY-----",
        re.DOTALL), "<PRIVATE_KEY>"),
    (re.compile(
        r"(助記詞|種子短語|seed\s*phrase|mnemonic|recovery\s*phrase)\s*[:：]?\s*"
        r"(?:[a-z]{2,}\s+){23}[a-z]{2,}",
        re.IGNORECASE), "<MNEMONIC>"),
    (re.compile(
        r"(助記詞|種子短語|seed\s*phrase|mnemonic|recovery\s*phrase)\s*[:：]?\s*"
        r"(?:[a-z]{2,}\s+){11}[a-z]{2,}",
        re.IGNORECASE), "<MNEMONIC>"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
     "<JWT>"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "<API_KEY>"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "<API_KEY>"),
    (re.compile(r"\bxox[bpa]-[A-Za-z0-9-]{10,}\b"), "<API_KEY>"),
    (re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"), "<API_KEY>"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b"), "<TOKEN>"),
    (re.compile(r"\b[0-9a-fA-F]{64}\b"), "<PRIVATE_KEY>"),
    (re.compile(r"\b0x[0-9a-fA-F]{20,64}\b"), "<WALLET>"),
    (re.compile(r"\bbc1[0-9a-zA-Z]{25,62}\b"), "<WALLET>"),
    (re.compile(r"\bT[1-9A-HJ-NP-Za-km-z]{26,35}\b"), "<WALLET>"),
    (re.compile(r"\b[A-Z][12][0-9]{8}\b"), "<ID_NUMBER>"),
    (re.compile(
        r"(護照號碼|護照|passport\s*number|passport)\s*[:：]?\s*[A-Za-z0-9]{6,12}",
        re.IGNORECASE), "<ID_NUMBER>"),
    (re.compile(
        r"(姓名|名字|full\s*name|name)\s*[:：]\s*[^\s,，。;；]+",
        re.IGNORECASE), "<NAME>"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<EMAIL>"),
    (re.compile(r"https?://[^\s一-鿿]+"), "<URL>"),
    (re.compile(r"(?<!\d)09\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)"), "<PHONE>"),
    (re.compile(r"(?<!\d)\+?\d{10,15}(?!\d)"), "<PHONE>"),
]


def sanitize_text(text: Optional[str], max_len: Optional[int] = None) -> str:
    """Mask PII/secrets in text. Used for query/answer/fallback_reason/error before storage."""
    if not text:
        return ""
    out = str(text)
    for pattern, placeholder in _PII_PATTERNS:
        out = pattern.sub(placeholder, out)
    if max_len is not None and len(out) > max_len:
        out = out[:max_len]
    return out


def normalize_query(text: str) -> str:
    """Normalize sanitized query for HMAC input: strip, collapse whitespace, lowercase."""
    return " ".join(str(text).split()).lower()


def display_source(source: str) -> str:
    """Safe display form of a source: basename only（不曝露伺服器絕對路徑）。"""
    if not source:
        return ""
    return str(source).replace("\\", "/").rsplit("/", 1)[-1]


_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def clean_public_field(value: Any, max_len: int = 120) -> Optional[str]:
    """安全公開字串：先遮罩 PII/secret（保留原始字詞邊界）、
    再移除控制字元、最後截斷。None/空 → None。"""
    if value is None:
        return None
    text = sanitize_text(str(value))
    text = _CONTROL_CHARS.sub("", text).strip()
    if len(text) > max_len:
        text = text[:max_len]
    return text or None


def clean_citation_source(source: str) -> Optional[str]:
    """citation 用 source：basename＋安全清理（POSIX/Windows 路徑皆處理）。"""
    return clean_public_field(display_source(source))


def clean_chunk_id(chunk_id: Any) -> Optional[str]:
    """chunk_id（path/to/file#rank）：只保留可辨識 basename 與 #rank，去目錄。"""
    if chunk_id is None:
        return None
    text = str(chunk_id)
    head, sep, rank = text.partition("#")
    base = display_source(head) if head else ""
    cleaned = f"{base}#{rank}" if sep and rank else base
    return clean_public_field(cleaned, max_len=200)


def clean_public_label(value: Any, max_len: int = 120) -> Optional[str]:
    """section/topic：path-like 值取安全 basename，否則原文字；一律安全清理。"""
    if value is None:
        return None
    text = str(value)
    if "/" in text or "\\" in text:
        text = display_source(text)
    return clean_public_field(text, max_len=max_len)


def hmac_query_hash(normalized_text: str, secret: str) -> Optional[str]:
    """keyed HMAC-SHA-256, 64-char lowercase hex. None when secret missing (fail closed)."""
    if not secret:
        return None
    digest = hmac.new(secret.encode("utf-8"), normalized_text.encode("utf-8"), hashlib.sha256)
    return digest.hexdigest()


def fallback_code(raw_reason: str) -> str:
    """Map raw fallback_reason to an allowlisted code (strip provider exception text)."""
    raw = (raw_reason or "").strip()
    if not raw:
        return ""
    first_token = re.split(r"[:：\s]", raw, maxsplit=1)[0]
    return first_token if first_token in _ALLOWED_FALLBACK_CODES else "rag_fallback"


# ── version fingerprints (informational; no secrets included) ───────
_kb_snapshot_cache: Dict[str, Any] = {"hash": None}


def kb_snapshot_hash() -> Optional[str]:
    """SHA-256 over knowledge dir file names + contents. Cached per process."""
    if _kb_snapshot_cache["hash"] is not None:
        return _kb_snapshot_cache["hash"]
    try:
        if not KNOWLEDGE_DIR.exists():
            return None
        outer = hashlib.sha256()
        for path in sorted(list(KNOWLEDGE_DIR.glob("*.md")) + list(KNOWLEDGE_DIR.glob("*.json"))):
            outer.update(path.name.encode("utf-8"))
            outer.update(hashlib.sha256(path.read_bytes()).digest())
        _kb_snapshot_cache["hash"] = outer.hexdigest()
    except Exception:
        _kb_snapshot_cache["hash"] = None
    return _kb_snapshot_cache["hash"]


def config_fingerprint() -> Optional[str]:
    """SHA-256 of the RAG-related env config (no API keys / secrets included)."""
    keys = [
        "RAG_ENABLE_EMBEDDINGS", "RAG_ENABLE_VECTOR_STORE", "RAG_ENABLE_QUERY_REWRITE",
        "RAG_ENABLE_RERANK", "RAG_ROUTING_MODE", "RAG_TOP_K_SPARSE",
        "RAG_TOP_K_DENSE", "RAG_TOP_K_FINAL", "RAG_REWRITE_SIM_THRESHOLD",
        "RAG_EMBEDDING_MODEL", "RAG_RRF_K", "RAG_DENSE_WEIGHT", "RAG_SPARSE_WEIGHT",
        "RAG_ENABLE_LLM_REWRITE",
    ]
    canonical = json.dumps(
        {k: os.getenv(k) for k in keys}, sort_keys=True, ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ── trace record ─────────────────────────────────────────────────────

class ChatTraceRecord:
    """One rag_runs row + its rag_run_sources rows, mapped to the Task 01 contract."""

    def __init__(
        self,
        trace_id: str,
        endpoint: str,
        sanitized_query: str,
        query_hash: Optional[str],
        answer: str,
        model: str,
        status: str,
        user_id: Optional[str] = None,
        conversation_id: Optional[str] = None,
        sources: Optional[List[Dict[str, Any]]] = None,
        route: Optional[str] = None,
        fallback: bool = False,
        fallback_reason: str = "",
        error: str = "",
        abstained: bool = False,
        rewrite_used: Optional[bool] = None,
        rewrite_rejected: Optional[bool] = None,
        rewrite_similarity: Optional[float] = None,
        sparse_hit_count: Optional[int] = None,
        dense_hit_count: Optional[int] = None,
        final_context_count: Optional[int] = None,
        empty_context: Optional[bool] = None,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        retrieval_latency_ms: Optional[int] = None,
        rerank_latency_ms: Optional[int] = None,
        total_latency_ms: int = 0,
        kb_version: Optional[str] = None,
        config_version: Optional[str] = None,
    ):
        self.trace_id = trace_id
        self.endpoint = endpoint
        self.sanitized_query = sanitized_query
        self.query_hash = query_hash
        self.answer = answer
        self.model = model
        self.status = status
        self.user_id = user_id
        self.conversation_id = conversation_id
        self.sources = sources or []
        self.route = route
        self.fallback = fallback
        self.fallback_reason = fallback_reason
        self.error = error
        self.abstained = abstained
        self.rewrite_used = rewrite_used
        self.rewrite_rejected = rewrite_rejected
        self.rewrite_similarity = rewrite_similarity
        self.sparse_hit_count = sparse_hit_count
        self.dense_hit_count = dense_hit_count
        self.final_context_count = final_context_count
        self.empty_context = empty_context
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.retrieval_latency_ms = retrieval_latency_ms
        self.rerank_latency_ms = rerank_latency_ms
        self.total_latency_ms = total_latency_ms
        self.kb_version = kb_version
        self.config_version = config_version

    def to_run_payload(self) -> Dict[str, Any]:
        """Payload for rag_runs insert. message_id/prompt_version/index_version
        stay NULL: not available from the current pipeline (documented, planned)."""
        return {
            "trace_id": self.trace_id,
            "user_id": self.user_id,
            "conversation_id": self.conversation_id,
            "message_id": None,
            "endpoint": self.endpoint,
            "sanitized_query": self.sanitized_query,
            "query_hash": self.query_hash,
            "answer": self.answer,
            "model": self.model,
            "prompt_version": None,
            "kb_version": self.kb_version,
            "index_version": None,
            "config_version": self.config_version,
            "route": self.route,
            "confidence": None,
            "abstained": self.abstained,
            "fallback": self.fallback,
            "fallback_reason": self.fallback_reason or None,
            "status": self.status,
            "error": self.error or None,
            "rewrite_used": self.rewrite_used,
            "rewrite_rejected": self.rewrite_rejected,
            "rewrite_similarity": self.rewrite_similarity,
            "sparse_hit_count": self.sparse_hit_count,
            "dense_hit_count": self.dense_hit_count,
            "final_context_count": self.final_context_count,
            "empty_context": self.empty_context,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "retrieval_latency_ms": self.retrieval_latency_ms,
            "rerank_latency_ms": self.rerank_latency_ms,
            "total_latency_ms": self.total_latency_ms,
        }

    def to_source_payloads(self, run_id: str) -> List[Dict[str, Any]]:
        """Payloads for rag_run_sources insert (rank 1-based).

        Rows violating NOT NULL/CHECK constraints (empty source/excerpt,
        rank < 1) are skipped so one dirty source cannot break the batch.
        """
        rows = []
        for source in self.sources:
            src = (source.get("source") or "").strip()
            excerpt = (source.get("excerpt") or "").strip()
            if not src or not excerpt:
                continue
            rank = source.get("rank")
            try:
                rank_int = int(rank)
            except (TypeError, ValueError):
                rank_int = 0
            if rank_int < 1:
                rank_int = len(rows) + 1
            rows.append({
                "run_id": run_id,
                "chunk_id": source.get("chunk_id") or None,
                "source": src[:500],
                "topic": source.get("topic") or None,
                "section": source.get("section") or None,
                "rank": rank_int,
                "score": source.get("score"),
                "content_hash": source.get("content_hash") or None,
                "excerpt": excerpt[:4000],
                "actually_injected": bool(source.get("actually_injected", False)),
            })
        return rows


# ── stores ───────────────────────────────────────────────────────────

class TraceStore:
    """Store contract: save_run returns (ok, error_code); never raises."""

    enabled = False
    disabled_reason: Optional[str] = None

    def save_run(self, record: ChatTraceRecord) -> Tuple[bool, str]:
        raise NotImplementedError


class InMemoryTraceStore(TraceStore):
    """Ring buffer store. Always available; used for local observability and tests."""

    _RING_SIZE = 100

    def __init__(self):
        self.enabled = True
        self.disabled_reason = None
        self._records: List[ChatTraceRecord] = []

    def save_run(self, record: ChatTraceRecord) -> Tuple[bool, str]:
        self._records.append(record)
        if len(self._records) > self._RING_SIZE:
            self._records = self._records[-self._RING_SIZE:]
        return True, ""

    def recent(self, n: int = 20) -> List[ChatTraceRecord]:
        return self._records[-n:]


class SupabaseTraceStore(TraceStore):
    """
    Fail-closed writer for rag_runs / rag_run_sources.

    Only writes with an explicit service-role credential:
      - url + service_role_key must be provided (directly or via env);
      - the key must not be identical to the anon/generic key.
    When the credential is missing, save_run returns (False, code) and
    never attempts a network call.

    Compensation: if run insert succeeds but source insert fails (or the
    run id is missing), a best-effort delete scoped to THIS trace is
    attempted so no half-written run is left behind. This is not a real
    cross-request transaction (see report).
    """

    def __init__(
        self,
        url: Optional[str] = None,
        service_role_key: Optional[str] = None,
    ):
        self.enabled = False
        self.disabled_reason: Optional[str] = None
        self._client: Any = None

        self._url = (url or os.getenv("SUPABASE_URL", "")).strip()
        self._sr_key = (
            service_role_key if service_role_key is not None
            else os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        ).strip()
        anon_key = os.getenv("SUPABASE_ANON_KEY", "").strip()
        generic_key = os.getenv("SUPABASE_KEY", "").strip()

        if not self._url or not self._sr_key:
            self.disabled_reason = TRACE_SR_MISSING
            return
        if anon_key and self._sr_key == anon_key:
            self.disabled_reason = TRACE_SR_AMBIGUOUS
            return
        if generic_key and self._sr_key == generic_key:
            self.disabled_reason = TRACE_SR_AMBIGUOUS
            return

        try:
            from supabase import create_client
            self._client = create_client(self._url, self._sr_key)
            self.enabled = True
        except Exception:
            self.disabled_reason = TRACE_CLIENT_INIT_FAILED

    def _cleanup_run(self, trace_id: str, run_id: Optional[str] = None) -> None:
        """Best-effort delete scoped to THIS trace only (never touches other runs)."""
        try:
            query = self._client.table("rag_runs").delete()
            if run_id:
                query = query.eq("id", run_id)
            query = query.eq("trace_id", trace_id)
            query.execute()
        except Exception:
            logger.warning("rag_trace cleanup failed: code=%s", TRACE_CLEANUP_FAILED)

    def save_run(self, record: ChatTraceRecord) -> Tuple[bool, str]:
        if self.disabled_reason:
            return False, self.disabled_reason
        if self._client is None:
            return False, TRACE_CLIENT_INIT_FAILED

        try:
            response = self._client.table("rag_runs").insert(
                record.to_run_payload()
            ).execute()
        except Exception:
            return False, TRACE_RUN_WRITE_FAILED

        run_id = None
        try:
            data = getattr(response, "data", None) or []
            if data:
                run_id = data[0].get("id")
        except Exception:
            run_id = None
        if not run_id:
            self._cleanup_run(record.trace_id)
            return False, TRACE_RUN_ID_MISSING

        source_rows = record.to_source_payloads(run_id)
        if source_rows:
            try:
                self._client.table("rag_run_sources").insert(source_rows).execute()
            except Exception:
                self._cleanup_run(record.trace_id, run_id)
                return False, TRACE_SOURCE_WRITE_FAILED
        return True, ""


# ── trace service ────────────────────────────────────────────────────

class RAGTraceService:
    """
    Orchestrates TraceRun lifecycle. Never raises out of start/finish;
    failures are surfaced as safe error codes in logs.
    """

    def __init__(
        self,
        store: Optional[TraceStore] = None,
        db_store: Optional[TraceStore] = None,
        hmac_secret: Optional[str] = None,
    ):
        self._store = store or InMemoryTraceStore()
        self._db_store = db_store
        self._hmac_secret = (
            hmac_secret if hmac_secret is not None
            else os.getenv("RAG_TRACE_HMAC_SECRET", "")
        ).strip()
        self._warned: Dict[str, bool] = {}
        if self._hmac_secret and len(self._hmac_secret.encode("utf-8")) < _MIN_HMAC_SECRET_BYTES:
            self._hmac_secret = ""
            self._warn_once(TRACE_HMAC_SECRET_WEAK)

    def _warn_once(self, code: str) -> None:
        if self._warned.get(code):
            return
        self._warned[code] = True
        logger.warning("rag_trace: %s", code)

    def start_run(
        self,
        endpoint: str,
        query: str,
        user_id: Optional[str] = None,
        conversation_id: Optional[str] = None,
        model: str = "",
    ) -> Optional["TraceRun"]:
        """共用 trace 入口（TASK 03）。未知 endpoint fail closed：回傳 None 並記安全代碼。"""
        if endpoint not in _ALLOWED_ENDPOINTS:
            self._warn_once(TRACE_ENDPOINT_REJECTED)
            return None
        return TraceRun(
            service=self,
            endpoint=endpoint,
            query=query,
            user_id=user_id,
            conversation_id=conversation_id,
            model=model,
        )

    def start_chat_run(
        self,
        query: str,
        user_id: Optional[str] = None,
        conversation_id: Optional[str] = None,
        model: str = "",
    ) -> "TraceRun":
        """Task 02 相容入口（行為不變）。"""
        return self.start_run(
            "chat",
            query,
            user_id=user_id,
            conversation_id=conversation_id,
            model=model,
        )

    def persist(self, record: ChatTraceRecord) -> None:
        """Write to memory store always; to DB store only when contract-compliant.
        Primary and DB store failures are isolated from each other and from callers."""
        try:
            self._store.save_run(record)
        except Exception:
            logger.warning("rag_trace primary store failed: code=%s", TRACE_STORE_ERROR)

        if self._db_store is None:
            return
        if self._db_store.disabled_reason:
            self._warn_once(self._db_store.disabled_reason)
            return
        if not record.query_hash:
            self._warn_once(TRACE_HMAC_SECRET_MISSING)
            return
        try:
            ok, code = self._db_store.save_run(record)
        except Exception:
            ok, code = False, TRACE_STORE_ERROR
        if not ok:
            logger.warning("rag_trace write failed: code=%s", code)


class TraceRun:
    """One chat run being traced. All methods are non-raising."""

    def __init__(
        self,
        service: RAGTraceService,
        endpoint: str,
        query: str,
        user_id: Optional[str],
        conversation_id: Optional[str],
        model: str,
    ):
        self._service = service
        self.trace_id = uuid.uuid4().hex
        self._t0 = time.time()
        self._finished = False

        self.endpoint = endpoint
        self.user_id = user_id
        self.conversation_id = conversation_id
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-5.4")

        sanitized = sanitize_text(query, max_len=4000)
        self.sanitized_query = sanitized
        self.query_hash = hmac_query_hash(
            normalize_query(sanitized), self._service._hmac_secret
        )

        # rag outcomes
        self.citations: List[str] = []
        self.confidence: Optional[str] = None
        self._sources: List[Dict[str, Any]] = []
        self._metrics: Dict[str, Any] = {}
        self._rag_error = False
        self._rag_unavailable = False
        self._llm_unavailable = False

    def set_conversation_id(self, conversation_id: str) -> None:
        if self._finished or self.conversation_id:
            return
        self.conversation_id = conversation_id

    def note_rag_error(self) -> None:
        self._rag_error = True

    def note_rag_unavailable(self) -> None:
        """RAG/KB unavailable at the app level (augment_* not called)."""
        self._rag_unavailable = True

    def note_llm_unavailable(self) -> None:
        """LLM key/client missing：endpoint 以既有 fallback 回應（degraded）。"""
        self._llm_unavailable = True

    def safe_citations(self) -> List[Dict[str, Any]]:
        """對外 citation（TASK 03）：只來自 actually_injected 來源；
        所有公開欄位（chunk_id／source／section／topic）經防禦性清理：
        去目錄（POSIX/Windows）、去控制字元、遮罩 secret、長度上限。"""
        out = []
        for source in self._sources:
            if not source.get("actually_injected"):
                continue
            out.append({
                "chunk_id": clean_chunk_id(source.get("chunk_id")),
                "source": clean_citation_source(source.get("source") or ""),
                "section": clean_public_label(source.get("section")),
                "topic": clean_public_label(source.get("topic")),
            })
        return out[:10]

    def record_rag(self, rag_result: Dict[str, Any]) -> None:
        if self._finished:
            return
        try:
            self.citations = list(rag_result.get("citations") or [])[:10]
            self.confidence = rag_result.get("confidence")
            injected_count = int(rag_result.get("injected_count") or 0)
            results = rag_result.get("retrieval_results") or []
            for i, r in enumerate(results[:20]):
                if isinstance(r, dict):
                    metadata = r.get("metadata") or {}
                    source = r.get("source", "")
                    topic = r.get("topic")
                    snippet = r.get("snippet", "")
                    score = r.get("score")
                else:
                    metadata = getattr(r, "metadata", None) or {}
                    source = getattr(r, "source", "")
                    topic = getattr(r, "topic", None)
                    snippet = getattr(r, "snippet", "")
                    score = getattr(r, "score", None)
                self._sources.append({
                    "chunk_id": metadata.get("chunk_id"),
                    "source": source,
                    "topic": topic,
                    "section": metadata.get("section"),
                    "content_hash": metadata.get("content_hash"),
                    "rank": i + 1,
                    "score": float(score) if isinstance(score, (int, float)) else None,
                    "excerpt": sanitize_text(snippet, max_len=4000),
                    "actually_injected": i < injected_count,
                })
            self._metrics = dict(rag_result.get("metrics_record") or {})
        except Exception:
            self._rag_error = True

    def finish(
        self,
        answer: str,
        error: Optional[str] = None,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
    ) -> None:
        if self._finished:
            return
        self._finished = True
        try:
            self._finish_inner(answer, error, prompt_tokens, completion_tokens)
        except Exception:
            logger.warning("rag_trace finish failed: code=%s", TRACE_FINISH_FAILED)

    def _finish_inner(
        self,
        answer: str,
        error: Optional[str],
        prompt_tokens: int,
        completion_tokens: int,
    ) -> None:
        total_latency_ms = int((time.time() - self._t0) * 1000)

        metrics = self._metrics
        fallback_reason = fallback_code(str(metrics.get("fallback_reason") or ""))
        if self._rag_unavailable and not fallback_reason:
            fallback_reason = "kb_unavailable"
        if self._llm_unavailable and not fallback_reason:
            fallback_reason = "llm_unavailable"
        # rag_error 最泛化：只在沒有更特定代碼時使用（不覆蓋上面的原因）
        if self._rag_error and not fallback_reason:
            fallback_reason = "rag_error"
        empty_context = bool(metrics.get("empty_context"))
        is_fallback = (
            bool(fallback_reason) or empty_context or self._rag_error
            or self._rag_unavailable or self._llm_unavailable
        )

        if error:
            status = "error"
        elif is_fallback:
            status = "degraded"
        else:
            status = "success"

        safe_error = ""
        if error:
            safe_error = error if error in _ALLOWED_ERROR_CODES else "ai_chat_error"

        def _num(value: Any) -> Optional[int]:
            if isinstance(value, (int, float)):
                return int(value)
            return None

        record = ChatTraceRecord(
            trace_id=self.trace_id,
            endpoint=self.endpoint,
            sanitized_query=self.sanitized_query,
            query_hash=self.query_hash,
            answer=sanitize_text(answer, max_len=8000),
            model=self.model,
            status=status,
            user_id=self.user_id,
            conversation_id=self.conversation_id,
            sources=self._sources,
            route=metrics.get("route_type") or None,
            fallback=is_fallback,
            fallback_reason=fallback_reason,
            error=safe_error,
            rewrite_used=metrics.get("rewrite_used"),
            rewrite_rejected=metrics.get("rewrite_rejected"),
            rewrite_similarity=metrics.get("rewrite_similarity"),
            sparse_hit_count=_num(metrics.get("sparse_hit_count")),
            dense_hit_count=_num(metrics.get("dense_hit_count")),
            final_context_count=_num(metrics.get("final_context_count")),
            empty_context=empty_context if metrics else None,
            prompt_tokens=int(prompt_tokens or 0),
            completion_tokens=int(completion_tokens or 0),
            retrieval_latency_ms=_num(metrics.get("retrieval_latency_ms")),
            rerank_latency_ms=_num(metrics.get("rerank_latency_ms")),
            total_latency_ms=total_latency_ms,
            kb_version=kb_snapshot_hash(),
            config_version=config_fingerprint(),
        )
        self._service.persist(record)


# ── singleton ────────────────────────────────────────────────────────

_trace: Optional[RAGTraceService] = None


def get_trace_service() -> RAGTraceService:
    global _trace
    if _trace is None:
        _trace = RAGTraceService(
            store=InMemoryTraceStore(),
            db_store=SupabaseTraceStore(),
        )
    return _trace
