#!/usr/bin/env python3
"""
RAG Evaluation Script — offline evaluation harness for the RAG pipeline.
Evaluates retrieval quality against labeled test cases.

Metrics supported:
  - Context Recall@K
  - Precision@K
  - MRR (Mean Reciprocal Rank)
  - NDCG@K
  - No-answer accuracy
  - Latency (avg, p50, p95, p99)
  - Faithfulness (optional, requires LLM judge)

Usage:
  python scripts/eval_rag.py
  python scripts/eval_rag.py --cases eval/rag_eval_cases.jsonl
  python scripts/eval_rag.py --cases eval/rag_eval_cases.jsonl --output results.json
  python scripts/eval_rag.py --faithfulness  # Enable LLM-based faithfulness eval (requires API key)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Add parent dir to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.rag_service import RAGService, get_rag
from services.knowledge_base import get_kb


def load_cases(path: str) -> List[Dict[str, Any]]:
    """Load eval cases from JSONL file."""
    cases = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                cases.append(json.loads(line))
    return cases


def precision_at_k(retrieved_topics: List[str], expected_topics: List[str], k: int) -> float:
    """Precision@K: fraction of top-K results that match expected topics."""
    if k <= 0 or not expected_topics:
        return 0.0
    top_k = retrieved_topics[:k]
    hits = sum(1 for t in top_k if t in expected_topics)
    return hits / k


def recall_at_k(retrieved_topics: List[str], expected_topics: List[str], k: int) -> float:
    """Recall@K: fraction of expected topics found in top-K results."""
    if not expected_topics:
        return 1.0
    top_k = retrieved_topics[:k]
    hits = sum(1 for t in expected_topics if t in top_k)
    return hits / len(expected_topics)


def mrr(retrieved_topics: List[str], expected_topics: List[str]) -> float:
    """Mean Reciprocal Rank: 1/rank of first relevant result."""
    for i, t in enumerate(retrieved_topics):
        if t in expected_topics:
            return 1.0 / (i + 1)
    return 0.0


def ndcg_at_k(retrieved_topics: List[str], expected_topics: List[str], k: int) -> float:
    """NDCG@K: Normalized Discounted Cumulative Gain."""
    if k <= 0 or not expected_topics:
        return 0.0

    # Binary relevance: 1 if in expected, 0 otherwise
    dcg = 0.0
    for i, t in enumerate(retrieved_topics[:k]):
        if t in expected_topics:
            dcg += 1.0 / (__import__("math").log2(i + 2))

    # IDCG: ideal ranking (all expected topics at top)
    import math
    idcg = sum(1.0 / math.log2(i + 2) for i in range(min(len(expected_topics), k)))

    return dcg / idcg if idcg > 0 else 0.0


def keyword_overlap_score(retrieved_text: str, expected_keywords: List[str]) -> float:
    """Simple keyword overlap ratio."""
    if not expected_keywords:
        return 1.0
    text_lower = retrieved_text.lower()
    hits = sum(1 for kw in expected_keywords if kw.lower() in text_lower)
    return hits / len(expected_keywords)


def eval_retrieval(
    rag: RAGService,
    cases: List[Dict[str, Any]],
    k_values: List[int] = [3, 5],
) -> Dict[str, Any]:
    """Run retrieval evaluation on all cases."""
    results = {
        "total_cases": len(cases),
        "per_case": [],
        "precision": {f"P@{k}": [] for k in k_values},
        "recall": {f"Recall@{k}": [] for k in k_values},
        "ndcg": {f"NDCG@{k}": [] for k in k_values},
        "mrr_values": [],
        "keyword_overlap": [],
        "latencies": [],
        "no_answer_correct": 0,
        "no_answer_total": 0,
    }

    for case in cases:
        query = case["query"]
        endpoint = case.get("endpoint", "chat")
        expected_topics = case.get("expected_topics", [])
        expected_sources = case.get("expected_sources", [])
        expected_keywords = case.get("expected_keywords", [])
        gold_answer = case.get("gold_answer", "")

        t_start = time.time()
        try:
            pipe = rag._retrieve_for_endpoint(query, endpoint=endpoint, max_results=5)
        except Exception as exc:
            print(f"  [ERROR] {query[:50]}: {exc}")
            continue

        latency_ms = (time.time() - t_start) * 1000
        results["latencies"].append(latency_ms)

        retrieved = pipe["results"]
        retrieved_topics = [r.topic for r in retrieved]
        all_snippets = " ".join(r.snippet for r in retrieved)
        method = pipe["meta"].get("method", "keyword")
        route = pipe["route_decision"].route if pipe["route_decision"] else "unknown"

        # Calculate metrics
        case_result = {
            "query": query,
            "endpoint": endpoint,
            "result_count": len(retrieved),
            "method": method,
            "route": route,
            "latency_ms": round(latency_ms, 1),
        }

        for k in k_values:
            p = precision_at_k(retrieved_topics, expected_topics, k)
            r = recall_at_k(retrieved_topics, expected_topics, k)
            n = ndcg_at_k(retrieved_topics, expected_topics, k)
            results["precision"][f"P@{k}"].append(p)
            results["recall"][f"Recall@{k}"].append(r)
            results["ndcg"][f"NDCG@{k}"].append(n)
            case_result[f"P@{k}"] = round(p, 3)
            case_result[f"Recall@{k}"] = round(r, 3)
            case_result[f"NDCG@{k}"] = round(n, 3)

        m = mrr(retrieved_topics, expected_topics)
        results["mrr_values"].append(m)
        case_result["MRR"] = round(m, 3)

        kw_overlap = keyword_overlap_score(all_snippets, expected_keywords)
        results["keyword_overlap"].append(kw_overlap)
        case_result["keyword_overlap"] = round(kw_overlap, 3)

        # Source match
        case_result["source_match"] = sum(
            1 for s in expected_sources if any(s in r.source for r in retrieved)
        )
        case_result["top_topics"] = retrieved_topics[:3]
        case_result["expected_topics"] = expected_topics

        results["per_case"].append(case_result)

    # Aggregate
    agg = {
        "total_cases": len(cases),
        "completed_cases": len(results["per_case"]),
        "avg_latency_ms": _avg(results["latencies"]),
        "p50_latency_ms": _percentile(results["latencies"], 50),
        "p95_latency_ms": _percentile(results["latencies"], 95),
        "p99_latency_ms": _percentile(results["latencies"], 99),
        "MRR": _avg(results["mrr_values"]),
        "avg_keyword_overlap": _avg(results["keyword_overlap"]),
    }

    for k in k_values:
        agg[f"P@{k}"] = _avg(results["precision"][f"P@{k}"])
        agg[f"Recall@{k}"] = _avg(results["recall"][f"Recall@{k}"])
        agg[f"NDCG@{k}"] = _avg(results["ndcg"][f"NDCG@{k}"])

    # Method distribution
    methods = {}
    for c in results["per_case"]:
        m = c.get("method", "keyword")
        methods[m] = methods.get(m, 0) + 1
    agg["method_distribution"] = methods

    # Route distribution
    routes = {}
    for c in results["per_case"]:
        r = c.get("route", "unknown")
        routes[r] = routes.get(r, 0) + 1
    agg["route_distribution"] = routes

    return {"aggregate": agg, "per_case": results["per_case"]}


def eval_faithfulness(
    cases: List[Dict[str, Any]],
    rag: RAGService,
) -> Optional[List[Dict[str, Any]]]:
    """
    Optional LLM-judge faithfulness evaluation.
    Checks if generated answers are supported by retrieved context.
    Requires OPENAI_API_KEY.
    """
    api_key = os.getenv("OPENAI_API_KEY", "").strip().strip('"').strip("'")
    if not api_key or "sk-" not in api_key:
        print("  [SKIP] Faithfulness eval requires OPENAI_API_KEY")
        return None

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
    except Exception:
        print("  [SKIP] OpenAI client not available")
        return None

    faithfulness_results = []
    for case in cases:
        query = case["query"]
        endpoint = case.get("endpoint", "chat")
        gold = case.get("gold_answer", "")

        try:
            pipe = rag._retrieve_for_endpoint(query, endpoint=endpoint, max_results=3)
        except Exception:
            continue

        context = "\n".join(r.snippet[:300] for r in pipe["results"][:3])

        # Generate an answer
        try:
            resp = client.chat.completions.create(
                model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                messages=[
                    {"role": "system", "content": f"根據以下知識回答問題。\n知識：\n{context}"},
                    {"role": "user", "content": query},
                ],
                max_tokens=300,
            )
            answer = resp.choices[0].message.content
        except Exception:
            continue

        # Judge: is the answer faithful to the context?
        try:
            judge_resp = client.chat.completions.create(
                model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                messages=[
                    {"role": "system", "content": (
                        "Judge whether the ANSWER is factually supported by the CONTEXT. "
                        "Reply with ONLY a JSON: {\"faithful\": true/false, \"reason\": \"...\"}"
                    )},
                    {"role": "user", "content": f"CONTEXT:\n{context}\n\nANSWER:\n{answer}"},
                ],
                max_tokens=150,
                response_format={"type": "json_object"},
            )
            judge = json.loads(judge_resp.choices[0].message.content)
        except Exception:
            judge = {"faithful": None, "reason": "judge_failed"}

        faithfulness_results.append({
            "query": query,
            "faithful": judge.get("faithful"),
            "reason": judge.get("reason", ""),
            "answer": answer[:300],
        })

    return faithfulness_results


def _avg(values: List[float]) -> float:
    return round(sum(values) / len(values), 4) if values else 0.0


def _percentile(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    import math
    sorted_vals = sorted(values)
    idx = (p / 100.0) * (len(sorted_vals) - 1)
    lower = int(math.floor(idx))
    upper = int(math.ceil(idx))
    if lower == upper:
        return round(sorted_vals[lower], 1)
    frac = idx - lower
    return round(sorted_vals[lower] * (1 - frac) + sorted_vals[upper] * frac, 1)


def main():
    parser = argparse.ArgumentParser(description="RAG Evaluation Harness")
    parser.add_argument(
        "--cases", default="eval/rag_eval_cases.jsonl",
        help="Path to eval cases JSONL file",
    )
    parser.add_argument(
        "--output", default=None,
        help="Path to save detailed JSON results",
    )
    parser.add_argument(
        "--faithfulness", action="store_true",
        help="Enable LLM-based faithfulness evaluation",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Print per-case results",
    )
    args = parser.parse_args()

    cases_path = Path(args.cases)
    if not cases_path.is_absolute():
        cases_path = Path(__file__).resolve().parent.parent / args.cases

    print(f"Loading cases from: {cases_path}")
    if not cases_path.exists():
        print(f"ERROR: Cases file not found: {cases_path}")
        sys.exit(1)

    cases = load_cases(str(cases_path))
    print(f"Loaded {len(cases)} eval cases")

    # Ensure KB is loaded
    kb = get_kb()
    if not kb.is_loaded:
        kb.load_all()
    print(f"Knowledge base: {'loaded' if kb.is_loaded else 'NOT loaded'}")

    rag = get_rag()
    print(f"RAG service: {'ready' if rag.kb_loaded else 'kb not loaded'}")

    # Run evaluation
    print("\n" + "=" * 60)
    print("Running retrieval evaluation...")
    print("=" * 60)

    results = eval_retrieval(rag, cases)

    # Print aggregate results
    agg = results["aggregate"]
    print("\n── Aggregate Results ──")
    print(f"  Cases: {agg['completed_cases']}/{agg['total_cases']}")
    print(f"  MRR:   {agg['MRR']:.4f}")
    print(f"  P@3:   {agg.get('P@3', 'N/A'):.4f}" if 'P@3' in agg else "")
    print(f"  P@5:   {agg.get('P@5', 'N/A'):.4f}" if 'P@5' in agg else "")
    print(f"  Recall@3: {agg.get('Recall@3', 'N/A'):.4f}" if 'Recall@3' in agg else "")
    print(f"  Recall@5: {agg.get('Recall@5', 'N/A'):.4f}" if 'Recall@5' in agg else "")
    print(f"  NDCG@3:   {agg.get('NDCG@3', 'N/A'):.4f}" if 'NDCG@3' in agg else "")
    print(f"  NDCG@5:   {agg.get('NDCG@5', 'N/A'):.4f}" if 'NDCG@5' in agg else "")
    print(f"  Avg keyword overlap: {agg['avg_keyword_overlap']:.4f}")
    print(f"  Avg latency:  {agg['avg_latency_ms']:.1f}ms")
    print(f"  P50 latency:  {agg['p50_latency_ms']:.1f}ms")
    print(f"  P95 latency:  {agg['p95_latency_ms']:.1f}ms")
    print(f"  P99 latency:  {agg['p99_latency_ms']:.1f}ms")
    print(f"  Method dist:  {agg['method_distribution']}")
    print(f"  Route dist:   {agg['route_distribution']}")

    # Per-case details
    if args.verbose:
        print("\n── Per-Case Details ──")
        for c in results["per_case"]:
            print(f"  [{c['endpoint']}] {c['query'][:50]}")
            print(f"    Topics: {c['top_topics']} | Expected: {c['expected_topics']}")
            print(f"    Method: {c['method']} | Route: {c['route']} | Lat: {c['latency_ms']}ms")
            p3 = c.get('P@3', 'N/A')
            r3 = c.get('Recall@3', 'N/A')
            mrr_val = c.get('MRR', 'N/A')
            print(f"    P@3={p3} Recall@3={r3} MRR={mrr_val}")

    # Faithfulness eval
    if args.faithfulness:
        print("\n── Faithfulness Evaluation (LLM Judge) ──")
        faith_results = eval_faithfulness(cases, rag)
        if faith_results:
            faithful_count = sum(1 for f in faith_results if f["faithful"] is True)
            total = len(faith_results)
            print(f"  Faithful: {faithful_count}/{total} ({faithful_count/max(total,1)*100:.1f}%)")
            results["faithfulness"] = faith_results

    # Save results
    if args.output:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = Path(__file__).resolve().parent.parent / args.output
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"\nResults saved to: {output_path}")


if __name__ == "__main__":
    main()
