"""Synthetic-only checks for frozen comparison and aggregate persistence."""

from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import NAMESPACE_URL, uuid5

from evolve import comparison
from evolve.comparison import compare_variants, update_leaderboard


BASE = "a" * 40
CANDIDATE = "b" * 40
PROPOSAL = "c" * 64
TASKS = {"dev": ["dev-private-1", "dev-private-2", "dev-private-3"],
         "heldout": ["heldout-private-1", "heldout-private-2", "heldout-private-3"]}


def records(variant, dev=(False,), heldout=(True,)):
    result = []
    for split, outcomes in (("dev", dev), ("heldout", heldout)):
        for task in TASKS[split]:
            for attempt, passed in enumerate(outcomes, 1):
                identity = f"{variant}/{split}/{task}/{attempt}"
                result.append({"schema_version": 1, "task_id": task, "split": split,
                               "harness_commit": BASE if variant == "baseline" else CANDIDATE,
                               "run_id": variant + "-" + split, "attempt": attempt,
                               "configuration_id": variant + "-configuration", "passed": passed,
                               "trial_id": str(uuid5(NAMESPACE_URL, identity)),
                               "result_sha256": hashlib.sha256(identity.encode()).hexdigest(),
                               "task_checksum": hashlib.sha256(task.encode()).hexdigest(),
                               "models": [{"provider": "synthetic", "requested_model": "fixture", "model": "fixture"}],
                               "declared_agent": {"name": "pi", "model_name": "synthetic/fixture"},
                               "agent_info": {"name": "pi", "version": "pinned-fixture",
                                              "model_info": {"provider": "synthetic", "name": "fixture"}},
                               "protocol": {"attempts": len(outcomes), "thinking": "high", "environment": "synthetic"},
                               "synthetic": True, "tokens": {"input": 80, "cache_read": 10, "output": 10,
                                                             "cache_write": 0, "thinking_tokens": None, "total": 100},
                               "usage_complete": True, "wall_seconds": 2,
                               "cost": {"registry_usd": 0.01, "complete": True,
                                        "observed_pi_usd": 500, "billed_total_usd": None},
                               "trace_result_association": {"status": "caller_supplied", "task_name_match": True,
                                                            "trial_binding_verified": False},
                               "warnings": ["PRIVATE RECORD WARNING"]})
    return result


def decide(before=None, after=None, **kwargs):
    return compare_variants(records("baseline") if before is None else before,
                            records("candidate", dev=(True,)) if after is None else after,
                            expected_tasks=kwargs.pop("expected_tasks", TASKS), baseline_commit=BASE,
                            candidate_commit=CANDIDATE, seed=17, bootstrap_samples=1000, **kwargs)


def publish(directory, decision, variant="variant-1", **kwargs):
    return update_leaderboard(directory, variant, decision, harness_commit=CANDIDATE,
                              baseline_commit=BASE, proposal_sha256=PROPOSAL,
                              synthetic=kwargs.pop("synthetic", True), **kwargs)


class ComparisonTests(unittest.TestCase):
    def test_improvement_and_exact_heldout_tie_are_accepted(self):
        decision = decide()
        self.assertEqual(decision["status"], "accepted")
        self.assertEqual(decision["reasons"], [])
        self.assertEqual(decision["dev"]["delta"], 1)
        self.assertEqual(decision["dev"]["ci95"], [1, 1])
        self.assertEqual(decision["heldout"]["ci95"], [0, 0])
        self.assertEqual(decision["seed"], 17)
        self.assertEqual(decision["bootstrap_samples"], 1000)

    def test_known_requested_and_canonical_muse_identity_is_preserved(self):
        before, after = records("baseline"), records("candidate", dev=(True,))
        for record in before + after:
            record["models"] = [{"provider": "openrouter", "requested_model": "meta/muse-spark-1.3-contributor",
                                 "model": "meta/muse-spark-1.3-contributor-20260902"}]
            record["declared_agent"]["model_name"] = "openrouter/meta/muse-spark-1.3-contributor"
            record["agent_info"]["model_info"] = {"provider": "openrouter", "name": "meta/muse-spark-1.3-contributor"}
        self.assertEqual(decide(before, after)["status"], "accepted")
        after[0]["models"][0]["model"] = "unapproved-response-model"
        with self.assertRaisesRegex(ValueError, "models disagree"):
            decide(before, after)

    def test_inconclusive_dev_is_rejected(self):
        before = records("baseline", dev=(False, True), heldout=(True, True))
        after = records("candidate", dev=(False, True), heldout=(True, True))
        decision = decide(before, after)
        self.assertEqual(decision["status"], "rejected")
        self.assertEqual(decision["dev"]["delta"], 0)
        self.assertLess(decision["dev"]["ci95"][0], 0)
        self.assertGreater(decision["dev"]["ci95"][1], 0)
        self.assertEqual(decide(list(reversed(before)), list(reversed(after))), decision)

    def test_cluster_uncertainty_is_not_flat_attempt_uncertainty(self):
        before = records("baseline", dev=(False,) * 5, heldout=(True,) * 5)
        after = records("candidate", dev=(True,) * 5, heldout=(True,) * 5)
        for record in after:
            if record["split"] == "dev" and record["task_id"] != TASKS["dev"][0]:
                record["passed"] = False
        decision = decide(before, after)
        self.assertAlmostEqual(decision["dev"]["delta"], 1 / 3)
        self.assertEqual(decision["dev"]["ci95"][0], 0)
        self.assertEqual(decision["status"], "rejected")

    def test_heldout_regression_and_inconclusive_tie_are_rejected(self):
        regression = decide(after=records("candidate", dev=(True,), heldout=(False,)))
        self.assertEqual(regression["heldout"]["ci95"], [-1, -1])
        self.assertEqual(regression["status"], "rejected")
        before = records("baseline", dev=(False, False), heldout=(False, True))
        after = records("candidate", dev=(True, True), heldout=(False, True))
        inconclusive = decide(before, after)
        self.assertEqual(inconclusive["heldout"]["delta"], 0)
        self.assertLess(inconclusive["heldout"]["ci95"][0], 0)
        self.assertEqual(inconclusive["status"], "rejected")

    def test_missing_and_extra_frozen_membership_rejected(self):
        after = records("candidate", dev=(True,))
        for changed in (after[:-1], [dict(after[0], task_id="unknown-private-task"), *after[1:]]):
            with self.subTest(changed=changed[0]["task_id"]), self.assertRaises(ValueError):
                decide(after=changed)
        for tasks in ({"dev": TASKS["dev"][:2], "heldout": TASKS["heldout"]},
                      {"dev": TASKS["dev"] + TASKS["dev"][:1], "heldout": TASKS["heldout"]},
                      {"dev": TASKS["dev"], "heldout": TASKS["dev"]},
                      {**TASKS, "full": ["full-private-task"]}):
            with self.subTest(tasks=tasks), self.assertRaises(ValueError):
                decide(expected_tasks=tasks)

    def test_complete_equal_repetition_policy_without_best_of_selection(self):
        before = records("baseline", dev=(False, True), heldout=(True, True))
        after = records("candidate", dev=(True, True), heldout=(True, True))
        variants = []
        variants.append(after[:1] + after[2:])
        shifted = copy.deepcopy(after)
        shifted[0]["attempt"] = 3
        variants.append(shifted)
        duplicated = copy.deepcopy(after)
        duplicated[1]["attempt"] = 1
        duplicated[1]["run_id"] += "-second-job"
        variants.append(duplicated)
        for changed in variants:
            with self.subTest(attempts=[record["attempt"] for record in changed[:2]]), self.assertRaises(ValueError):
                decide(before, changed)
        with self.assertRaisesRegex(ValueError, "declared repetition"):
            decide([record for record in before if record["attempt"] == 1],
                   [record for record in after if record["attempt"] == 1])
        decision = decide(before, after)
        self.assertEqual(decision["dev"]["baseline"]["pass_rate"]["mean"], 0.5)
        self.assertEqual(decision["attempts_per_task"], 2)
        self.assertAlmostEqual(decision["dev"]["baseline"]["cost"]["per_successful_trial_usd"], 0.02)
        self.assertAlmostEqual(decision["dev"]["baseline"]["cost"]["total_usd"], 0.06)

    def test_duplicate_identities_within_and_across_variants_rejected(self):
        before, after = records("baseline"), records("candidate", dev=(True,))
        with self.assertRaises(ValueError):
            decide(before, [*after, after[0]])
        for field in ("run_id", "trial_id", "result_sha256"):
            changed = copy.deepcopy(after)
            changed[0][field] = before[0][field]
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "duplicate"):
                decide(before, changed)
        changed = copy.deepcopy(after)
        changed[1]["trial_id"] = changed[0]["trial_id"].upper()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            decide(before, changed)

    def test_missing_identity_model_configuration_commit_and_nonboolean_rejected(self):
        for field in ("schema_version", "run_id", "attempt", "models", "configuration_id", "harness_commit", "passed"):
            after = records("candidate", dev=(True,))
            after[0].pop(field)
            with self.subTest(field=field), self.assertRaises(ValueError):
                decide(after=after)
        for field, value in (("passed", 1), ("attempt", True), ("attempt", 0), ("split", []),
                             ("configuration_id", ""), ("harness_commit", BASE), ("task_checksum", {}),
                             ("trial_id", "not-a-uuid"), ("result_sha256", "not-a-hash")):
            after = records("candidate", dev=(True,))
            after[0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                decide(after=after)

    def test_mixed_configurations_models_declarations_and_protocols_rejected(self):
        mutations = [lambda record: record.update(configuration_id="other"),
                     lambda record: record["models"][0].update(model="other"),
                     lambda record: record["models"].append(dict(record["models"][0])),
                     lambda record: record["declared_agent"].update(model_name="synthetic/other"),
                     lambda record: record["agent_info"]["model_info"].update(provider="other"),
                     lambda record: record["protocol"].update(thinking="low"),
                     lambda record: record.update(thinking_level="low"),
                     lambda record: record.update(usage_complete="unknown")]
        for mutate in mutations:
            after = records("candidate", dev=(True,))
            mutate(after[0])
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                decide(after=after)
        after = records("candidate", dev=(True,))
        for record in after:
            record["models"][0].update(model="other", requested_model="other")
            record["declared_agent"]["model_name"] = "synthetic/other"
            record["agent_info"]["model_info"]["name"] = "other"
        with self.assertRaisesRegex(ValueError, "mixed model"):
            decide(after=after)

    def test_raw_input_rejected_without_echoing_sensitive_text(self):
        for payload in ({"messages": [{"content": "PRIVATE RAW CONTENT"}]},
                        {"unrecognized": {"arguments": {"command": "PRIVATE RAW CONTENT"}}},
                        {"verifier_result": {"rewards": {"reward": 1}}}):
            after = records("candidate", dev=(True,))
            after[0].update(payload)
            with self.subTest(payload=payload), self.assertRaises(ValueError) as raised:
                decide(after=after)
            self.assertNotIn("PRIVATE RAW CONTENT", str(raised.exception))
            self.assertNotIn(after[0]["task_id"], str(raised.exception))

    def test_result_and_leaderboard_never_export_heldout_identities_or_arbitrary_fields(self):
        after = records("candidate", dev=(True,))
        for record in after:
            record["private_metadata"] = {"path": "/PRIVATE/heldout/path", "notes": "PRIVATE SCALAR TEXT"}
        decision = decide(after=after)
        serialized = json.dumps(decision)
        for value in [*TASKS["heldout"], "PRIVATE RECORD WARNING", "/PRIVATE/heldout/path", "PRIVATE SCALAR TEXT",
                      after[-1]["trial_id"], after[-1]["task_checksum"], after[-1]["configuration_id"]]:
            self.assertNotIn(value, serialized)
        self.assertEqual(decision["heldout"]["candidate"]["trace_result_association"]["status_counts"]["caller_supplied"], 3)
        self.assertTrue(any("caller-supplied" in warning for warning in decision["heldout"]["candidate"]["warnings"]))
        decision["heldout"]["secret_task_ids"] = TASKS["heldout"]
        decision["heldout"]["candidate"]["warnings"] = ["PRIVATE RECORD WARNING"]
        with tempfile.TemporaryDirectory() as directory:
            publish(directory, decision)
            output = (Path(directory) / "leaderboard.json").read_text() + (Path(directory) / "leaderboard.md").read_text()
            for value in [*TASKS["heldout"], "PRIVATE RECORD WARNING"]:
                self.assertNotIn(value, output)

    def test_accounting_unknowns_remain_unknown_not_reported_pi_billing(self):
        after = records("candidate", dev=(True,))
        after[0]["cost"]["registry_usd"] = None
        after[0]["cost"]["complete"] = False
        after[0]["tokens"]["input"] = None
        after[0]["wall_seconds"] = None
        decision = decide(after=after)
        summary = decision["dev"]["candidate"]
        self.assertIsNone(summary["cost"]["total_usd"])
        self.assertIsNone(summary["cost"]["per_successful_trial_usd"])
        self.assertAlmostEqual(summary["cost"]["known_total_usd"], 0.02)
        self.assertIsNone(summary["cost"]["billed_total_usd"])
        self.assertIsNone(summary["tokens"]["input"]["total"])
        self.assertEqual(summary["tokens"]["input"]["known_total"], 160)
        self.assertIsNone(summary["wall_seconds"]["total"])
        with tempfile.TemporaryDirectory() as directory:
            entry = publish(directory, decision)
            self.assertIsNone(entry["dev"]["candidate"]["cost"]["total_usd"])
            self.assertIn("unknown", (Path(directory) / "leaderboard.md").read_text())


class LeaderboardTests(unittest.TestCase):
    def test_persistent_unique_rows_and_identical_retry(self):
        decision = decide()
        with tempfile.TemporaryDirectory() as directory:
            first = publish(directory, decision)
            self.assertEqual(publish(directory, copy.deepcopy(decision)), first)
            second = publish(directory, decision, variant="variant-2")
            ledger = json.loads((Path(directory) / "leaderboard.json").read_text())
            self.assertEqual(ledger["entries"], [first, second])
            markdown = (Path(directory) / "leaderboard.md").read_text()
            self.assertIn("SYNTHETIC", markdown)
            self.assertIn(BASE, markdown)
            self.assertIn(CANDIDATE, markdown)
            self.assertIn(PROPOSAL, markdown)
            self.assertFalse((Path(directory) / ".leaderboard.lock").exists())
            with self.assertRaisesRegex(ValueError, "synthetic"):
                publish(directory, decision, synthetic=False)

    def test_conflicting_retry_and_invalid_publication_rejected(self):
        decision = decide()
        with tempfile.TemporaryDirectory() as directory:
            publish(directory, decision)
            altered = copy.deepcopy(decision)
            altered["status"] = "rejected"
            with self.assertRaisesRegex(ValueError, "already"):
                publish(directory, altered)
            for variant in ("../escape", "unsafe|markdown", "", ".", "x" * 101):
                with self.subTest(variant=variant), self.assertRaises(ValueError):
                    publish(directory, decision, variant=variant)
            altered = copy.deepcopy(decision)
            altered["heldout"]["ci95"] = [-0.1, 0.1]
            with self.assertRaisesRegex(ValueError, "confidence"):
                publish(directory, altered, variant="bad-gate")
            altered = copy.deepcopy(decision)
            altered["candidate_commit"] = BASE
            with self.assertRaisesRegex(ValueError, "provenance"):
                publish(directory, altered, variant="bad-provenance")

    def test_corruption_fails_closed_and_preserves_original_bytes(self):
        decision = decide()
        with tempfile.TemporaryDirectory() as directory:
            publish(directory, decision)
            original = json.loads((Path(directory) / "leaderboard.json").read_text())
        duplicate = copy.deepcopy(original)
        duplicate["entries"].append(copy.deepcopy(duplicate["entries"][0]))
        leaked = copy.deepcopy(original)
        leaked["entries"][0]["heldout"]["task_ids"] = TASKS["heldout"]
        bad_gate = copy.deepcopy(original)
        bad_gate["entries"][0]["heldout"]["ci95"] = [-1, 0]
        corruptions = ["not json", '{"schema_version":1,"schema_version":1,"entries":[]}',
                       '{"schema_version":1,"entries":[NaN]}', json.dumps(duplicate), json.dumps(leaked),
                       json.dumps(bad_gate), '{"schema_version":9,"entries":[]}']
        for content in corruptions:
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "leaderboard.json"
                path.write_text(content)
                with self.assertRaisesRegex(ValueError, "corrupt"):
                    publish(directory, decision, variant="new-row")
                self.assertEqual(path.read_text(), content)
                self.assertFalse((Path(directory) / ".leaderboard.lock").exists())
                self.assertFalse((Path(directory) / "leaderboard.md").exists())

    def test_existing_lock_and_concurrent_writer_fail_closed(self):
        decision = decide()
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / ".leaderboard.lock"
            lock.write_text("another owner")
            with self.assertRaisesRegex(ValueError, "locked"):
                publish(directory, decision)
            self.assertEqual(lock.read_text(), "another owner")
            lock.unlink()
            entered, release = threading.Event(), threading.Event()
            original_load = comparison._load
            def blocked_load(path):
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("test writer release timed out")
                return original_load(path)
            with patch.object(comparison, "_load", side_effect=blocked_load), ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(publish, directory, decision)
                try:
                    self.assertTrue(entered.wait(5))
                    with self.assertRaisesRegex(ValueError, "locked"):
                        publish(directory, decision, variant="variant-2")
                finally:
                    release.set()
                self.assertEqual(future.result()["variant_id"], "variant-1")
            publish(directory, decision, variant="variant-2")
            self.assertEqual(len(json.loads((Path(directory) / "leaderboard.json").read_text())["entries"]), 2)

    def test_atomic_failure_retains_json_and_retry_repairs_markdown(self):
        decision = decide()
        with tempfile.TemporaryDirectory() as directory:
            original_replace = comparison.os.replace
            def fail_markdown(source, destination):
                if Path(destination).name == "leaderboard.md":
                    raise OSError("synthetic interrupted Markdown replacement")
                return original_replace(source, destination)
            with patch.object(comparison.os, "replace", side_effect=fail_markdown), self.assertRaises(OSError):
                publish(directory, decision)
            ledger = json.loads((Path(directory) / "leaderboard.json").read_text())
            self.assertEqual(len(ledger["entries"]), 1)
            self.assertFalse((Path(directory) / ".leaderboard.lock").exists())
            self.assertEqual(list(Path(directory).glob(".leaderboard-*")), [])
            retry = publish(directory, decision)
            self.assertEqual(retry, ledger["entries"][0])
            self.assertIn("variant-1", (Path(directory) / "leaderboard.md").read_text())

    def test_unsafe_file_types_and_symlink_targets_rejected(self):
        decision = decide()
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "leaderboard.json").mkdir()
            with self.assertRaises(ValueError):
                publish(directory, decision)
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory) / "outside"
            outside.mkdir()
            link = Path(directory) / "linked"
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("host does not permit symlink creation")
            with self.assertRaisesRegex(ValueError, "symlink|reparse"):
                publish(link, decision)
            self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
