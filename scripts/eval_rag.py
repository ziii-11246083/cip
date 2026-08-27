#!/usr/bin/env python3
"""
RAG Evaluation Script（TASK 05A 升級版）— offline, deterministic retrieval
evaluation harness，沿用既有本地 RAG/KB 讀取路徑。

05A 範圍：
  - 資料集驗證（fail closed）、deterministic retrieval metrics、
    timestamped 本地 artifacts（results.json + summary.md，不覆寫）。
  - 不呼叫 LLM judge、不連 Supabase、不做 baseline 核准/比較。

Metrics（deterministic，binary relevance）：
  - Precision@K / Recall@K / MRR / NDCG@K / source match / keyword match
  - latency：count / avg / p50 / p95 / p99（0 筆標 unavailable，不以 0 冒充）

answer 相關 metrics（faithfulness / answer relevance / citation correctness）
在 05A 一律為 unavailable，reason = "not_evaluated_in_task_05a"。

Usage:
  python scripts/eval_rag.py
  python scripts/eval_rag.py --cases eval/rag_eval_cases.jsonl
  python scripts/eval_rag.py --output-root eval/results --k 3 5 --verbose
  python scripts/eval_rag.py --approve-baseline --baseline-name rag-15-approved-v1
  python scripts/eval_rag.py --baseline eval/baselines/rag-15-approved-v1.json --threshold MRR=0.03
  （--run-id／--clock 主要供 deterministic tests 注入；未指定時自動產生）
"""

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.rag_service import RAGService, get_rag
from services.knowledge_base import get_kb
from services.rag_trace_service import (
    clean_chunk_id,
    clean_public_label,
    display_source,
    sanitize_text,
)

# ── 固定安全代碼（錯誤訊息只含 code＋行號等非敏感定位資訊）──────────
ERR_INVALID_JSON = "eval_case_invalid_json"
ERR_MISSING_FIELD = "eval_case_missing_field"
ERR_BAD_TYPE = "eval_case_bad_type"
ERR_DUPLICATE_ID = "eval_case_duplicate_id"
ERR_VERSION_MISMATCH = "eval_case_version_mismatch"
ERR_BAD_REVIEW_STATUS = "eval_case_bad_review_status"
ERR_EMPTY_EXPECTED = "eval_case_empty_expected"
ERR_INVALID_K = "eval_invalid_k"
ERR_RETRIEVAL_FAILED = "eval_case_retrieval_failed"
ERR_OUTPUT_EXISTS = "eval_output_exists"
ERR_CASES_UNAVAILABLE = "eval_cases_unavailable"
ERR_INVALID_CLOCK = "eval_invalid_clock"
ERR_INITIALIZATION_FAILED = "eval_initialization_failed"
ERR_INVALID_RUN_ID = "eval_invalid_run_id"
ERR_OUTPUT_PATH = "eval_output_path_invalid"
ERR_OUTPUT_WRITE_FAILED = "eval_output_write_failed"
ERR_ARTIFACT_MISMATCH = "eval_artifact_run_id_mismatch"
ERR_BASELINE_INVALID = "eval_baseline_invalid"
ERR_BASELINE_EXISTS = "eval_baseline_exists"
ERR_BASELINE_INELIGIBLE = "eval_baseline_ineligible"
ERR_BASELINE_INCOMPATIBLE = "eval_baseline_incompatible"
ERR_THRESHOLD_INVALID = "eval_threshold_invalid"
ERR_BASELINE_FLAGS = "eval_baseline_flags_invalid"

ALLOWED_ENDPOINTS = {"chat", "agent", "scam", "podcast", "health"}
ALLOWED_REVIEW_STATUS = {"pending_review", "approved", "rejected"}
ANSWER_METRICS_UNAVAILABLE = "unavailable"
ANSWER_METRICS_REASON = "not_evaluated_in_task_05a"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
_SAFE_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SAFE_TIMESTAMP_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")
BASELINE_SCHEMA_VERSION = "rag-baseline-v1"
METRIC_SCHEMA_VERSION = "rag-retrieval-metrics-v2-distinct-topic"
_LOWER_IS_BETTER = {"latency.avg_ms"}


class EvalCaseError(Exception):
    """loader fail-closed 錯誤：message 只含固定 code＋行號／case_id。"""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code} {detail}")
        self.code = code


# ── 1. 資料集 loader（fail closed）──────────────────────────────────

def _require(condition: bool, code: str, detail: str) -> None:
    if not condition:
        raise EvalCaseError(code, detail)


def _is_safe_slug(value: Any) -> bool:
    return (
        isinstance(value, str)
        and bool(_SAFE_SLUG_RE.fullmatch(value))
        and ".." not in value
        and sanitize_text(value) == value
    )


def load_cases(path: str) -> List[Dict[str, Any]]:
    """載入並驗證 eval cases。任何違規立即 raise EvalCaseError（固定 code）。

    驗證規則：
      - 每行為 JSON object；必要欄位、型別、endpoint allowlist 正確。
      - case_id 唯一非空；全部 dataset_version 一致。
      - review_status 在 allowlist 內，且本資料集 15 題必須全部
        pending_review、reviewer 為 null（無真人審核證據）。
      - expected_topics/expected_sources/expected_keywords 為非空 string
        list（不得以字串冒充 list；空 list 直接 validation error，
        不默默計成好成績）。
    """
    cases: List[Dict[str, Any]] = []
    versions: set = set()
    seen_ids: set = set()
    try:
        case_file = open(path, "r", encoding="utf-8")
    except (OSError, UnicodeError, TypeError):
        raise EvalCaseError(ERR_CASES_UNAVAILABLE, "input")

    with case_file as f:
        try:
            rows = list(enumerate(f, start=1))
        except (OSError, UnicodeError):
            raise EvalCaseError(ERR_CASES_UNAVAILABLE, "input")

    for lineno, raw in rows:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            case = json.loads(line)
        except Exception:
            raise EvalCaseError(ERR_INVALID_JSON, f"line {lineno}")
        _require(isinstance(case, dict), ERR_INVALID_JSON, f"line {lineno}")

        for field in ["case_id", "dataset_version", "query", "endpoint",
                      "expected_topics", "expected_sources", "expected_keywords",
                      "review_status", "reviewer", "gold_answer"]:
            _require(field in case, ERR_MISSING_FIELD, f"line {lineno} field {field}")

        _require(_is_safe_slug(case["case_id"]),
                 ERR_BAD_TYPE, f"line {lineno} field case_id")
        _require(_is_safe_slug(case["dataset_version"]),
                 ERR_BAD_TYPE, f"line {lineno} field dataset_version")
        _require(isinstance(case["query"], str) and case["query"].strip(),
                 ERR_BAD_TYPE, f"line {lineno} field query")
        _require(isinstance(case["gold_answer"], str),
                 ERR_BAD_TYPE, f"line {lineno} field gold_answer")
        _require(isinstance(case["endpoint"], str),
                 ERR_BAD_TYPE, f"line {lineno} field endpoint")
        _require(case["endpoint"] in ALLOWED_ENDPOINTS,
                 ERR_BAD_TYPE, f"line {lineno} field endpoint")
        for field in ["expected_topics", "expected_sources", "expected_keywords"]:
            value = case[field]
            _require(isinstance(value, list) and
                     all(isinstance(item, str) and item.strip() for item in value),
                     ERR_BAD_TYPE, f"line {lineno} field {field}")
            _require(len(value) > 0, ERR_EMPTY_EXPECTED,
                     f"line {lineno} field {field}")
        _require(isinstance(case["review_status"], str),
                 ERR_BAD_REVIEW_STATUS, f"line {lineno} field review_status")
        _require(case["review_status"] in ALLOWED_REVIEW_STATUS,
                 ERR_BAD_REVIEW_STATUS, f"line {lineno} field review_status")
        _require(case["review_status"] == "pending_review" and case["reviewer"] is None,
                 ERR_BAD_REVIEW_STATUS,
                 f"line {lineno} field reviewer")

        _require(case["case_id"] not in seen_ids, ERR_DUPLICATE_ID,
                 f"line {lineno} field case_id")
        seen_ids.add(case["case_id"])
        versions.add(case["dataset_version"])
        cases.append(case)

    _require(len(cases) > 0, ERR_MISSING_FIELD, "no cases found")
    _require(len(versions) == 1, ERR_VERSION_MISMATCH,
             f"{len(versions)} dataset_versions found")
    return cases


# ── 2. deterministic metrics（binary relevance；distinct label 一次命中）──

def _topic_relevance(retrieved: List[str], expected: List[str], k: int) -> List[int]:
    """每個 distinct expected topic 僅第一次 retrieved occurrence 計 relevant。"""
    expected_set = set(expected)
    seen: set = set()
    relevance: List[int] = []
    for topic in retrieved[:k]:
        if topic in expected_set and topic not in seen:
            relevance.append(1)
            seen.add(topic)
        else:
            relevance.append(0)
    return relevance

def precision_at_k(retrieved: List[str], expected: List[str], k: int) -> float:
    """P@K = distinct relevant topic 首次命中數 / K；K 恆為分母。"""
    if k <= 0:
        raise ValueError("invalid_k")
    if not expected:
        raise ValueError("empty_expected")
    return sum(_topic_relevance(retrieved, expected, k)) / k


def recall_at_k(retrieved: List[str], expected: List[str], k: int) -> float:
    """Recall@K = |expected ∩ top-K| / |expected|（expected 去重後計命中）。"""
    if k <= 0:
        raise ValueError("invalid_k")
    if not expected:
        raise ValueError("empty_expected")
    return sum(_topic_relevance(retrieved, expected, k)) / len(set(expected))


def mrr(retrieved: List[str], expected: List[str]) -> float:
    """MRR = 1 / 第一個 relevant 的 rank；無 relevant → 0。"""
    for i, t in enumerate(retrieved):
        if t in expected:
            return 1.0 / (i + 1)
    return 0.0


def ndcg_at_k(retrieved: List[str], expected: List[str], k: int) -> float:
    """NDCG@K，binary relevance：DCG=Σ rel_i/log2(i+2)，以理想排序正規化。"""
    if k <= 0:
        raise ValueError("invalid_k")
    if not expected:
        raise ValueError("empty_expected")
    dcg = sum(
        rel / math.log2(i + 2)
        for i, rel in enumerate(_topic_relevance(retrieved, expected, k))
    )
    idcg = sum(1.0 / math.log2(i + 2) for i in range(min(len(set(expected)), k)))
    return dcg / idcg if idcg > 0 else 0.0


def keyword_overlap_score(retrieved_text: str, expected_keywords: List[str]) -> float:
    """keyword match：對已檢索片段串接文字做 case-insensitive 子字串比對。"""
    if not expected_keywords:
        raise ValueError("empty_expected")
    text_lower = retrieved_text.lower()
    return sum(1 for kw in expected_keywords if kw.lower() in text_lower) / len(expected_keywords)


def _canonical_source_id(value: str) -> str:
    """source identifier：basename、移除最後副檔名、case-fold 後精確比較。"""
    basename = str(value).replace("\\", "/").rsplit("/", 1)[-1].strip()
    return Path(basename).stem.casefold()


def source_match_count(expected_sources: List[str], retrieved_sources: List[str]) -> float:
    """相容舊函式名；回傳 distinct expected source 的精確命中比例 [0,1]。"""
    if not expected_sources:
        raise ValueError("empty_expected")
    expected_ids = {_canonical_source_id(value) for value in expected_sources}
    retrieved_ids = {_canonical_source_id(value) for value in retrieved_sources}
    return len(expected_ids & retrieved_ids) / len(expected_ids)


def _avg(values: List[float]) -> Optional[float]:
    return round(sum(values) / len(values), 4) if values else None


def _percentile(values: List[float], p: float) -> Optional[float]:
    if not values:
        return None
    sorted_vals = sorted(values)
    idx = (p / 100.0) * (len(sorted_vals) - 1)
    lower = int(math.floor(idx))
    upper = int(math.ceil(idx))
    if lower == upper:
        return round(sorted_vals[lower], 1)
    frac = idx - lower
    return round(sorted_vals[lower] * (1 - frac) + sorted_vals[upper] * frac, 1)


def latency_stats(values: List[float]) -> Dict[str, Any]:
    """0 筆 → 各項 unavailable（不以 0 冒充實測延遲）。"""
    if not values:
        return {"count": 0, "avg_ms": ANSWER_METRICS_UNAVAILABLE,
                "p50_ms": ANSWER_METRICS_UNAVAILABLE,
                "p95_ms": ANSWER_METRICS_UNAVAILABLE,
                "p99_ms": ANSWER_METRICS_UNAVAILABLE}
    return {"count": len(values), "avg_ms": _avg(values),
            "p50_ms": _percentile(values, 50),
            "p95_ms": _percentile(values, 95),
            "p99_ms": _percentile(values, 99)}


# ── 3. run metadata ─────────────────────────────────────────────────

def git_code_commit() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=10, cwd=PROJECT_ROOT,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return ANSWER_METRICS_UNAVAILABLE


def git_dirty() -> Optional[bool]:
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, timeout=10, cwd=PROJECT_ROOT,
        )
        if result.returncode == 0:
            return bool(result.stdout.strip())
    except Exception:
        pass
    return None


def build_run_metadata(
    dataset_version: str,
    case_count: int,
    k_values: List[int],
    clock: Optional[str] = None,
    run_id: Optional[str] = None,
) -> Dict[str, Any]:
    """clock/run-id 可注入（deterministic tests）；production 不硬編值。"""
    if clock:
        try:
            started = datetime.fromisoformat(clock)
        except (TypeError, ValueError):
            raise EvalCaseError(ERR_INVALID_CLOCK, "clock")
    else:
        started = datetime.now(timezone.utc)
    actual_run_id = run_id or uuid.uuid4().hex[:8]
    if not _is_safe_slug(actual_run_id):
        raise EvalCaseError(ERR_INVALID_RUN_ID, "run_id")
    started_iso = started.isoformat()
    return {
        "run_id": actual_run_id,
        "dataset_version": dataset_version,
        "case_count": case_count,
        "k_values": list(k_values),
        "model": {
            "generation_model": "not_used",
            "embedding_model": (
                clean_public_label(os.getenv("RAG_EMBEDDING_MODEL"))
                or ANSWER_METRICS_UNAVAILABLE
            ),
        },
        "config": {
            "config_fingerprint": _config_fingerprint(),
        },
        "kb": {"kb_version": _kb_version()},
        "index": {"index_version": ANSWER_METRICS_UNAVAILABLE},
        "code": {"commit": git_code_commit(), "dirty": git_dirty()},
        "started_at": started_iso,
        "ended_at": None,
        "run_status": "running",
    }


def _config_fingerprint() -> str:
    try:
        from services.rag_trace_service import config_fingerprint
        return config_fingerprint() or ANSWER_METRICS_UNAVAILABLE
    except Exception:
        return ANSWER_METRICS_UNAVAILABLE


def _kb_version() -> str:
    try:
        from services.rag_trace_service import kb_snapshot_hash
        return kb_snapshot_hash() or ANSWER_METRICS_UNAVAILABLE
    except Exception:
        return ANSWER_METRICS_UNAVAILABLE


# ── 4. evaluation core ──────────────────────────────────────────────

def _safe_case_result(case: Dict[str, Any], k_values: List[int]) -> Dict[str, Any]:
    """case 執行失敗的 failed 結果：metrics 一律 unavailable。"""
    result: Dict[str, Any] = {
        "case_id": case["case_id"],
        "endpoint": case["endpoint"],
        "dataset_version": case["dataset_version"],
        "review_status": case["review_status"],
        "retrieval_status": "failed",
        "error_code": ERR_RETRIEVAL_FAILED,
        "metrics": {},
        "latency_ms": None,
        "retrieved": {"sources": [], "topics": [], "chunks": [], "count": 0},
        "method": ANSWER_METRICS_UNAVAILABLE,
        "route": ANSWER_METRICS_UNAVAILABLE,
    }
    for k in k_values:
        result["metrics"][f"P@{k}"] = ANSWER_METRICS_UNAVAILABLE
        result["metrics"][f"Recall@{k}"] = ANSWER_METRICS_UNAVAILABLE
        result["metrics"][f"NDCG@{k}"] = ANSWER_METRICS_UNAVAILABLE
    result["metrics"]["MRR"] = ANSWER_METRICS_UNAVAILABLE
    result["metrics"]["keyword_overlap"] = ANSWER_METRICS_UNAVAILABLE
    result["metrics"]["source_match"] = ANSWER_METRICS_UNAVAILABLE
    result["answer_metrics"] = {
        "faithfulness": ANSWER_METRICS_UNAVAILABLE,
        "answer_relevance": ANSWER_METRICS_UNAVAILABLE,
        "citation_correctness": ANSWER_METRICS_UNAVAILABLE,
        "reason": ANSWER_METRICS_REASON,
    }
    return result


def _safe_artifact_label(value: Any) -> str:
    cleaned = clean_public_label(value)
    return cleaned if cleaned else ANSWER_METRICS_UNAVAILABLE


def eval_cases(
    cases: List[Dict[str, Any]],
    retrieve_fn: Callable[[str, str], Dict[str, Any]],
    k_values: List[int],
) -> Dict[str, Any]:
    """對每題執行 retrieval＋deterministic metrics。exception 不得被
    continue 靜默略過：標 failed/error_code，仍留下 artifact。"""
    for k in k_values:
        if not isinstance(k, int) or k <= 0:
            raise EvalCaseError(ERR_INVALID_K, f"k={k}")

    per_case: List[Dict[str, Any]] = []
    failed_count = 0
    for case in cases:
        t_start = time.time()
        try:
            pipe = retrieve_fn(case["query"], case["endpoint"])
            if not isinstance(pipe, dict):
                raise TypeError("invalid pipe")
            raw_results = pipe.get("results")
            if raw_results is None:
                retrieved = []
            elif isinstance(raw_results, (str, bytes, dict)):
                raise TypeError("invalid results")
            else:
                retrieved = list(raw_results)

            retrieved_topics: List[str] = []
            retrieved_sources: List[str] = []
            snippets: List[str] = []
            chunk_ids: List[Optional[str]] = []
            for item in retrieved:
                topic = item.topic
                source = item.source
                snippet = item.snippet
                metadata = getattr(item, "metadata", {})
                if metadata is None:
                    metadata = {}
                if not isinstance(metadata, dict):
                    raise TypeError("invalid metadata")
                if topic:
                    retrieved_topics.append(str(topic))
                if source:
                    retrieved_sources.append(str(source))
                snippets.append(str(snippet))
                chunk_ids.append(clean_chunk_id(metadata.get("chunk_id")))

            all_snippets = " ".join(snippets)
            meta = pipe.get("meta") or {}
            if not isinstance(meta, dict):
                raise TypeError("invalid meta")
            method = _safe_artifact_label(
                meta.get("method", ANSWER_METRICS_UNAVAILABLE)
            )
            route_decision = pipe.get("route_decision")
            route = _safe_artifact_label(
                getattr(route_decision, "route", ANSWER_METRICS_UNAVAILABLE)
            )

            metrics: Dict[str, Any] = {}
            for k in k_values:
                metrics[f"P@{k}"] = round(
                    precision_at_k(retrieved_topics, case["expected_topics"], k), 4)
                metrics[f"Recall@{k}"] = round(
                    recall_at_k(retrieved_topics, case["expected_topics"], k), 4)
                metrics[f"NDCG@{k}"] = round(
                    ndcg_at_k(retrieved_topics, case["expected_topics"], k), 4)
            metrics["MRR"] = round(mrr(retrieved_topics, case["expected_topics"]), 4)
            metrics["keyword_overlap"] = round(
                keyword_overlap_score(all_snippets, case["expected_keywords"]), 4)
            metrics["source_match"] = round(
                source_match_count(case["expected_sources"], retrieved_sources), 4)

            latency_ms = (time.time() - t_start) * 1000
            # artifact 只存經 public/safe 規則清理的來源識別
            per_case.append({
                "case_id": case["case_id"],
                "endpoint": case["endpoint"],
                "dataset_version": case["dataset_version"],
                "review_status": case["review_status"],
                "retrieval_status": "completed",
                "error_code": None,
                "metrics": metrics,
                "latency_ms": round(latency_ms, 1),
                "retrieved": {
                    "sources": [_safe_artifact_label(display_source(s))
                                for s in retrieved_sources][:10],
                    "topics": [_safe_artifact_label(t) for t in retrieved_topics][:10],
                    "chunks": chunk_ids[:10],
                    "count": len(retrieved),
                },
                "method": method,
                "route": route,
                "answer_metrics": {
                    "faithfulness": ANSWER_METRICS_UNAVAILABLE,
                    "answer_relevance": ANSWER_METRICS_UNAVAILABLE,
                    "citation_correctness": ANSWER_METRICS_UNAVAILABLE,
                    "reason": ANSWER_METRICS_REASON,
                },
            })
        except Exception:
            failed_count += 1
            per_case.append(_safe_case_result(case, k_values))

    completed = [c for c in per_case if c["retrieval_status"] == "completed"]
    latencies = [c["latency_ms"] for c in completed if c.get("latency_ms") is not None]

    def aggregate(subset: List[Dict[str, Any]]) -> Dict[str, Any]:
        completed_subset = [c for c in subset if c["retrieval_status"] == "completed"]
        # sample_count = 實際納入 metric 計算的 completed 樣本數
        agg: Dict[str, Any] = {"sample_count": len(completed_subset)}
        sub_latencies = [c["latency_ms"] for c in completed_subset if c.get("latency_ms") is not None]
        for k in k_values:
            for name, key in [("P", f"P@{k}"), ("Recall", f"Recall@{k}"), ("NDCG", f"NDCG@{k}")]:
                values = [c["metrics"][key] for c in completed_subset
                          if isinstance(c["metrics"].get(key), (int, float))]
                agg[key] = _avg(values) if values else ANSWER_METRICS_UNAVAILABLE
        mrr_values = [c["metrics"]["MRR"] for c in completed_subset
                      if isinstance(c["metrics"].get("MRR"), (int, float))]
        kw_values = [c["metrics"]["keyword_overlap"] for c in completed_subset
                     if isinstance(c["metrics"].get("keyword_overlap"), (int, float))]
        sm_values = [c["metrics"]["source_match"] for c in completed_subset
                     if isinstance(c["metrics"].get("source_match"), (int, float))]
        agg["MRR"] = _avg(mrr_values) if mrr_values else ANSWER_METRICS_UNAVAILABLE
        agg["keyword_overlap"] = _avg(kw_values) if kw_values else ANSWER_METRICS_UNAVAILABLE
        agg["source_match"] = _avg(sm_values) if sm_values else ANSWER_METRICS_UNAVAILABLE
        agg["latency"] = latency_stats(sub_latencies)
        agg["answer_metrics"] = {
            "faithfulness": ANSWER_METRICS_UNAVAILABLE,
            "answer_relevance": ANSWER_METRICS_UNAVAILABLE,
            "citation_correctness": ANSWER_METRICS_UNAVAILABLE,
            "reason": ANSWER_METRICS_REASON,
        }
        return agg

    per_endpoint: Dict[str, Any] = {}
    for endpoint in sorted({c["endpoint"] for c in per_case}):
        per_endpoint[endpoint] = aggregate([c for c in per_case if c["endpoint"] == endpoint])

    return {
        "overall": aggregate(per_case),
        "per_endpoint": per_endpoint,
        "per_case": per_case,
        "case_counts": {"total": len(cases), "completed": len(completed),
                        "failed": failed_count},
        "latencies_all": latencies,
    }


# ── 5. baseline manifest 與 regression comparison ─────────────────

def _metric_names(k_values: List[int]) -> List[str]:
    names: List[str] = []
    for k in k_values:
        names.extend([f"P@{k}", f"Recall@{k}", f"NDCG@{k}"])
    names.extend(["MRR", "keyword_overlap", "source_match", "latency.avg_ms"])
    return names


def _artifact_case_ids(artifact: Dict[str, Any]) -> List[str]:
    try:
        case_ids = [row["case_id"] for row in artifact["per_case"]]
    except (KeyError, TypeError):
        raise EvalCaseError(ERR_BASELINE_INVALID, "case_ids")
    if not case_ids or any(not _is_safe_slug(case_id) for case_id in case_ids):
        raise EvalCaseError(ERR_BASELINE_INVALID, "case_ids")
    if len(case_ids) != len(set(case_ids)):
        raise EvalCaseError(ERR_BASELINE_INVALID, "case_ids")
    return sorted(case_ids)


def _compatibility_snapshot(artifact: Dict[str, Any]) -> Dict[str, Any]:
    try:
        metadata = artifact["metadata"]
        k_values = metadata["k_values"]
        dataset_version = metadata["dataset_version"]
        config_fingerprint = metadata["config"]["config_fingerprint"]
    except (KeyError, TypeError):
        raise EvalCaseError(ERR_BASELINE_INVALID, "compatibility")
    if (
        not _is_safe_slug(dataset_version)
        or not isinstance(k_values, list)
        or not k_values
        or any(not isinstance(k, int) or isinstance(k, bool) or k <= 0 for k in k_values)
        or len(k_values) != len(set(k_values))
        or not isinstance(config_fingerprint, str)
        or not bool(re.fullmatch(r"[0-9a-f]{64}", config_fingerprint))
    ):
        raise EvalCaseError(ERR_BASELINE_INVALID, "compatibility")
    return {
        "dataset_version": dataset_version,
        "case_ids": _artifact_case_ids(artifact),
        "k_values": sorted(k_values),
        "metric_schema_version": METRIC_SCHEMA_VERSION,
        "config_fingerprint": config_fingerprint,
    }


def _metric_value(artifact: Dict[str, Any], name: str) -> Any:
    try:
        if name == "latency.avg_ms":
            return artifact["overall"]["latency"]["avg_ms"]
        return artifact["overall"][name]
    except (KeyError, TypeError):
        return ANSWER_METRICS_UNAVAILABLE


def _metric_snapshot(artifact: Dict[str, Any]) -> Dict[str, Any]:
    compatibility = _compatibility_snapshot(artifact)
    return {
        name: _metric_value(artifact, name)
        for name in _metric_names(compatibility["k_values"])
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                digest.update(chunk)
    except (OSError, TypeError):
        raise EvalCaseError(ERR_BASELINE_INVALID, "artifact")
    return digest.hexdigest()


def _baseline_artifact_eligible(artifact: Dict[str, Any]) -> bool:
    try:
        metadata = artifact["metadata"]
        counts = artifact["case_counts"]
        return (
            metadata["run_status"] == "completed"
            and counts["failed"] == 0
            and counts["completed"] == counts["total"]
            and counts["total"] == metadata["case_count"]
            and counts["total"] == len(artifact["per_case"])
            and counts["total"] > 0
            and isinstance(metadata["code"]["commit"], str)
            and bool(re.fullmatch(r"[0-9a-fA-F]{40,64}", metadata["code"]["commit"]))
            and metadata["code"]["dirty"] is False
        )
    except (KeyError, TypeError):
        return False


def approve_baseline(
    artifact: Dict[str, Any],
    artifact_path: Path,
    baseline_root: Path,
    baseline_name: str,
    approved_at: Optional[str] = None,
    project_root: Path = PROJECT_ROOT,
) -> Dict[str, Any]:
    """明確核准 clean、completed run；manifest exclusive-create，永不覆寫。"""
    if not _is_safe_slug(baseline_name):
        raise EvalCaseError(ERR_BASELINE_INVALID, "baseline_name")
    if not _baseline_artifact_eligible(artifact):
        raise EvalCaseError(ERR_BASELINE_INELIGIBLE, "run")
    metadata = artifact["metadata"]

    resolved_project = project_root.resolve()
    resolved_artifact = artifact_path.resolve()
    if resolved_project not in resolved_artifact.parents or resolved_artifact.name != "results.json":
        raise EvalCaseError(ERR_BASELINE_INVALID, "artifact_ref")
    try:
        artifact_ref = resolved_artifact.relative_to(resolved_project).as_posix()
    except ValueError:
        raise EvalCaseError(ERR_BASELINE_INVALID, "artifact_ref")
    try:
        with open(resolved_artifact, "r", encoding="utf-8") as f:
            disk_artifact = json.load(f)
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
        raise EvalCaseError(ERR_BASELINE_INVALID, "artifact")
    if disk_artifact != artifact:
        raise EvalCaseError(ERR_ARTIFACT_MISMATCH, "artifact")

    if approved_at:
        try:
            approved_time = datetime.fromisoformat(approved_at)
        except (TypeError, ValueError):
            raise EvalCaseError(ERR_BASELINE_INVALID, "approved_at")
    else:
        approved_time = datetime.now(timezone.utc)

    compatibility = _compatibility_snapshot(artifact)
    manifest = {
        "schema_version": BASELINE_SCHEMA_VERSION,
        "baseline_id": baseline_name,
        "approved_at": approved_time.isoformat(),
        "artifact_ref": artifact_ref,
        "artifact_sha256": _sha256_file(resolved_artifact),
        "compatibility": compatibility,
        "provenance": {
            "run_id": metadata["run_id"],
            "code": metadata["code"],
            "kb": metadata["kb"],
            "index": metadata["index"],
            "model": metadata["model"],
        },
        "overall": _metric_snapshot(artifact),
        "per_endpoint": artifact["per_endpoint"],
    }
    serialized = json.dumps(manifest, ensure_ascii=False, indent=2)
    resolved_baseline_root = baseline_root.resolve()
    manifest_path = (resolved_baseline_root / f"{baseline_name}.json").resolve()
    if resolved_baseline_root not in manifest_path.parents:
        raise EvalCaseError(ERR_BASELINE_INVALID, "manifest")
    try:
        resolved_baseline_root.mkdir(parents=True, exist_ok=True)
        with open(manifest_path, "x", encoding="utf-8") as f:
            f.write(serialized)
    except FileExistsError:
        raise EvalCaseError(ERR_BASELINE_EXISTS, "manifest")
    except OSError:
        raise EvalCaseError(ERR_BASELINE_INVALID, "manifest")
    return {"manifest": manifest, "manifest_path": str(manifest_path)}


def _load_baseline_manifest(
    manifest_path: Path,
    project_root: Path = PROJECT_ROOT,
) -> Dict[str, Any]:
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
        raise EvalCaseError(ERR_BASELINE_INVALID, "manifest")
    try:
        if manifest["schema_version"] != BASELINE_SCHEMA_VERSION:
            raise EvalCaseError(ERR_BASELINE_INVALID, "schema")
        if not _is_safe_slug(manifest["baseline_id"]):
            raise EvalCaseError(ERR_BASELINE_INVALID, "baseline_id")
        artifact_ref = manifest["artifact_ref"]
        expected_hash = manifest["artifact_sha256"]
        if not isinstance(artifact_ref, str) or not isinstance(expected_hash, str):
            raise EvalCaseError(ERR_BASELINE_INVALID, "artifact_ref")
    except (KeyError, TypeError):
        raise EvalCaseError(ERR_BASELINE_INVALID, "manifest")

    ref_path = Path(artifact_ref)
    if ref_path.is_absolute() or ".." in ref_path.parts:
        raise EvalCaseError(ERR_BASELINE_INVALID, "artifact_ref")
    resolved_project = project_root.resolve()
    resolved_artifact = (resolved_project / ref_path).resolve()
    if resolved_project not in resolved_artifact.parents:
        raise EvalCaseError(ERR_BASELINE_INVALID, "artifact_ref")
    if _sha256_file(resolved_artifact) != expected_hash:
        raise EvalCaseError(ERR_BASELINE_INVALID, "artifact_hash")
    try:
        with open(resolved_artifact, "r", encoding="utf-8") as f:
            baseline_artifact = json.load(f)
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
        raise EvalCaseError(ERR_BASELINE_INVALID, "artifact")
    if (
        manifest.get("compatibility") != _compatibility_snapshot(baseline_artifact)
        or manifest.get("overall") != _metric_snapshot(baseline_artifact)
        or manifest.get("per_endpoint") != baseline_artifact.get("per_endpoint")
        or manifest.get("provenance", {}).get("run_id")
        != baseline_artifact.get("metadata", {}).get("run_id")
        or manifest.get("provenance", {}).get("code")
        != baseline_artifact.get("metadata", {}).get("code")
        or manifest.get("provenance", {}).get("kb")
        != baseline_artifact.get("metadata", {}).get("kb")
        or manifest.get("provenance", {}).get("index")
        != baseline_artifact.get("metadata", {}).get("index")
        or manifest.get("provenance", {}).get("model")
        != baseline_artifact.get("metadata", {}).get("model")
        or not _baseline_artifact_eligible(baseline_artifact)
    ):
        raise EvalCaseError(ERR_BASELINE_INVALID, "manifest_snapshot")
    return manifest


def parse_thresholds(items: Optional[List[str]], k_values: List[int]) -> Dict[str, float]:
    allowed = set(_metric_names(k_values))
    thresholds: Dict[str, float] = {}
    for item in items or []:
        if not isinstance(item, str) or "=" not in item:
            raise EvalCaseError(ERR_THRESHOLD_INVALID, "threshold")
        name, raw_value = item.split("=", 1)
        if name not in allowed or name in thresholds:
            raise EvalCaseError(ERR_THRESHOLD_INVALID, "threshold")
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            raise EvalCaseError(ERR_THRESHOLD_INVALID, "threshold")
        if not math.isfinite(value) or value < 0:
            raise EvalCaseError(ERR_THRESHOLD_INVALID, "threshold")
        thresholds[name] = value
    return thresholds


def compare_to_baseline(
    artifact: Dict[str, Any],
    manifest_path: Path,
    thresholds: Optional[Dict[str, float]] = None,
    project_root: Path = PROJECT_ROOT,
) -> Dict[str, Any]:
    manifest = _load_baseline_manifest(manifest_path, project_root=project_root)
    current_compatibility = _compatibility_snapshot(artifact)
    if manifest.get("compatibility") != current_compatibility:
        raise EvalCaseError(ERR_BASELINE_INCOMPATIBLE, "compatibility")
    baseline_metrics = manifest.get("overall")
    if not isinstance(baseline_metrics, dict):
        raise EvalCaseError(ERR_BASELINE_INVALID, "metrics")

    thresholds = dict(thresholds or {})
    allowed = set(_metric_names(current_compatibility["k_values"]))
    if any(
        name not in allowed
        or not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
        or value < 0
        for name, value in thresholds.items()
    ):
        raise EvalCaseError(ERR_THRESHOLD_INVALID, "threshold")

    comparisons: Dict[str, Any] = {}
    failed_metrics: List[str] = []
    for name in _metric_names(current_compatibility["k_values"]):
        baseline_value = baseline_metrics.get(name, ANSWER_METRICS_UNAVAILABLE)
        current_value = _metric_value(artifact, name)
        both_numeric = (
            isinstance(baseline_value, (int, float))
            and not isinstance(baseline_value, bool)
            and math.isfinite(float(baseline_value))
            and isinstance(current_value, (int, float))
            and not isinstance(current_value, bool)
            and math.isfinite(float(current_value))
        )
        threshold = thresholds.get(name)
        if not both_numeric:
            status = "unavailable"
            delta: Any = ANSWER_METRICS_UNAVAILABLE
            degradation: Any = ANSWER_METRICS_UNAVAILABLE
            gate_failed = threshold is not None and baseline_value != current_value
        else:
            delta = round(float(current_value) - float(baseline_value), 4)
            if name in _LOWER_IS_BETTER:
                degradation = round(max(0.0, delta), 4)
                status = "improved" if delta < 0 else "regressed" if delta > 0 else "stable"
            else:
                degradation = round(max(0.0, -delta), 4)
                status = "improved" if delta > 0 else "regressed" if delta < 0 else "stable"
            gate_failed = threshold is not None and degradation > threshold
        if gate_failed:
            failed_metrics.append(name)
        comparisons[name] = {
            "baseline": baseline_value,
            "current": current_value,
            "delta": delta,
            "degradation": degradation,
            "direction": "lower_is_better" if name in _LOWER_IS_BETTER else "higher_is_better",
            "status": status,
            "threshold": threshold if threshold is not None else ANSWER_METRICS_UNAVAILABLE,
            "gate_failed": gate_failed,
        }
    return {
        "status": "compared",
        "baseline_id": manifest["baseline_id"],
        "compatible": True,
        "metrics": comparisons,
        "gate": {
            "passed": not failed_metrics,
            "failed_metrics": failed_metrics,
            "thresholds": thresholds,
        },
        "baseline_provenance": manifest.get("provenance", {}),
    }


# ── 6. artifacts（timestamped run dir，不覆寫）──────────────────────

def build_summary_md(artifact: Dict[str, Any]) -> str:
    meta = artifact["metadata"]
    counts = artifact["case_counts"]
    lines = [
        f"# RAG Eval Run {meta['run_id']}",
        "",
        f"- dataset_version: {meta['dataset_version']}",
        f"- case_count: {meta['case_count']}（completed {counts['completed']} / failed {counts['failed']}）",
        f"- k_values: {meta['k_values']}",
        f"- code commit: {meta['code']['commit']}（dirty: {meta['code']['dirty']}）",
        f"- model: generation_model={meta['model']['generation_model']}, embedding_model={meta['model']['embedding_model']}",
        f"- kb_version: {meta['kb']['kb_version']} / index_version: {meta['index']['index_version']}",
        f"- started_at: {meta['started_at']} / ended_at: {meta['ended_at']}",
        f"- run_status: {meta['run_status']}",
        "",
        "> gold_answer 目前僅為「待審參考答案」：本資料集 15 題尚未經人工審核",
        "> （review_status=pending_review、reviewer=null），不得宣稱 answer accuracy 已通過。",
        "",
        "## Overall",
        "",
    ]
    lines.extend(_md_agg_table(artifact["overall"], meta["k_values"]))
    lines.append("")
    lines.append("## Per endpoint")
    lines.append("")
    for endpoint, agg in artifact["per_endpoint"].items():
        lines.append(f"### {endpoint}")
        lines.append("")
        lines.extend(_md_agg_table(agg, meta["k_values"]))
        lines.append("")
    comparison = artifact.get("baseline_comparison")
    if isinstance(comparison, dict):
        lines.append("## Baseline comparison")
        lines.append("")
        lines.append(f"- status: {comparison.get('status', ANSWER_METRICS_UNAVAILABLE)}")
        if comparison.get("baseline_id"):
            lines.append(f"- baseline_id: {comparison['baseline_id']}")
        if comparison.get("error_code"):
            lines.append(f"- error_code: {comparison['error_code']}")
        gate = comparison.get("gate")
        if isinstance(gate, dict):
            lines.append(f"- gate_passed: {gate.get('passed')}")
            lines.append(f"- failed_metrics: {gate.get('failed_metrics', [])}")
        metrics = comparison.get("metrics")
        if isinstance(metrics, dict):
            for name, result in metrics.items():
                lines.append(
                    f"- {name}: baseline={result.get('baseline')} current={result.get('current')} "
                    f"delta={result.get('delta')} status={result.get('status')} "
                    f"threshold={result.get('threshold')} gate_failed={result.get('gate_failed')}"
                )
        lines.append("")
    lines.append("## unavailable 語意")
    lines.append("")
    lines.append("- answer metrics（faithfulness / answer_relevance / citation_correctness）："
                 f"{ANSWER_METRICS_UNAVAILABLE}（{ANSWER_METRICS_REASON}）")
    lines.append("- latency 0 筆、git 不可用、kb/index 無可靠版本來源時標 unavailable，不以 0 或假值冒充。")
    lines.append("- 本機 artifacts 尚未寫入 rag_eval_runs / rag_evaluations，也不能單獨證明答案正確。")
    lines.append("")
    return "\n".join(lines)


def _md_agg_table(agg: Dict[str, Any], k_values: List[int]) -> List[str]:
    lines = [f"- sample_count: {agg['sample_count']}"]
    for k in k_values:
        lines.append(f"- P@{k}: {agg[f'P@{k}']}  Recall@{k}: {agg[f'Recall@{k}']}  NDCG@{k}: {agg[f'NDCG@{k}']}")
    lines.append(f"- MRR: {agg['MRR']}  keyword_overlap: {agg['keyword_overlap']}  source_match: {agg['source_match']}")
    latency = agg["latency"]
    lines.append(f"- latency: count={latency['count']} avg={latency['avg_ms']}ms "
                 f"p50={latency['p50_ms']}ms p95={latency['p95_ms']}ms p99={latency['p99_ms']}ms")
    return lines


def write_artifacts(
    output_root: Path,
    artifact: Dict[str, Any],
    run_id: str,
    timestamp: str,
) -> Dict[str, str]:
    """建立 <output_root>/<timestamp>-<run_id>/ 並寫入 results.json＋summary.md。
    目錄已存在 → fail closed（不覆寫既有證據）。"""
    if not _is_safe_slug(run_id):
        raise EvalCaseError(ERR_INVALID_RUN_ID, "run_id")
    try:
        artifact_run_id = artifact["metadata"]["run_id"]
    except (KeyError, TypeError):
        raise EvalCaseError(ERR_ARTIFACT_MISMATCH, "metadata")
    if artifact_run_id != run_id:
        raise EvalCaseError(ERR_ARTIFACT_MISMATCH, "run_id")
    if not isinstance(timestamp, str) or not _SAFE_TIMESTAMP_RE.fullmatch(timestamp):
        raise EvalCaseError(ERR_OUTPUT_PATH, "timestamp")

    resolved_root = output_root.resolve()
    run_dir = resolved_root / f"{timestamp}-{run_id}"
    resolved_run_dir = run_dir.resolve()
    if resolved_root not in resolved_run_dir.parents:
        raise EvalCaseError(ERR_OUTPUT_PATH, "run_dir")
    if run_dir.exists():
        raise EvalCaseError(ERR_OUTPUT_EXISTS, f"run_dir {run_dir.name}")
    try:
        run_dir.mkdir(parents=True, exist_ok=False)

        results_path = run_dir / "results.json"
        with open(results_path, "w", encoding="utf-8") as f:
            json.dump(artifact, f, ensure_ascii=False, indent=2)

        summary_path = run_dir / "summary.md"
        with open(summary_path, "w", encoding="utf-8") as f:
            f.write(build_summary_md(artifact))
    except FileExistsError:
        raise EvalCaseError(ERR_OUTPUT_EXISTS, f"run_dir {run_dir.name}")
    except Exception:
        raise EvalCaseError(ERR_OUTPUT_WRITE_FAILED, "artifact")

    return {"run_dir": str(run_dir), "results_json": str(results_path),
            "summary_md": str(summary_path)}


# ── 6. CLI ─────────────────────────────────────────────────────────

def run_cli(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="RAG Evaluation Harness (05A)")
    parser.add_argument("--cases", default="eval/rag_eval_cases.jsonl",
                        help="Path to eval cases JSONL file")
    parser.add_argument("--output-root", default="eval/results",
                        help="Root dir for timestamped run artifacts")
    parser.add_argument("--k", nargs="+", type=int, default=[3, 5],
                        help="K values for P@K/Recall@K/NDCG@K")
    parser.add_argument("--run-id", default=None,
                        help="Run id（預設自動產生；供 deterministic tests 注入）")
    parser.add_argument("--clock", default=None,
                        help="ISO 起始時間（預設 UTC now；供 deterministic tests 注入）")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Print per-case results")
    parser.add_argument("--baseline", default=None,
                        help="Immutable baseline manifest path for comparison")
    parser.add_argument("--threshold", action="append", default=[],
                        help="Allowed absolute degradation, repeatable METRIC=VALUE")
    parser.add_argument("--approve-baseline", action="store_true",
                        help="Explicitly approve this completed clean run as baseline")
    parser.add_argument("--baseline-name", default=None,
                        help="Safe immutable manifest name; required with --approve-baseline")
    parser.add_argument("--baseline-root", default="eval/baselines",
                        help="Directory for immutable baseline manifests")
    args = parser.parse_args(argv)

    cases_path = Path(args.cases)
    if not cases_path.is_absolute():
        cases_path = PROJECT_ROOT / args.cases
    output_root = Path(args.output_root)
    if not output_root.is_absolute():
        output_root = PROJECT_ROOT / args.output_root
    baseline_root = Path(args.baseline_root)
    if not baseline_root.is_absolute():
        baseline_root = PROJECT_ROOT / args.baseline_root
    baseline_path: Optional[Path] = None
    if args.baseline:
        baseline_path = Path(args.baseline)
        if not baseline_path.is_absolute():
            baseline_path = PROJECT_ROOT / args.baseline

    try:
        if args.approve_baseline != bool(args.baseline_name):
            raise EvalCaseError(ERR_BASELINE_FLAGS, "approval")
        if args.approve_baseline and baseline_path is not None:
            raise EvalCaseError(ERR_BASELINE_FLAGS, "mode")
        if args.threshold and baseline_path is None:
            raise EvalCaseError(ERR_BASELINE_FLAGS, "threshold")
        for k in args.k:
            if not isinstance(k, int) or k <= 0:
                raise EvalCaseError(ERR_INVALID_K, f"k={k}")
        thresholds = parse_thresholds(args.threshold, args.k)
        cases = load_cases(str(cases_path))
        metadata = build_run_metadata(
            dataset_version=cases[0]["dataset_version"],
            case_count=len(cases),
            k_values=args.k,
            clock=args.clock,
            run_id=args.run_id,
        )
    except EvalCaseError as exc:
        print(f"ERROR: {exc.code}")
        return 1
    print(f"Loaded {len(cases)} cases（dataset {metadata['dataset_version']}）")

    try:
        kb = get_kb()
        if not kb.is_loaded:
            kb.load_all()
        rag: RAGService = get_rag()
    except Exception:
        print(f"ERROR: {ERR_INITIALIZATION_FAILED}")
        return 1
    print(f"Knowledge base: {'loaded' if kb.is_loaded else 'NOT loaded'}")

    def retrieve_fn(query: str, endpoint: str) -> Dict[str, Any]:
        return rag._retrieve_for_endpoint(query, endpoint=endpoint, max_results=5)

    try:
        evaluation = eval_cases(cases, retrieve_fn, args.k)
    except EvalCaseError as exc:
        print(f"ERROR: {exc.code}")
        return 1

    ended = datetime.fromisoformat(args.clock) if args.clock else datetime.now(timezone.utc)
    metadata["ended_at"] = ended.isoformat()
    counts = evaluation["case_counts"]
    metadata["run_status"] = (
        "completed" if counts["failed"] == 0 else "completed_with_failures"
    )

    artifact = {
        "metadata": metadata,
        "case_counts": counts,
        "overall": evaluation["overall"],
        "per_endpoint": evaluation["per_endpoint"],
        "per_case": evaluation["per_case"],
    }

    comparison_failed = False
    if baseline_path is not None:
        try:
            comparison = compare_to_baseline(
                artifact, baseline_path, thresholds=thresholds,
                project_root=PROJECT_ROOT,
            )
            artifact["baseline_comparison"] = comparison
            comparison_failed = not comparison["gate"]["passed"]
        except EvalCaseError as exc:
            artifact["baseline_comparison"] = {
                "status": "error",
                "error_code": exc.code,
                "compatible": False,
            }
            comparison_failed = True

    timestamp = (datetime.fromisoformat(args.clock) if args.clock
                 else datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    try:
        paths = write_artifacts(output_root, artifact, metadata["run_id"], timestamp)
    except EvalCaseError as exc:
        print(f"ERROR: {exc.code}")
        return 1

    print(f"Run {metadata['run_id']} → {paths['run_dir']}")
    print(f"  results.json / summary.md written")
    print(f"  Cases: completed {counts['completed']} / failed {counts['failed']} / total {counts['total']}")
    print(f"  Overall MRR: {artifact['overall']['MRR']}（sample {artifact['overall']['sample_count']}）")
    print(f"  run_status: {metadata['run_status']}")
    if baseline_path is not None:
        comparison = artifact["baseline_comparison"]
        if comparison["status"] == "error":
            print(f"  baseline_comparison: ERROR {comparison['error_code']}")
        else:
            print(f"  baseline_comparison: {comparison['baseline_id']} "
                  f"gate_passed={comparison['gate']['passed']}")

    approval_failed = False
    if args.approve_baseline:
        try:
            approved = approve_baseline(
                artifact,
                Path(paths["results_json"]),
                baseline_root,
                args.baseline_name,
                project_root=PROJECT_ROOT,
            )
            print(f"  baseline_approved: {approved['manifest']['baseline_id']}")
        except EvalCaseError as exc:
            print(f"  baseline_approval: ERROR {exc.code}")
            approval_failed = True
    if args.verbose:
        for c in artifact["per_case"]:
            print(f"  [{c['endpoint']}] {c['case_id']} {c['retrieval_status']}"
                  f"{(' error=' + c['error_code']) if c['error_code'] else ''}")

    return 0 if counts["failed"] == 0 and not comparison_failed and not approval_failed else 1


def main() -> None:
    sys.exit(run_cli())


if __name__ == "__main__":
    main()
