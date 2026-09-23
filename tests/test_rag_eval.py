"""
TASK 05A — eval dataset loader／deterministic metrics／artifacts 測試。

覆蓋：15 題 metadata 驗證、fail-closed 反例（固定 code＋行號、無 raw
exception/query/路徑）、手算 metric 邊界、aggregate 樣本數、retrieval
exception 標 failed 且不洩漏合成 token、artifact 不覆寫與 run_id 一致、
answer metrics 一律 unavailable、CLI non-zero。
"""

import json
import math
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import scripts.eval_rag as eval_rag  # noqa: E402

CASES_PATH = PROJECT_ROOT / "eval" / "rag_eval_cases.jsonl"
FAKE_TOKEN = "sk-fake-eval-secret-DO-NOT-LOG"


def make_result(topic, source="data/knowledge/investment_rules.md", snippet="定期定額是基礎"):
    return types.SimpleNamespace(topic=topic, source=source, snippet=snippet,
                                 metadata={"chunk_id": "investment_rules#3"})


class DatasetLoaderTests(unittest.TestCase):
    def test_loads_15_cases_with_valid_metadata(self):
        cases = eval_rag.load_cases(str(CASES_PATH))
        self.assertEqual(len(cases), 15)
        ids = [c["case_id"] for c in cases]
        self.assertEqual(len(set(ids)), 15)
        versions = {c["dataset_version"] for c in cases}
        self.assertEqual(len(versions), 1)
        self.assertEqual(versions.pop(), "rag-eval-15-v1-2026-08-20")
        for c in cases:
            self.assertEqual(c["review_status"], "pending_review")
            self.assertIsNone(c["reviewer"])
            self.assertIn(c["endpoint"], eval_rag.ALLOWED_ENDPOINTS)
            self.assertIsInstance(c["expected_topics"], list)
            self.assertIsInstance(c["expected_sources"], list)
            self.assertIsInstance(c["expected_keywords"], list)
            self.assertTrue(c["expected_topics"])
            self.assertTrue(c["expected_sources"])
            self.assertTrue(c["expected_keywords"])

    def _write_cases(self, lines):
        import tempfile
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".jsonl", delete=False, encoding="utf-8")
        tmp.write("\n".join(lines))
        tmp.close()
        self.addCleanup(lambda: Path(tmp.name).unlink(missing_ok=True))
        return tmp.name

    def _base_case(self, **overrides):
        case = {
            "case_id": "case-001", "dataset_version": "rag-eval-15-v1-2026-08-20",
            "review_status": "pending_review", "reviewer": None,
            "query": "測試問題", "endpoint": "chat",
            "expected_topics": ["投資原則"], "expected_sources": ["investment_rules"],
            "expected_keywords": ["關鍵字"], "gold_answer": "參考答案",
        }
        case.update(overrides)
        return case

    def _assert_fail_closed(self, lines, code, expect_line=True):
        path = self._write_cases(lines)
        with self.assertRaises(eval_rag.EvalCaseError) as ctx:
            eval_rag.load_cases(path)
        self.assertEqual(ctx.exception.code, code)
        message = str(ctx.exception)
        if expect_line:
            self.assertIn("line", message)
        self.assertNotIn("Traceback", message)

    def test_malformed_json_fail_closed(self):
        self._assert_fail_closed(['{"case_id": "x", ...not json'], eval_rag.ERR_INVALID_JSON)

    def test_missing_field_fail_closed(self):
        case = self._base_case()
        case.pop("gold_answer")
        self._assert_fail_closed([json.dumps(case, ensure_ascii=False)],
                                 eval_rag.ERR_MISSING_FIELD)

    def test_expected_topics_as_string_rejected(self):
        case = self._base_case(expected_topics="投資原則")
        self._assert_fail_closed([json.dumps(case, ensure_ascii=False)],
                                 eval_rag.ERR_BAD_TYPE)

    def test_endpoint_and_review_status_wrong_types_fail_closed(self):
        for field, value, code in [
            ("endpoint", [], eval_rag.ERR_BAD_TYPE),
            ("review_status", [], eval_rag.ERR_BAD_REVIEW_STATUS),
        ]:
            case = self._base_case(**{field: value})
            self._assert_fail_closed([json.dumps(case, ensure_ascii=False)], code)

    def test_unsafe_case_id_not_echoed_and_duplicate_id_is_safe(self):
        unsafe = f"Bearer-{FAKE_TOKEN}"
        case = self._base_case(case_id=unsafe)
        path = self._write_cases([json.dumps(case, ensure_ascii=False)])
        with self.assertRaises(eval_rag.EvalCaseError) as ctx:
            eval_rag.load_cases(path)
        self.assertEqual(ctx.exception.code, eval_rag.ERR_BAD_TYPE)
        self.assertNotIn(unsafe, str(ctx.exception))
        self.assertNotIn(FAKE_TOKEN, str(ctx.exception))

        duplicate = json.dumps(self._base_case(case_id="safe-001"), ensure_ascii=False)
        path = self._write_cases([duplicate, duplicate])
        with self.assertRaises(eval_rag.EvalCaseError) as ctx:
            eval_rag.load_cases(path)
        self.assertEqual(ctx.exception.code, eval_rag.ERR_DUPLICATE_ID)
        self.assertNotIn("safe-001", str(ctx.exception))

    def test_duplicate_case_id_fail_closed(self):
        lines = [json.dumps(self._base_case(case_id="case-001"), ensure_ascii=False),
                 json.dumps(self._base_case(case_id="case-001"), ensure_ascii=False)]
        self._assert_fail_closed(lines, eval_rag.ERR_DUPLICATE_ID)

    def test_mixed_dataset_version_fail_closed(self):
        lines = [json.dumps(self._base_case(), ensure_ascii=False),
                 json.dumps(self._base_case(case_id="case-002",
                                            dataset_version="other-version"),
                            ensure_ascii=False)]
        self._assert_fail_closed(lines, eval_rag.ERR_VERSION_MISMATCH, expect_line=False)

    def test_fake_reviewer_fail_closed(self):
        case = self._base_case(reviewer="someone")
        self._assert_fail_closed([json.dumps(case, ensure_ascii=False)],
                                 eval_rag.ERR_BAD_REVIEW_STATUS)

    def test_approved_review_status_fail_closed(self):
        case = self._base_case(review_status="approved")
        self._assert_fail_closed([json.dumps(case, ensure_ascii=False)],
                                 eval_rag.ERR_BAD_REVIEW_STATUS)

    def test_empty_expected_topics_fail_closed(self):
        case = self._base_case(expected_topics=[])
        self._assert_fail_closed([json.dumps(case, ensure_ascii=False)],
                                 eval_rag.ERR_EMPTY_EXPECTED)

    def test_error_message_contains_no_query_or_path(self):
        case = self._base_case(query="超敏感問題內容")
        case.pop("endpoint")
        path = self._write_cases([json.dumps(case, ensure_ascii=False)])
        with self.assertRaises(eval_rag.EvalCaseError) as ctx:
            eval_rag.load_cases(path)
        message = str(ctx.exception)
        self.assertNotIn("超敏感問題內容", message)
        self.assertNotIn(str(PROJECT_ROOT), message)
        self.assertNotIn(str(path), message)


class DeterministicMetricTests(unittest.TestCase):
    def test_precision_at_k_hit_and_miss(self):
        self.assertAlmostEqual(eval_rag.precision_at_k(["a", "b", "c"], ["a", "x"], 3), 1 / 3)
        self.assertAlmostEqual(eval_rag.precision_at_k(["a", "a", "b"], ["a"], 3), 1 / 3)

    def test_precision_k_larger_than_results(self):
        # K 恆為分母：3 筆結果中僅 "a" 命中 → P@5 = 1/5
        self.assertAlmostEqual(eval_rag.precision_at_k(["a", "b", "c"], ["a", "x"], 5), 1 / 5)

    def test_recall_at_k(self):
        self.assertAlmostEqual(eval_rag.recall_at_k(["a", "b", "c"], ["a", "x"], 3), 1 / 2)
        self.assertAlmostEqual(eval_rag.recall_at_k(["a", "b", "c"], ["a", "b", "x"], 3), 2 / 3)

    def test_mrr_rank(self):
        self.assertAlmostEqual(eval_rag.mrr(["x", "a", "b"], ["a"]), 1 / 2)
        self.assertAlmostEqual(eval_rag.mrr(["x", "y"], ["a"]), 0.0)

    def test_ndcg_at_k_hand_computed(self):
        # retrieved=[a,b,c], expected=[a,c]：DCG=1/log2(2)+1/log2(4)；
        # IDCG=1/log2(2)+1/log2(3)
        expected_dcg = 1 / math.log2(2) + 1 / math.log2(4)
        expected_idcg = 1 / math.log2(2) + 1 / math.log2(3)
        self.assertAlmostEqual(
            eval_rag.ndcg_at_k(["a", "b", "c"], ["a", "c"], 3),
            expected_dcg / expected_idcg)

    def test_duplicate_retrieved_counts_distinct_topic_once(self):
        # 同一 expected topic 僅第一次命中貢獻 relevance。
        self.assertAlmostEqual(eval_rag.precision_at_k(["a", "a", "b"], ["a"], 3), 1 / 3)
        self.assertAlmostEqual(eval_rag.recall_at_k(["a", "a", "a"], ["a"], 3), 1.0)
        self.assertAlmostEqual(eval_rag.ndcg_at_k(["a", "a", "a"], ["a"], 3), 1.0)
        self.assertLessEqual(eval_rag.ndcg_at_k(["a", "a", "a"], ["a"], 3), 1.0)
        self.assertAlmostEqual(eval_rag.mrr(["a", "a"], ["a"]), 1.0)

    def test_empty_retrieved_all_zero(self):
        self.assertAlmostEqual(eval_rag.precision_at_k([], ["a"], 3), 0.0)
        self.assertAlmostEqual(eval_rag.recall_at_k([], ["a"], 3), 0.0)
        self.assertAlmostEqual(eval_rag.mrr([], ["a"]), 0.0)
        self.assertAlmostEqual(eval_rag.ndcg_at_k([], ["a"], 3), 0.0)

    def test_invalid_k_raises(self):
        for k in [0, -1]:
            with self.assertRaises(ValueError):
                eval_rag.precision_at_k(["a"], ["a"], k)
            with self.assertRaises(ValueError):
                eval_rag.ndcg_at_k(["a"], ["a"], k)

    def test_empty_expected_raises(self):
        with self.assertRaises(ValueError):
            eval_rag.precision_at_k(["a"], [], 3)
        with self.assertRaises(ValueError):
            eval_rag.keyword_overlap_score("text", [])

    def test_keyword_overlap(self):
        self.assertAlmostEqual(
            eval_rag.keyword_overlap_score("比特幣DCA長期", ["比特幣", "不存在"]), 0.5)

    def test_source_match(self):
        self.assertAlmostEqual(
            eval_rag.source_match_count(["investment_rules", "missing"],
                                        ["data/knowledge/investment_rules.md"]), 0.5)
        self.assertAlmostEqual(
            eval_rag.source_match_count(["rules"], ["not_rules_backup.md"]), 0.0)


class EvalCasesTests(unittest.TestCase):
    def _cases(self, n=2):
        return [{
            "case_id": f"case-{i:03d}", "dataset_version": "v1",
            "review_status": "pending_review", "reviewer": None,
            "query": f"問題{i}", "endpoint": "chat",
            "expected_topics": ["投資原則"], "expected_sources": ["investment_rules"],
            "expected_keywords": ["關鍵字"], "gold_answer": "參考",
        } for i in range(1, n + 1)]

    def _retrieve_ok(self):
        return lambda query, endpoint: {
            "results": [make_result("投資原則"), make_result("市場敘事",
                      source="data/knowledge/coin_profiles.json",
                      snippet="比特幣波動高")],
            "meta": {"method": "hybrid"},
            "route_decision": types.SimpleNamespace(route="deep"),
        }

    def test_success_path_metrics_and_safe_fields(self):
        evaluation = eval_rag.eval_cases(self._cases(2), self._retrieve_ok(), [3])
        self.assertEqual(evaluation["case_counts"], {"total": 2, "completed": 2, "failed": 0})
        case0 = evaluation["per_case"][0]
        self.assertEqual(case0["retrieval_status"], "completed")
        self.assertIsNone(case0["error_code"])
        self.assertAlmostEqual(case0["metrics"]["P@3"], 1 / 3, places=3)
        self.assertAlmostEqual(case0["metrics"]["MRR"], 1.0)
        self.assertEqual(case0["retrieved"]["sources"][0], "investment_rules.md")
        self.assertEqual(case0["retrieved"]["chunks"][0], "investment_rules#3")
        self.assertNotIn("data/knowledge", json.dumps(case0["retrieved"], ensure_ascii=False))
        self.assertEqual(case0["answer_metrics"]["faithfulness"],
                         eval_rag.ANSWER_METRICS_UNAVAILABLE)
        self.assertEqual(case0["answer_metrics"]["reason"],
                         eval_rag.ANSWER_METRICS_REASON)
        self.assertEqual(evaluation["overall"]["sample_count"], 2)
        self.assertEqual(evaluation["per_endpoint"]["chat"]["sample_count"], 2)

    def test_retrieval_exception_marked_failed_not_skipped(self):
        def flaky(query, endpoint):
            if query == "問題1":
                raise RuntimeError(f"boom {FAKE_TOKEN}")
            return self._retrieve_ok()(query, endpoint)

        evaluation = eval_rag.eval_cases(self._cases(2), flaky, [3])
        self.assertEqual(evaluation["case_counts"], {"total": 2, "completed": 1, "failed": 1})
        failed_case = [c for c in evaluation["per_case"]
                       if c["retrieval_status"] == "failed"][0]
        self.assertEqual(failed_case["error_code"], eval_rag.ERR_RETRIEVAL_FAILED)
        self.assertEqual(failed_case["metrics"]["MRR"], eval_rag.ANSWER_METRICS_UNAVAILABLE)
        # 合成 token 不得出現在任何結果
        self.assertNotIn(FAKE_TOKEN, json.dumps(evaluation, ensure_ascii=False))
        # aggregate 只計 completed 樣本
        self.assertEqual(evaluation["overall"]["sample_count"], 1)

    def test_all_failed_latency_unavailable(self):
        def broken(query, endpoint):
            raise RuntimeError("boom")

        evaluation = eval_rag.eval_cases(self._cases(2), broken, [3])
        latency = evaluation["overall"]["latency"]
        self.assertEqual(latency["count"], 0)
        self.assertEqual(latency["avg_ms"], eval_rag.ANSWER_METRICS_UNAVAILABLE)
        self.assertEqual(latency["p50_ms"], eval_rag.ANSWER_METRICS_UNAVAILABLE)
        self.assertEqual(evaluation["overall"]["MRR"], eval_rag.ANSWER_METRICS_UNAVAILABLE)

    def test_latency_stats_computed(self):
        evaluation = eval_rag.eval_cases(self._cases(2), self._retrieve_ok(), [3])
        latency = evaluation["overall"]["latency"]
        self.assertEqual(latency["count"], 2)
        self.assertIsInstance(latency["avg_ms"], float)
        self.assertIsInstance(latency["p50_ms"], float)

    def test_invalid_k_rejected(self):
        with self.assertRaises(eval_rag.EvalCaseError) as ctx:
            eval_rag.eval_cases(self._cases(1), self._retrieve_ok(), [0])
        self.assertEqual(ctx.exception.code, eval_rag.ERR_INVALID_K)

    def test_malformed_result_is_failed_and_next_case_continues(self):
        calls = 0

        def malformed_then_ok(query, endpoint):
            nonlocal calls
            calls += 1
            if calls == 1:
                return {"results": [types.SimpleNamespace(
                    topic="投資原則", source="rules.md", metadata={})]}
            return self._retrieve_ok()(query, endpoint)

        evaluation = eval_rag.eval_cases(self._cases(2), malformed_then_ok, [3])
        self.assertEqual(evaluation["case_counts"], {"total": 2, "completed": 1, "failed": 1})
        self.assertEqual(evaluation["per_case"][0]["error_code"],
                         eval_rag.ERR_RETRIEVAL_FAILED)
        self.assertEqual(evaluation["per_case"][1]["retrieval_status"], "completed")

    def test_method_and_route_are_sanitized(self):
        secret = f"Bearer {FAKE_TOKEN}"

        def retrieve(query, endpoint):
            return {
                "results": [make_result("投資原則")],
                "meta": {"method": secret},
                "route_decision": types.SimpleNamespace(route=secret),
            }

        evaluation = eval_rag.eval_cases(self._cases(1), retrieve, [3])
        encoded = json.dumps(evaluation, ensure_ascii=False)
        self.assertNotIn(FAKE_TOKEN, encoded)
        self.assertIn("<API_KEY>", evaluation["per_case"][0]["method"])
        self.assertIn("<API_KEY>", evaluation["per_case"][0]["route"])


class ArtifactTests(unittest.TestCase):
    def _artifact(self):
        cases = [{
            "case_id": "case-001", "dataset_version": "v1",
            "review_status": "pending_review", "reviewer": None,
            "query": "問題", "endpoint": "chat",
            "expected_topics": ["投資原則"], "expected_sources": ["investment_rules"],
            "expected_keywords": ["關鍵字"], "gold_answer": "參考",
        }]
        retrieve = lambda q, e: {
            "results": [make_result("投資原則")],
            "meta": {"method": "hybrid"},
            "route_decision": types.SimpleNamespace(route="deep"),
        }
        metadata = eval_rag.build_run_metadata(
            dataset_version="v1", case_count=1, k_values=[3],
            clock="2026-08-20T12:00:00+00:00", run_id="testrun1")
        evaluation = eval_rag.eval_cases(cases, retrieve, [3])
        metadata["ended_at"] = "2026-08-20T12:00:01+00:00"
        metadata["run_status"] = "completed"
        return {
            "metadata": metadata,
            "case_counts": evaluation["case_counts"],
            "overall": evaluation["overall"],
            "per_endpoint": evaluation["per_endpoint"],
            "per_case": evaluation["per_case"],
        }

    def test_write_artifacts_and_no_overwrite(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp)
            paths = eval_rag.write_artifacts(
                output_root, self._artifact(), run_id="testrun1", timestamp="20260820T120000Z")
            run_dir = Path(paths["run_dir"])
            self.assertTrue((run_dir / "results.json").exists())
            self.assertTrue((run_dir / "summary.md").exists())
            # 同 clock/run-id 再次寫入 → fail closed
            with self.assertRaises(eval_rag.EvalCaseError) as ctx:
                eval_rag.write_artifacts(
                    output_root, self._artifact(), run_id="testrun1",
                    timestamp="20260820T120000Z")
            self.assertEqual(ctx.exception.code, eval_rag.ERR_OUTPUT_EXISTS)
            # 不同 run_id → 新目錄，不覆寫
            artifact2 = self._artifact()
            artifact2["metadata"]["run_id"] = "testrun2"
            paths2 = eval_rag.write_artifacts(
                output_root, artifact2, run_id="testrun2",
                timestamp="20260820T120000Z")
            self.assertNotEqual(paths["run_dir"], paths2["run_dir"])
            self.assertTrue(Path(paths2["run_dir"]).exists())

    def test_json_and_markdown_run_id_and_values_consistent(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp)
            artifact = self._artifact()
            paths = eval_rag.write_artifacts(
                output_root, artifact, run_id="testrun1", timestamp="20260820T120000Z")
            run_dir = Path(paths["run_dir"])
            results = json.loads((run_dir / "results.json").read_text(encoding="utf-8"))
            summary = (run_dir / "summary.md").read_text(encoding="utf-8")
            self.assertEqual(results["metadata"]["run_id"], "testrun1")
            self.assertIn("RAG Eval Run testrun1", summary)
            self.assertIn("dataset_version: v1", summary)
            self.assertIn("completed 1", summary)
            self.assertEqual(results["overall"]["sample_count"], 1)
            self.assertIn("sample_count: 1", summary)
            self.assertIn("not_evaluated_in_task_05a", summary)
            self.assertEqual(results["metadata"]["run_status"], "completed")

    def test_run_id_traversal_and_unsafe_values_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp) / "results"
            escaped = Path(tmp).parent / "escaped"
            for run_id in ["slot/../../escaped", "/absolute", "line\nbreak", "back\\slash", "a..b"]:
                with self.assertRaises(eval_rag.EvalCaseError) as ctx:
                    eval_rag.write_artifacts(
                        output_root, self._artifact(), run_id=run_id,
                        timestamp="20260820T120000Z")
                self.assertEqual(ctx.exception.code, eval_rag.ERR_INVALID_RUN_ID)
            self.assertFalse(escaped.exists())
            self.assertFalse(output_root.exists())

    def test_git_provenance_uses_project_root_from_other_cwd(self):
        expected = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=PROJECT_ROOT,
            capture_output=True, text=True, check=True).stdout.strip()
        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                os.chdir(tmp)
                self.assertEqual(eval_rag.git_code_commit(), expected)
                self.assertIsInstance(eval_rag.git_dirty(), bool)
            finally:
                os.chdir(original_cwd)
        with mock.patch.dict(os.environ, {"RAG_EMBEDDING_MODEL": f"Bearer {FAKE_TOKEN}"}):
            metadata = eval_rag.build_run_metadata(
                dataset_version="v1", case_count=1, k_values=[3],
                clock="2026-08-20T12:00:00+00:00", run_id="safe-model")
        self.assertNotIn(FAKE_TOKEN, json.dumps(metadata, ensure_ascii=False))

    def test_artifact_run_id_mismatch_fails_before_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp) / "results"
            with self.assertRaises(eval_rag.EvalCaseError) as ctx:
                eval_rag.write_artifacts(
                    output_root, self._artifact(), run_id="different-run",
                    timestamp="20260820T120000Z")
            self.assertEqual(ctx.exception.code, eval_rag.ERR_ARTIFACT_MISMATCH)
            self.assertFalse(output_root.exists())


class BaselineTests(unittest.TestCase):
    def _artifact(self, run_id="baseline-run"):
        artifact = ArtifactTests()._artifact()
        artifact["metadata"]["run_id"] = run_id
        artifact["metadata"]["code"] = {"commit": "a" * 40, "dirty": False}
        artifact["metadata"]["run_status"] = "completed"
        return artifact

    def _approve(self, project_root):
        artifact = self._artifact()
        paths = eval_rag.write_artifacts(
            project_root / "results", artifact, run_id="baseline-run",
            timestamp="20260820T120000Z")
        return artifact, eval_rag.approve_baseline(
            artifact, Path(paths["results_json"]), project_root / "baselines",
            "approved-v1", approved_at="2026-08-20T12:01:00+00:00",
            project_root=project_root)

    def test_explicit_approval_manifest_pointer_hash_and_immutable_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, approved = self._approve(root)
            manifest = approved["manifest"]
            self.assertEqual(manifest["schema_version"], eval_rag.BASELINE_SCHEMA_VERSION)
            self.assertEqual(manifest["baseline_id"], "approved-v1")
            self.assertFalse(Path(manifest["artifact_ref"]).is_absolute())
            self.assertEqual(len(manifest["artifact_sha256"]), 64)
            self.assertEqual(manifest["compatibility"]["case_ids"], ["case-001"])
            with self.assertRaises(eval_rag.EvalCaseError) as ctx:
                eval_rag.approve_baseline(
                    artifact,
                    root / manifest["artifact_ref"],
                    root / "baselines",
                    "approved-v1",
                    project_root=root)
            self.assertEqual(ctx.exception.code, eval_rag.ERR_BASELINE_EXISTS)

            mismatched = json.loads(json.dumps(artifact))
            mismatched["overall"]["MRR"] = 0.1234
            with self.assertRaises(eval_rag.EvalCaseError) as ctx:
                eval_rag.approve_baseline(
                    mismatched,
                    root / manifest["artifact_ref"],
                    root / "baselines",
                    "approved-v2",
                    project_root=root)
            self.assertEqual(ctx.exception.code, eval_rag.ERR_ARTIFACT_MISMATCH)

    def test_dirty_failed_and_unavailable_commit_cannot_be_approved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for mutation in ["dirty", "failed", "commit"]:
                artifact = self._artifact(run_id=f"run-{mutation}")
                if mutation == "dirty":
                    artifact["metadata"]["code"]["dirty"] = True
                elif mutation == "failed":
                    artifact["metadata"]["run_status"] = "completed_with_failures"
                    artifact["case_counts"]["failed"] = 1
                else:
                    artifact["metadata"]["code"]["commit"] = "unavailable"
                paths = eval_rag.write_artifacts(
                    root / "results", artifact, run_id=f"run-{mutation}",
                    timestamp=f"20260820T12000{len(mutation)}Z")
                with self.assertRaises(eval_rag.EvalCaseError) as ctx:
                    eval_rag.approve_baseline(
                        artifact, Path(paths["results_json"]), root / "baselines",
                        f"baseline-{mutation}", project_root=root)
                self.assertEqual(ctx.exception.code, eval_rag.ERR_BASELINE_INELIGIBLE)

    def test_compare_improved_stable_regressed_latency_and_thresholds(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline, approved = self._approve(root)
            current = json.loads(json.dumps(baseline))
            baseline_p = baseline["overall"]["P@3"]
            baseline_latency = baseline["overall"]["latency"]["avg_ms"]
            current["overall"]["P@3"] = round(baseline_p - 0.1, 4)
            current["overall"]["MRR"] = baseline["overall"]["MRR"]
            current["overall"]["keyword_overlap"] = min(
                1.0, baseline["overall"]["keyword_overlap"] + 0.1)
            current["overall"]["latency"]["avg_ms"] = baseline_latency + 5.0
            comparison = eval_rag.compare_to_baseline(
                current, Path(approved["manifest_path"]),
                thresholds={"P@3": 0.1, "latency.avg_ms": 5.0},
                project_root=root)
            self.assertEqual(comparison["metrics"]["P@3"]["status"], "regressed")
            self.assertEqual(comparison["metrics"]["MRR"]["status"], "stable")
            self.assertEqual(comparison["metrics"]["keyword_overlap"]["status"], "improved")
            self.assertEqual(comparison["metrics"]["latency.avg_ms"]["status"], "regressed")
            self.assertTrue(comparison["gate"]["passed"])

            failed = eval_rag.compare_to_baseline(
                current, Path(approved["manifest_path"]),
                thresholds={"P@3": 0.09, "latency.avg_ms": 4.9},
                project_root=root)
            self.assertFalse(failed["gate"]["passed"])
            self.assertEqual(failed["gate"]["failed_metrics"],
                             ["P@3", "latency.avg_ms"])

    def test_unavailable_threshold_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline, approved = self._approve(root)
            current = json.loads(json.dumps(baseline))
            current["overall"]["source_match"] = "unavailable"
            comparison = eval_rag.compare_to_baseline(
                current, Path(approved["manifest_path"]),
                thresholds={"source_match": 0.0}, project_root=root)
            self.assertEqual(comparison["metrics"]["source_match"]["status"], "unavailable")
            self.assertTrue(comparison["metrics"]["source_match"]["gate_failed"])

    def test_incompatible_dataset_cases_k_and_config_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline, approved = self._approve(root)
            mutations = {
                "dataset": lambda a: a["metadata"].update(dataset_version="v2"),
                "cases": lambda a: a["per_case"][0].update(case_id="case-999"),
                "k": lambda a: a["metadata"].update(k_values=[5]),
                "config": lambda a: a["metadata"]["config"].update(config_fingerprint="f" * 64),
            }
            for name, mutate in mutations.items():
                current = json.loads(json.dumps(baseline))
                mutate(current)
                with self.subTest(name=name), self.assertRaises(eval_rag.EvalCaseError) as ctx:
                    eval_rag.compare_to_baseline(
                        current, Path(approved["manifest_path"]), project_root=root)
                self.assertEqual(ctx.exception.code, eval_rag.ERR_BASELINE_INCOMPATIBLE)

    def test_tampered_artifact_hash_and_manifest_snapshot_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline, approved = self._approve(root)
            artifact_path = root / approved["manifest"]["artifact_ref"]
            artifact_path.write_text("{}", encoding="utf-8")
            with self.assertRaises(eval_rag.EvalCaseError) as ctx:
                eval_rag.compare_to_baseline(
                    baseline, Path(approved["manifest_path"]), project_root=root)
            self.assertEqual(ctx.exception.code, eval_rag.ERR_BASELINE_INVALID)

            bad_manifest = root / f"bad-{FAKE_TOKEN}.json"
            bad_manifest.write_text(f'{{"secret":"{FAKE_TOKEN}"', encoding="utf-8")
            with self.assertRaises(eval_rag.EvalCaseError) as ctx:
                eval_rag.compare_to_baseline(
                    baseline, bad_manifest, project_root=root)
            self.assertEqual(ctx.exception.code, eval_rag.ERR_BASELINE_INVALID)
            self.assertNotIn(FAKE_TOKEN, str(ctx.exception))

    def test_threshold_parser_allowlist_duplicate_and_nonfinite(self):
        self.assertEqual(
            eval_rag.parse_thresholds(["MRR=0.05", "latency.avg_ms=25"], [3]),
            {"MRR": 0.05, "latency.avg_ms": 25.0})
        for values in [["unknown=1"], ["MRR=-1"], ["MRR=nan"],
                       ["MRR=0.1", "MRR=0.2"], [FAKE_TOKEN]]:
            with self.assertRaises(eval_rag.EvalCaseError) as ctx:
                eval_rag.parse_thresholds(values, [3])
            self.assertEqual(ctx.exception.code, eval_rag.ERR_THRESHOLD_INVALID)


class CliTests(unittest.TestCase):
    def _captured_cli(self, argv):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = eval_rag.run_cli(argv)
        return code, stdout.getvalue() + stderr.getvalue()

    def _fake_rag(self, topic="投資原則"):
        class FakeRAG:
            def _retrieve_for_endpoint(self, query, endpoint="chat", **kwargs):
                return {
                    "results": [make_result(topic)],
                    "meta": {"method": "hybrid"},
                    "route_decision": types.SimpleNamespace(route="deep"),
                }
        return FakeRAG()

    def test_cli_nonzero_on_case_failure_and_no_token_in_output(self):
        import tempfile
        from services.rag_service import RAGService

        class FakeRAG:
            def _retrieve_for_endpoint(self, query, endpoint="chat", **kwargs):
                if query == "比特幣適合長期持有嗎":
                    raise RuntimeError(f"boom {FAKE_TOKEN}")
                return {
                    "results": [make_result("投資原則")],
                    "meta": {"method": "hybrid"},
                    "route_decision": types.SimpleNamespace(route="deep"),
                }

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(eval_rag, "get_rag", return_value=FakeRAG()), \
                 mock.patch.object(eval_rag, "get_kb",
                                   return_value=types.SimpleNamespace(
                                       is_loaded=True, load_all=lambda: True)):
                code = eval_rag.run_cli([
                    "--cases", str(CASES_PATH),
                    "--output-root", tmp,
                    "--run-id", "clitest1",
                    "--clock", "2026-08-20T12:00:00+00:00",
                    "--k", "3",
                ])
            self.assertEqual(code, 1)  # case 失敗 → non-zero，但 artifact 仍留下
            import glob
            run_dirs = glob.glob(str(Path(tmp) / "*-clitest1"))
            self.assertEqual(len(run_dirs), 1)
            results = json.loads(
                (Path(run_dirs[0]) / "results.json").read_text(encoding="utf-8"))
            self.assertIn("failed", results["case_counts"])
            self.assertGreaterEqual(results["case_counts"]["failed"], 1)
            self.assertEqual(results["metadata"]["run_status"], "completed_with_failures")
            self.assertNotIn(FAKE_TOKEN,
                             (Path(run_dirs[0]) / "results.json").read_text(encoding="utf-8"))
            self.assertNotIn(FAKE_TOKEN,
                             (Path(run_dirs[0]) / "summary.md").read_text(encoding="utf-8"))

    def test_cli_loader_failure_nonzero(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            bad_file = Path(tmp) / "bad.jsonl"
            bad_file.write_text('{"case_id": "x", not json\n', encoding="utf-8")
            code = eval_rag.run_cli(["--cases", str(bad_file),
                                     "--output-root", str(Path(tmp) / "out")])
        self.assertEqual(code, 1)
        self.assertEqual(list(Path(tmp).glob("out/*")), [])

    def test_cli_missing_cases_and_invalid_clock_are_fixed_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / f"missing-{FAKE_TOKEN}.jsonl")
            code, output = self._captured_cli([
                "--cases", missing, "--output-root", str(Path(tmp) / "out")])
            self.assertEqual(code, 1)
            self.assertIn(eval_rag.ERR_CASES_UNAVAILABLE, output)
            self.assertNotIn(FAKE_TOKEN, output)
            self.assertNotIn("Traceback", output)

            code, output = self._captured_cli([
                "--cases", str(CASES_PATH), "--output-root", str(Path(tmp) / "out"),
                "--clock", f"bad-{FAKE_TOKEN}"])
            self.assertEqual(code, 1)
            self.assertIn(eval_rag.ERR_INVALID_CLOCK, output)
            self.assertNotIn(FAKE_TOKEN, output)
            self.assertNotIn("Traceback", output)

    def test_cli_initialization_secret_is_fixed_code(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(eval_rag, "get_kb",
                               side_effect=RuntimeError(f"boom Bearer {FAKE_TOKEN}")):
            code, output = self._captured_cli([
                "--cases", str(CASES_PATH), "--output-root", tmp,
                "--clock", "2026-08-20T12:00:00+00:00", "--run-id", "initfail"])
        self.assertEqual(code, 1)
        self.assertIn(eval_rag.ERR_INITIALIZATION_FAILED, output)
        self.assertNotIn(FAKE_TOKEN, output)
        self.assertNotIn("Traceback", output)

    def test_cli_missing_baseline_leaves_artifact_and_safe_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(eval_rag, "get_rag", return_value=self._fake_rag()), \
             mock.patch.object(eval_rag, "get_kb", return_value=types.SimpleNamespace(
                 is_loaded=True, load_all=lambda: True)):
            output_root = Path(tmp) / "results"
            missing = Path(tmp) / f"missing-{FAKE_TOKEN}.json"
            code, output = self._captured_cli([
                "--cases", str(CASES_PATH), "--output-root", str(output_root),
                "--run-id", "missingbase", "--clock", "2026-08-20T13:00:00+00:00",
                "--k", "3", "--baseline", str(missing), "--threshold", "MRR=0",
            ])
            self.assertEqual(code, 1)
            run_dirs = list(output_root.glob("*-missingbase"))
            self.assertEqual(len(run_dirs), 1)
            result = json.loads((run_dirs[0] / "results.json").read_text(encoding="utf-8"))
            self.assertEqual(result["baseline_comparison"]["error_code"],
                             eval_rag.ERR_BASELINE_INVALID)
            self.assertNotIn(FAKE_TOKEN, output)
            self.assertNotIn("Traceback", output)

    def test_cli_default_never_approves_then_explicit_approval_and_gate_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline_root = root / "baselines"
            common = [
                "--cases", str(CASES_PATH), "--k", "3",
                "--baseline-root", str(baseline_root),
            ]
            dependencies = (
                mock.patch.object(eval_rag, "PROJECT_ROOT", root),
                mock.patch.object(eval_rag, "get_kb", return_value=types.SimpleNamespace(
                    is_loaded=True, load_all=lambda: True)),
                mock.patch.object(eval_rag, "git_code_commit", return_value="b" * 40),
                mock.patch.object(eval_rag, "git_dirty", return_value=False),
            )
            with dependencies[0], dependencies[1], dependencies[2], dependencies[3], \
                 mock.patch.object(eval_rag, "get_rag", return_value=self._fake_rag()):
                code, _ = self._captured_cli(common + [
                    "--output-root", str(root / "default-results"),
                    "--run-id", "default-run", "--clock", "2026-08-20T14:00:00+00:00",
                ])
                self.assertEqual(code, 0)
                self.assertFalse(baseline_root.exists())

                code, output = self._captured_cli(common + [
                    "--output-root", str(root / "approved-results"),
                    "--run-id", "approved-run", "--clock", "2026-08-20T14:01:00+00:00",
                    "--approve-baseline", "--baseline-name", "approved-cli-v1",
                ])
                self.assertEqual(code, 0)
                self.assertIn("baseline_approved: approved-cli-v1", output)

            manifest_path = baseline_root / "approved-cli-v1.json"
            self.assertTrue(manifest_path.exists())

            with mock.patch.object(eval_rag, "PROJECT_ROOT", root), \
                 mock.patch.object(eval_rag, "get_kb", return_value=types.SimpleNamespace(
                     is_loaded=True, load_all=lambda: True)), \
                 mock.patch.object(eval_rag, "git_code_commit", return_value="c" * 40), \
                 mock.patch.object(eval_rag, "git_dirty", return_value=False), \
                 mock.patch.object(eval_rag, "get_rag", return_value=self._fake_rag("不相關")):
                code, output = self._captured_cli(common + [
                    "--output-root", str(root / "candidate-results"),
                    "--run-id", "candidate-run", "--clock", "2026-08-20T14:02:00+00:00",
                    "--baseline", str(manifest_path), "--threshold", "MRR=0",
                ])
            self.assertEqual(code, 1)
            self.assertIn("gate_passed=False", output)
            candidate = next((root / "candidate-results").glob("*-candidate-run"))
            result = json.loads((candidate / "results.json").read_text(encoding="utf-8"))
            self.assertFalse(result["baseline_comparison"]["gate"]["passed"])


if __name__ == "__main__":
    unittest.main()
