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
  （--run-id／--clock 主要供 deterministic tests 注入；未指定時自動產生）
"""

import argparse
import json
import math
import os
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

ALLOWED_ENDPOINTS = {"chat", "agent", "scam", "podcast", "health"}
ALLOWED_REVIEW_STATUS = {"pending_review", "approved", "rejected"}
ANSWER_METRICS_UNAVAILABLE = "unavailable"
ANSWER_METRICS_REASON = "not_evaluated_in_task_05a"


class EvalCaseError(Exception):
    """loader fail-closed 錯誤：message 只含固定 code＋行號／case_id。"""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code} {detail}")
        self.code = code


# ── 1. 資料集 loader（fail closed）──────────────────────────────────

def _require(condition: bool, code: str, detail: str) -> None:
    if not condition:
        raise EvalCaseError(code, detail)


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
    with open(path, "r", encoding="utf-8") as f:
        for lineno, raw in enumerate(f, start=1):
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

            _require(isinstance(case["case_id"], str) and case["case_id"].strip(),
                     ERR_BAD_TYPE, f"line {lineno} field case_id")
            _require(isinstance(case["dataset_version"], str) and case["dataset_version"].strip(),
                     ERR_BAD_TYPE, f"line {lineno} field dataset_version")
            _require(isinstance(case["query"], str) and case["query"].strip(),
                     ERR_BAD_TYPE, f"line {lineno} field query")
            _require(isinstance(case["gold_answer"], str),
                     ERR_BAD_TYPE, f"line {lineno} field gold_answer")
            _require(case["endpoint"] in ALLOWED_ENDPOINTS,
                     ERR_BAD_TYPE, f"line {lineno} field endpoint")
            for field in ["expected_topics", "expected_sources", "expected_keywords"]:
                value = case[field]
                _require(isinstance(value, list) and
                         all(isinstance(item, str) and item.strip() for item in value),
                         ERR_BAD_TYPE, f"line {lineno} field {field}")
                _require(len(value) > 0, ERR_EMPTY_EXPECTED,
                         f"line {lineno} field {field}")
            _require(case["review_status"] in ALLOWED_REVIEW_STATUS,
                     ERR_BAD_REVIEW_STATUS, f"line {lineno} field review_status")
            _require(case["review_status"] == "pending_review" and case["reviewer"] is None,
                     ERR_BAD_REVIEW_STATUS,
                     f"line {lineno} case {case['case_id']} must be pending_review with reviewer null")

            _require(case["case_id"] not in seen_ids, ERR_DUPLICATE_ID,
                     f"line {lineno} case_id {case['case_id']}")
            seen_ids.add(case["case_id"])
            versions.add(case["dataset_version"])
            cases.append(case)

    _require(len(cases) > 0, ERR_MISSING_FIELD, "no cases found")
    _require(len(versions) == 1, ERR_VERSION_MISMATCH,
             f"{len(versions)} dataset_versions found")
    return cases


# ── 2. deterministic metrics（binary relevance；重複以位置計，語意見 README）──

def precision_at_k(retrieved: List[str], expected: List[str], k: int) -> float:
    """P@K = |top-K ∩ expected| / K。retrieved 重複項以位置各計一次；K 恆為分母。"""
    if k <= 0:
        raise ValueError("invalid_k")
    if not expected:
        raise ValueError("empty_expected")
    return sum(1 for t in retrieved[:k] if t in expected) / k


def recall_at_k(retrieved: List[str], expected: List[str], k: int) -> float:
    """Recall@K = |expected ∩ top-K| / |expected|（expected 去重後計命中）。"""
    if k <= 0:
        raise ValueError("invalid_k")
    if not expected:
        raise ValueError("empty_expected")
    top_k = retrieved[:k]
    return sum(1 for t in set(expected) if t in top_k) / len(set(expected))


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
        1.0 / math.log2(i + 2)
        for i, t in enumerate(retrieved[:k]) if t in expected
    )
    idcg = sum(1.0 / math.log2(i + 2) for i in range(min(len(set(expected)), k)))
    return dcg / idcg if idcg > 0 else 0.0


def keyword_overlap_score(retrieved_text: str, expected_keywords: List[str]) -> float:
    """keyword match：對已檢索片段串接文字做 case-insensitive 子字串比對。"""
    if not expected_keywords:
        raise ValueError("empty_expected")
    text_lower = retrieved_text.lower()
    return sum(1 for kw in expected_keywords if kw.lower() in text_lower) / len(expected_keywords)


def source_match_count(expected_sources: List[str], retrieved_sources: List[str]) -> int:
    """source match：expected source 為 retrieved source 子字串即計一筆。"""
    return sum(1 for s in expected_sources if any(s in r for r in retrieved_sources))


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
            capture_output=True, text=True, timeout=10,
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
            capture_output=True, text=True, timeout=10,
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
    started = datetime.fromisoformat(clock) if clock else datetime.now(timezone.utc)
    started_iso = started.isoformat()
    return {
        "run_id": run_id or uuid.uuid4().hex[:8],
        "dataset_version": dataset_version,
        "case_count": case_count,
        "k_values": list(k_values),
        "model": {
            "generation_model": "not_used",
            "embedding_model": os.getenv("RAG_EMBEDDING_MODEL") or ANSWER_METRICS_UNAVAILABLE,
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
            retrieved = list(pipe.get("results") or [])
        except Exception:
            failed_count += 1
            per_case.append(_safe_case_result(case, k_values))
            continue

        latency_ms = (time.time() - t_start) * 1000
        retrieved_topics = [str(r.topic) for r in retrieved if getattr(r, "topic", None)]
        retrieved_sources = [str(r.source) for r in retrieved if getattr(r, "source", None)]
        all_snippets = " ".join(str(r.snippet) for r in retrieved)
        method = pipe.get("meta", {}).get("method", ANSWER_METRICS_UNAVAILABLE)
        route_decision = pipe.get("route_decision")
        route = route_decision.route if route_decision else ANSWER_METRICS_UNAVAILABLE

        metrics: Dict[str, Any] = {}
        for k in k_values:
            metrics[f"P@{k}"] = round(precision_at_k(retrieved_topics, case["expected_topics"], k), 4)
            metrics[f"Recall@{k}"] = round(recall_at_k(retrieved_topics, case["expected_topics"], k), 4)
            metrics[f"NDCG@{k}"] = round(ndcg_at_k(retrieved_topics, case["expected_topics"], k), 4)
        metrics["MRR"] = round(mrr(retrieved_topics, case["expected_topics"]), 4)
        metrics["keyword_overlap"] = round(keyword_overlap_score(all_snippets, case["expected_keywords"]), 4)
        metrics["source_match"] = source_match_count(case["expected_sources"], retrieved_sources)

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
                "sources": [display_source(s) for s in retrieved_sources][:10],
                "topics": [clean_public_label(t) for t in retrieved_topics][:10],
                "chunks": [clean_chunk_id(getattr(r, "metadata", {}).get("chunk_id"))
                           for r in retrieved][:10],
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


# ── 5. artifacts（timestamped run dir，不覆寫）──────────────────────

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
    run_dir = output_root / f"{timestamp}-{run_id}"
    if run_dir.exists():
        raise EvalCaseError(ERR_OUTPUT_EXISTS, f"run_dir {run_dir.name}")
    run_dir.mkdir(parents=True, exist_ok=False)

    results_path = run_dir / "results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(artifact, f, ensure_ascii=False, indent=2)

    summary_path = run_dir / "summary.md"
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(build_summary_md(artifact))

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
    args = parser.parse_args(argv)

    project_root = Path(__file__).resolve().parent.parent
    cases_path = Path(args.cases)
    if not cases_path.is_absolute():
        cases_path = project_root / args.cases
    output_root = Path(args.output_root)
    if not output_root.is_absolute():
        output_root = project_root / args.output_root

    try:
        for k in args.k:
            if not isinstance(k, int) or k <= 0:
                raise EvalCaseError(ERR_INVALID_K, f"k={k}")
        cases = load_cases(str(cases_path))
    except EvalCaseError as exc:
        print(f"ERROR: {exc}")
        return 1

    metadata = build_run_metadata(
        dataset_version=cases[0]["dataset_version"],
        case_count=len(cases),
        k_values=args.k,
        clock=args.clock,
        run_id=args.run_id,
    )
    print(f"Loaded {len(cases)} cases（dataset {metadata['dataset_version']}）")

    kb = get_kb()
    if not kb.is_loaded:
        kb.load_all()
    rag: RAGService = get_rag()
    print(f"Knowledge base: {'loaded' if kb.is_loaded else 'NOT loaded'}")

    def retrieve_fn(query: str, endpoint: str) -> Dict[str, Any]:
        return rag._retrieve_for_endpoint(query, endpoint=endpoint, max_results=5)

    evaluation = eval_cases(cases, retrieve_fn, args.k)

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

    timestamp = (datetime.fromisoformat(args.clock) if args.clock
                 else datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    try:
        paths = write_artifacts(output_root, artifact, metadata["run_id"], timestamp)
    except EvalCaseError as exc:
        print(f"ERROR: {exc}")
        return 1

    print(f"Run {metadata['run_id']} → {paths['run_dir']}")
    print(f"  results.json / summary.md written")
    print(f"  Cases: completed {counts['completed']} / failed {counts['failed']} / total {counts['total']}")
    print(f"  Overall MRR: {artifact['overall']['MRR']}（sample {artifact['overall']['sample_count']}）")
    print(f"  run_status: {metadata['run_status']}")
    if args.verbose:
        for c in artifact["per_case"]:
            print(f"  [{c['endpoint']}] {c['case_id']} {c['retrieval_status']}"
                  f"{(' error=' + c['error_code']) if c['error_code'] else ''}")

    return 0 if counts["failed"] == 0 else 1


def main() -> None:
    sys.exit(run_cli())


if __name__ == "__main__":
    main()
