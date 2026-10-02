"""Synthetic accounting checks; these are not benchmark scores."""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from evals.analysis.metrics import analyze_pi_trace, summarize_runs
from evals.analysis.report import render_markdown


def usage(input=100, output=20, cache_read=50, cache_write=10, reasoning=None, cost=9):
    value = {
        "input": input, "output": output, "cacheRead": cache_read,
        "cacheWrite": cache_write, "totalTokens": input + output + cache_read + cache_write,
        "cost": {"input": cost, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": cost},
    }
    if reasoning is not None:
        value["reasoning"] = reasoning
    return value


def assistant(timestamp=1000, response_id=None, **kwargs):
    value = {
        "role": "assistant", "api": "openai-responses", "provider": "example", "model": "model",
        "content": [{"type": "text", "text": "synthetic"}], "stopReason": "stop",
        "timestamp": timestamp, "usage": usage(**kwargs),
    }
    if response_id is not None:
        value["responseId"] = response_id
    return value


def prices(**changes):
    rates = {"input": 2, "cache_read": 0.5, "cache_write": 3, "output": 8}
    rates.update(changes)
    return {
        "schema_version": 1, "currency": "USD", "unit": "per_million_tokens",
        "models": [{"provider": "example", "model": "model", **rates,
                    "source_url": "https://example.invalid/official-prices", "retrieved_at": "2026-10-01T00:00:00Z"}],
    }


class TraceMetricsTests(unittest.TestCase):
    def analyze(self, records, registry=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.jsonl"
            path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
            return analyze_pi_trace(path, prices=registry)

    def test_components_cost_and_reported_reasoning_are_hand_calculated(self):
        result = self.analyze([{"type": "message_end", "message": assistant(reasoning=7)}], prices())
        self.assertEqual(result["tokens"], {"input": 100, "cache_read": 50, "cache_write": 10,
                                         "output": 20, "thinking_tokens": 7, "total": 180})
        self.assertAlmostEqual(result["cost"]["registry_usd"], 0.000415)
        self.assertEqual(result["cost"]["observed_pi_usd"], 9)
        self.assertEqual(result["counts"]["assistant_calls"], 1)
        self.assertEqual(result["peak_context_tokens"], 180)
        self.assertEqual(result["availability"]["peak_context_tokens"]["status"], "estimate")

    def test_streamed_usage_and_terminal_snapshots_are_not_billed_twice(self):
        message = assistant()
        result = self.analyze([
            {"type": "message_start", "message": assistant(input=0, output=0, cache_read=0, cache_write=0)},
            {"type": "message_update", "usage": usage(output=5), "assistantMessageEvent": {"type": "text_delta", "delta": "synthetic"}},
            {"type": "message_end", "message": message},
            {"type": "turn_end", "message": message, "toolResults": []},
            {"type": "agent_end", "messages": [message], "willRetry": False},
        ])
        self.assertEqual(result["tokens"]["input"], 100)
        self.assertIsNone(result["tokens"]["thinking_tokens"])
        self.assertEqual(result["counts"]["assistant_calls"], 1)

    def test_equal_timestamps_and_even_equal_messages_are_distinct_without_ids(self):
        message = assistant()
        result = self.analyze([{"type": "message_end", "message": message},
                               {"type": "message_end", "message": copy.deepcopy(message)}])
        self.assertEqual(result["tokens"]["input"], 200)
        self.assertEqual(result["counts"]["assistant_calls"], 2)

    def test_cross_representation_overlap_uses_occurrences_not_timestamp(self):
        message = assistant()
        result = self.analyze([
            {"type": "message_end", "message": message},
            {"type": "message_end", "message": message},
            {"type": "message", "id": "a", "message": message},
            {"type": "message", "id": "b", "message": message},
        ])
        self.assertEqual(result["tokens"]["input"], 200)

    def test_repeated_response_and_session_entry_identifiers_deduplicate(self):
        message = assistant(response_id="response-1")
        result = self.analyze([
            {"type": "message_end", "message": message},
            {"type": "message_end", "message": message},
            {"type": "message", "id": "a", "message": message},
            {"type": "entry_appended", "entry": {"type": "message", "id": "a", "message": message}},
        ])
        self.assertEqual(result["tokens"]["total"], 180)

    def test_same_entry_id_with_conflicting_payload_is_invalid(self):
        records = [{"type": "message", "id": "a", "message": assistant()},
                   {"type": "message", "id": "a", "message": assistant(input=500)}]
        with self.assertRaisesRegex(ValueError, "conflict"):
            self.analyze(records)

    def test_apex_helper_usage_is_counted_once_without_snapshot_double_billing(self):
        entry={'type':'custom','id':'helper-entry','customType':'apex-helper-usage','data':{
            'version':1,'requestId':'contract-call','taskId':'task','kind':'contract','provider':'example','model':'model',
            'usage':usage(input=7,output=2,cache_read=3,cache_write=1,cost=0.01),'status':'complete','complete':True}}
        result=self.analyze([{'type':'message_end','message':assistant()},entry,{'type':'entry_appended','entry':entry},
            {'type':'custom','id':'snapshot','customType':'apex-task-state','data':{'extraction':{'usage':entry['data']['usage']}}}],prices())
        self.assertEqual(result['tokens']['total'],193)
        self.assertEqual(result['counts']['auxiliary_usage_records'],1)
        self.assertEqual(result['usage_categories']['usage:apex-contract']['records'],1)
        self.assertAlmostEqual(result['cost']['observed_pi_usd'],9.01)

    def test_apex_partial_or_missing_helper_usage_invalidates_full_cost(self):
        data={'version':1,'requestId':'contract-call','taskId':'task','kind':'contract','provider':'example','model':'model',
              'usage':usage(input=7),'status':'aborted','complete':False}
        entry={'type':'custom','id':'helper','customType':'apex-helper-usage','data':data}
        result=self.analyze([{'type':'message_end','message':assistant()},entry],prices())
        self.assertFalse(result['usage_complete']);self.assertIsNone(result['cost']['registry_usd'])
        del data['usage']
        result=self.analyze([{'type':'message_end','message':assistant()},entry],prices())
        self.assertFalse(result['usage_complete'])
        self.assertEqual(result['counts']['auxiliary_usage_records'],0)

    def test_attributed_apex_tool_usage_is_priced_and_unknown_attempt_is_incomplete(self):
        message={'role':'toolResult','toolCallId':'helper','toolName':'explore','content':[{'type':'text','text':'fixture'}],
                 'isError':False,'usage':usage(input=7,output=2,cache_read=3,cache_write=1,cost=0.01),
                 'details':{'apexAux':{'version':1,'kind':'explore','provider':'example','model':'model','attempted':True,'complete':True}}}
        result=self.analyze([{'type':'message_end','message':message}],prices())
        self.assertAlmostEqual(result['cost']['registry_usd'],0.0000345)
        self.assertTrue(result['usage_complete'])
        message['details']['apexAux']['complete']=False
        del message['usage']
        result=self.analyze([{'type':'message_end','message':assistant()},{'type':'message_end','message':message}],prices())
        self.assertFalse(result['usage_complete'])
        self.assertIsNone(result['cost']['registry_usd'])
        message['details']['apexAux']['attempted']=False
        result=self.analyze([{'type':'message_end','message':assistant()},{'type':'message_end','message':message}],prices())
        self.assertTrue(result['usage_complete'])

    def test_missing_rates_stay_unknown_even_when_pi_reports_cost(self):
        result = self.analyze([{"type": "message_end", "message": assistant()}], prices(output=None))
        self.assertIsNone(result["cost"]["registry_usd"])
        self.assertEqual(result["cost"]["observed_pi_usd"], 9)
        self.assertIn("output", result["cost"]["missing_rates"][0]["components"])

    def test_zero_component_does_not_require_price(self):
        result = self.analyze([{"type": "message_end", "message": assistant(cache_read=0, cache_write=0)}],
                              prices(cache_read=None, cache_write=None))
        self.assertAlmostEqual(result["cost"]["registry_usd"], 0.00036)
        zero = self.analyze([{"type": "message_end", "message": assistant(input=0, output=0, cache_read=0, cache_write=0)}])
        self.assertEqual(zero["cost"]["observed_registry_usd"], 0)
        self.assertIsNone(zero["cost"]["registry_usd"])
        self.assertFalse(zero["usage_complete"])

    def test_auxiliary_usage_is_counted_but_unattributed_model_is_not_invented(self):
        result = self.analyze([
            {"type": "model_change", "provider": "example", "modelId": "model"},
            {"type": "message", "id": "a", "message": assistant()},
            {"type": "compaction", "id": "c", "tokensBefore": 400, "summary": "s", "usage": usage(input=30, output=5, cache_read=0, cache_write=0)},
            {"type": "branch_summary", "id": "b", "summary": "b", "usage": usage(input=10, output=3, cache_read=0, cache_write=0)},
            {"type": "usage", "id": "u", "kind": "cache_warm", "provider": "example", "model": "model", "usage": usage(input=8, output=1, cache_read=0, cache_write=0)},
            {"type": "message", "id": "t", "message": {"role": "toolResult", "toolCallId": "tool1", "toolName": "bash", "content": [], "isError": True, "timestamp": 2000, "usage": usage(input=2, output=1, cache_read=0, cache_write=0)}},
        ], prices())
        self.assertEqual(result["tokens"]["input"], 150)
        self.assertEqual(result["tokens"]["output"], 30)
        self.assertIsNone(result["cost"]["registry_usd"])
        self.assertEqual(result["cost"]["observed_pi_usd"], 45)
        self.assertEqual(result["counts"]["auxiliary_usage_records"], 4)
        self.assertEqual(result["counts"]["compactions"], 1)
        self.assertEqual(result["counts"]["tool_errors"], 1)

    def test_compaction_event_and_saved_entry_overlap(self):
        compaction = {"summary": "s", "firstKeptEntryId": "a", "tokensBefore": 200, "usage": usage()}
        result = self.analyze([
            {"type": "compaction_end", "result": compaction, "aborted": False},
            {"type": "compaction", "id": "c", **compaction},
        ])
        self.assertEqual(result["tokens"]["total"], 180)
        self.assertEqual(result["counts"]["compactions"], 1)

    def test_missing_compaction_usage_invalidates_full_run_cost(self):
        result = self.analyze([{"type": "message", "id": "a", "message": assistant()},
                               {"type": "compaction", "id": "c", "tokensBefore": 300}], prices())
        self.assertFalse(result["usage_complete"])
        self.assertIsNone(result["cost"]["registry_usd"])
        self.assertAlmostEqual(result["cost"]["observed_registry_usd"], 0.000415)

    def test_tool_events_and_results_reconcile_by_call_id(self):
        tool = {"role": "toolResult", "toolCallId": "t", "toolName": "bash", "isError": True, "content": [], "timestamp": 2000}
        result = self.analyze([
            {"type": "tool_execution_start", "toolCallId": "t", "toolName": "bash", "args": {}},
            {"type": "tool_execution_end", "toolCallId": "t", "toolName": "bash", "isError": True, "result": {}},
            {"type": "message_end", "message": tool},
            {"type": "message", "id": "trow", "message": tool},
        ])
        self.assertEqual(result["counts"]["tool_calls"], 1)
        self.assertEqual(result["counts"]["tool_errors"], 1)

    def test_session_timestamp_span_is_labeled_estimate(self):
        result = self.analyze([
            {"type": "session", "id": "s", "version": 3, "timestamp": "2026-10-01T00:00:00Z"},
            {"type": "message", "id": "a", "timestamp": "2026-10-01T00:00:05Z", "message": assistant(timestamp=1790812804000)},
        ])
        self.assertEqual(result["wall_seconds"], 5)
        self.assertEqual(result["availability"]["wall_seconds"]["status"], "estimate")

    def test_missing_usage_never_becomes_zero(self):
        message = assistant()
        del message["usage"]
        with self.assertRaisesRegex(ValueError, "usage"):
            self.analyze([{"type": "message_end", "message": message}])

    def test_incomplete_and_nonfinite_usage_errors(self):
        for field, value in [("input", None), ("output", -1), ("cacheRead", True), ("cacheWrite", 1.5), ("totalTokens", float("nan")), ("reasoning", 21)]:
            with self.subTest(field=field):
                message = assistant()
                message["usage"][field] = value
                with self.assertRaises(ValueError):
                    self.analyze([{"type": "message_end", "message": message}])
        message = assistant()
        del message["usage"]["cacheRead"]
        with self.assertRaises(ValueError):
            self.analyze([{"type": "message_end", "message": message}])

    def test_malformed_truncated_and_empty_logs_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.jsonl"
            for data in ['{"type":"message_end"', '{bad}\n', "", "[]\n", '{"type":"message_end"}\n']:
                with self.subTest(data=data):
                    path.write_text(data, encoding="utf-8")
                    with self.assertRaises(ValueError):
                        analyze_pi_trace(path)

    def test_literal_unicode_separators_inside_json_strings_preserve_lf_records(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.jsonl"
            for separator in ("\u2028", "\u2029", "\u0085"):
                for ending in ("\n", "\r\n"):
                    with self.subTest(separator=hex(ord(separator)), ending=repr(ending)):
                        message = assistant()
                        message["content"][0]["text"] = "before" + separator + "after"
                        records = [{"type": "message_end", "message": message},
                                   {"type": "message_end", "message": assistant(timestamp=2000)}]
                        raw = (ending.join(json.dumps(row, ensure_ascii=False) for row in records) + ending).encode("utf-8")
                        path.write_bytes(raw)
                        result = analyze_pi_trace(path, prices=prices())
                        self.assertEqual(result["counts"]["assistant_calls"], 2)
                        self.assertEqual(result["tokens"]["total"], 360)
                        self.assertEqual(path.read_bytes(), raw)

    def test_open_assistant_stream_is_incomplete_instead_of_free(self):
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.analyze([{"type": "message_start", "message": assistant()}])

    def test_invalid_and_duplicate_registry_entries_error(self):
        for field, value in [("input", -1), ("output", True), ("cache_read", float("inf"))]:
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    self.analyze([{"type": "message_end", "message": assistant()}], prices(**{field: value}))
        registry = prices()
        registry["models"].append(copy.deepcopy(registry["models"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.analyze([{"type": "message_end", "message": assistant()}], registry)

    def test_summary_retry_events_invalidate_complete_spend(self):
        result = self.analyze([{"type": "message_end", "message": assistant()},
                               {"type": "summarization_retry_scheduled", "attempt": 1}], prices())
        self.assertFalse(result["usage_complete"])
        self.assertIsNone(result["cost"]["registry_usd"])
        self.assertTrue(any("discarded" in warning for warning in result["warnings"]))

    def test_usage_entry_kind_does_not_impersonate_main_assistant(self):
        result = self.analyze([{"type": "usage", "id": "u", "kind": "assistant", "provider": "example",
                               "model": "model", "usage": usage()}], prices())
        self.assertEqual(result["counts"]["assistant_calls"], 0)
        self.assertIsNone(result["peak_context_tokens"])
        self.assertIn("usage:assistant", result["usage_categories"])

    def test_response_model_controls_pricing_and_preserves_requested_model(self):
        message = assistant()
        message["responseModel"] = "actual"
        registry = prices()
        actual = copy.deepcopy(registry["models"][0])
        actual.update({"model": "actual", "input": 4})
        registry["models"].append(actual)
        result = self.analyze([{"type": "message_end", "message": message}], registry)
        self.assertAlmostEqual(result["cost"]["registry_usd"], 0.000615)
        self.assertEqual(result["models"][0]["requested_model"], "model")
        self.assertEqual(result["models"][0]["model"], "actual")
        unknown = self.analyze([{"type": "message_end", "message": message}], prices())
        self.assertIsNone(unknown["cost"]["registry_usd"])

    def test_one_hour_cache_write_requires_explicit_rate(self):
        message = assistant()
        message["usage"]["cacheWrite1h"] = 6
        result = self.analyze([{"type": "message_end", "message": message}], prices())
        self.assertIsNone(result["cost"]["registry_usd"])
        self.assertIn("cache_write_1h", result["cost"]["missing_rates"][0]["components"])
        self.assertAlmostEqual(result["cost"]["known_registry_subtotal_usd"], 0.000397)
        result = self.analyze([{"type": "message_end", "message": message}], prices(cache_write_1h=4))
        self.assertAlmostEqual(result["cost"]["registry_usd"], 0.000421)
        self.assertEqual(result["tokens"]["total"], 180)

    def test_arbitrary_tool_usage_kinds_preserve_distinct_entries(self):
        result = self.analyze([{"type": "usage", "id": entry_id, "kind": "tool", "provider": "example", "model": "model", "usage": usage()}
                               for entry_id in ("one", "two")], prices())
        self.assertEqual(result["tokens"]["total"], 360)

    def test_invalid_final_metadata_errors_consistently(self):
        for field, value in [("stopReason", None), ("stopReason", "invalid"), ("content", None),
                             ("content", {}), ("responseId", []), ("responseModel", {})]:
            with self.subTest(field=field, value=value):
                message = assistant()
                message[field] = value
                with self.assertRaises(ValueError):
                    self.analyze([{"type": "message_end", "message": message}])
        with self.assertRaises(ValueError):
            self.analyze([{"type": "message", "id": [], "message": assistant()}])
        with self.assertRaises(ValueError):
            self.analyze([{"type": "session", "id": []}, {"type": "message_end", "message": assistant()}])

    def test_unrepresentable_usage_and_boolean_registry_version_error(self):
        message = assistant()
        message["usage"]["input"] = 10 ** 400
        with self.assertRaises(ValueError):
            self.analyze([{"type": "message_end", "message": message}])
        registry = prices()
        registry["schema_version"] = True
        with self.assertRaises(ValueError):
            self.analyze([{"type": "message_end", "message": assistant()}], registry)

    def test_prompt_rate_scope_includes_cache_components_and_is_inclusive(self):
        registry = prices()
        registry["models"][0]["pricing_scope"] = {"max_prompt_tokens": 160}
        at_boundary = self.analyze([{"type": "message_end", "message": assistant(output=200)}], registry)
        self.assertIsNotNone(at_boundary["cost"]["registry_usd"])
        above_boundary = self.analyze([{"type": "message_end", "message": assistant(cache_write=11)}], registry)
        self.assertIsNone(above_boundary["cost"]["registry_usd"])
        self.assertEqual(above_boundary["cost"]["known_registry_subtotal_usd"], 0)
        issue = above_boundary["cost"]["pricing_scope_issues"][0]
        self.assertEqual(issue["reason"], "prompt_out_of_scope")
        self.assertEqual(issue["prompt_tokens"], 161)
        self.assertEqual(issue["max_prompt_tokens"], 160)
        self.assertTrue(above_boundary["usage_complete"])

    def test_hourly_storage_is_unknown_without_corrupting_token_usage(self):
        registry = prices()
        registry["models"][0]["pricing_scope"] = {
            "cache_storage_usd_per_million_tokens_hour": 1, "cache_storage_kind": "explicit_only"}
        result = self.analyze([{"type": "message_end", "message": assistant(cache_write=0)}], registry)
        self.assertAlmostEqual(result["cost"]["registry_usd"], 0.000385)
        self.assertTrue(result["usage_complete"])
        self.assertTrue(result["cost"]["complete"])
        self.assertEqual(result["cost"]["billing_scope"], "token_usage_only")
        self.assertIsNone(result["cost"]["billed_total_usd"])
        self.assertFalse(result["cost"]["full_billing_complete"])
        self.assertTrue(any("implicit" in warning and "storage" in warning for warning in result["warnings"]))

    def test_model_access_restriction_does_not_invent_account_eligibility(self):
        registry = prices()
        registry["models"][0]["pricing_scope"] = {"availability": "previous_active_users_only"}
        result = self.analyze([{"type": "message_end", "message": assistant()}], registry)
        self.assertIsNotNone(result["cost"]["registry_usd"])
        self.assertEqual(result["cost"]["pricing_scope_issues"][0]["availability"], "previous_active_users_only")
        self.assertTrue(any("eligibility" in warning for warning in result["warnings"]))

    def test_invalid_machine_price_scopes_error(self):
        scopes = [[], {"max_prompt_tokens": True}, {"max_prompt_tokens": -1},
                  {"cache_storage_usd_per_million_tokens_hour": -1}, {"availability": []}]
        for scope in scopes:
            with self.subTest(scope=scope):
                registry = prices()
                registry["models"][0]["pricing_scope"] = scope
                with self.assertRaises(ValueError):
                    self.analyze([{"type": "message_end", "message": assistant()}], registry)

    def test_prompt_rate_scope_applies_per_request_instead_of_run_sum(self):
        registry = prices()
        registry["models"][0]["pricing_scope"] = {"max_prompt_tokens": 160}
        result = self.analyze([{"type": "message_end", "message": assistant(timestamp=timestamp)}
                               for timestamp in (1000, 2000)], registry)
        self.assertAlmostEqual(result["cost"]["registry_usd"], 0.00083)
        self.assertEqual(result["tokens"]["input"], 200)


class SummaryTests(unittest.TestCase):
    def record(self, task, passed, cost=1, tokens=100, wall=10):
        return {"task_id": task, "passed": passed, "tokens": {"total": tokens},
                "cost": {"registry_usd": cost}, "wall_seconds": wall}

    def test_mean_pass_rate_weights_tasks_equally_with_repeated_attempts(self):
        records = [self.record("a", True)] + [self.record("b", False) for _ in range(9)]
        result = summarize_runs(records, seed=42, bootstrap_samples=1000)
        self.assertEqual(result["tasks"], 2)
        self.assertEqual(result["attempts"], 10)
        self.assertEqual(result["pass_rate"]["mean"], 0.5)
        self.assertEqual(result["pass_rate"]["ci95"], [0.0, 1.0])
        self.assertEqual(result["pass_rate"]["method"], "task_cluster_percentile_bootstrap")
        self.assertTrue(result["warnings"])

    def test_reproducible_cluster_interval_and_cost_per_solved_task(self):
        records = [self.record("a", True, 2), self.record("a", False, 3),
                   self.record("b", False, 4), self.record("c", True, 1)]
        result = summarize_runs(records, seed=7, bootstrap_samples=1000)
        self.assertEqual(result, summarize_runs(records, seed=7, bootstrap_samples=1000))
        self.assertEqual(result["pass_rate"]["mean"], 0.5)
        self.assertEqual(result["solved_tasks"], 2)
        self.assertEqual(result["cost"]["total_usd"], 10)
        self.assertEqual(result["cost"]["per_solved_task_usd"], 5)
        self.assertEqual(result["tokens"]["total"]["total"], 400)
        self.assertEqual(result["wall_seconds"]["mean"], 10)

    def test_no_solved_or_unknown_cost_returns_null(self):
        result = summarize_runs([self.record("a", False, 2)])
        self.assertIsNone(result["cost"]["per_solved_task_usd"])
        result = summarize_runs([self.record("a", True, None), self.record("b", False, 2)])
        self.assertIsNone(result["cost"]["total_usd"])
        self.assertIsNone(result["cost"]["per_solved_task_usd"])
        self.assertEqual(result["cost"]["known_total_usd"], 2)

    def test_unknown_tokens_and_time_preserved_with_known_observations(self):
        result = summarize_runs([self.record("a", True, tokens=None, wall=None), self.record("b", True)])
        self.assertIsNone(result["tokens"]["total"]["total"])
        self.assertEqual(result["tokens"]["total"]["known_total"], 100)
        self.assertIsNone(result["wall_seconds"]["mean"])
        self.assertEqual(result["wall_seconds"]["known_mean"], 10)

    def test_missing_task_outcome_or_invalid_values_error(self):
        records = [[], [{"passed": True}], [{"task_id": "a", "passed": 1}],
                   [self.record("a", True, cost=-1)], [self.record("a", True, wall=float("nan"))]]
        for value in records:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    summarize_runs(value)
        with self.assertRaises(ValueError):
            summarize_runs([self.record("a", True)], bootstrap_samples=0)

    def test_incomplete_observed_usage_cannot_be_reported_as_complete_token_total(self):
        incomplete = self.record("a", True, tokens=20)
        incomplete["usage_complete"] = False
        result = summarize_runs([incomplete, self.record("b", True, tokens=100)])
        self.assertIsNone(result["tokens"]["total"]["total"])
        self.assertEqual(result["tokens"]["total"]["known_total"], 120)
        self.assertEqual(result["tokens"]["total"]["incomplete_count"], 1)

    def test_mixed_configurations_are_rejected_and_single_task_interval_is_unknown(self):
        first = self.record("a", True)
        second = self.record("a", False)
        first["configuration_id"] = "stock"
        second["configuration_id"] = "apex"
        with self.assertRaisesRegex(ValueError, "configuration"):
            summarize_runs([first, second])
        self.assertIsNone(summarize_runs([first])["pass_rate"]["ci95"])

    def test_primary_cost_per_solved_trial_does_not_select_best_attempt(self):
        records = [self.record(f"task-{index // 5}", index % 2 == 0, cost=1) for index in range(20)]
        result = summarize_runs(records)
        self.assertEqual(result["successful_trials"], 10)
        self.assertEqual(result["cost"]["per_solved_task_usd"], 2)
        self.assertEqual(result["cost"]["per_successful_trial_usd"], 2)
        self.assertEqual(result["cost"]["any_attempt_per_solved_task_usd"], 5)

    def test_unknown_or_invalid_configuration_cannot_mix_with_configured_trials(self):
        configured = self.record("a", True)
        configured["configuration_id"] = "stock"
        with self.assertRaises(ValueError):
            summarize_runs([configured, self.record("b", True)])
        for value in (None, [], ""):
            with self.subTest(value=value):
                invalid = self.record("a", True)
                invalid["configuration_id"] = value
                with self.assertRaises(ValueError):
                    summarize_runs([invalid])

    def test_summary_dollars_are_explicitly_token_cost_not_full_invoice(self):
        result = summarize_runs([self.record("a", True)])
        self.assertEqual(result["cost"]["billing_scope"], "token_usage_only")
        self.assertIsNone(result["cost"]["billed_total_usd"])
        self.assertFalse(result["cost"]["full_billing_complete"])

    def test_duplicate_run_task_attempt_is_rejected_instead_of_counted_twice(self):
        record = self.record("a", True)
        record.update(run_id="run-a", attempt=1)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            summarize_runs([record, copy.deepcopy(record)])

    def test_distinct_attempts_and_runs_with_full_identities_are_allowed(self):
        records = []
        for run_id, attempt in (("run-a", 1), ("run-a", 2), ("run-b", 1)):
            record = self.record("a", True)
            record.update(run_id=run_id, attempt=attempt)
            records.append(record)
        self.assertEqual(summarize_runs(records)["attempts"], 3)

    def test_reused_trial_uuid_or_result_hash_is_rejected_across_different_attempts(self):
        for identity, value in (("trial_id", "8cb803e1-9f30-4f12-b173-476013f3f9bd"),
                                ("result_sha256", "d" * 64)):
            with self.subTest(identity=identity):
                first = self.record("a", True)
                first.update(run_id="run-a", attempt=1)
                first[identity] = value
                second = copy.deepcopy(first)
                second["attempt"] = 2
                with self.assertRaisesRegex(ValueError, "duplicate"):
                    summarize_runs([first, second])

    def test_distinct_harbor_trials_and_result_hashes_allow_repeated_measurements(self):
        first = self.record("a", True)
        first.update(trial_id="8cb803e1-9f30-4f12-b173-476013f3f9bd", result_sha256="a" * 64)
        second = self.record("a", False)
        second.update(trial_id="7cb803e1-9f30-4f12-b173-476013f3f9bd", result_sha256="b" * 64)
        result = summarize_runs([first, second])
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["pass_rate"]["mean"], 0.5)

    def test_identityless_fixtures_remain_usable_with_unknown_provenance_warning(self):
        record = self.record("a", True)
        result = summarize_runs([record, copy.deepcopy(record)])
        self.assertEqual(result["attempts"], 2)
        self.assertTrue(any("provenance" in warning and "identity" in warning for warning in result["warnings"]))

    def test_duplicate_markers_are_canonical_and_checked_independently(self):
        first = self.record("a", True)
        first.update(run_id="run-a", attempt=1, trial_id="8cb803e1-9f30-4f12-b173-476013f3f9bd", result_sha256="a" * 64)
        second = copy.deepcopy(first)
        second.update(run_id="run-b", attempt=2, result_sha256="b" * 64,
                      trial_id="8CB803E1-9F30-4F12-B173-476013F3F9BD")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            summarize_runs([first, second])
        second.update(trial_id="7cb803e1-9f30-4f12-b173-476013f3f9bd", result_sha256="A" * 64)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            summarize_runs([first, second])

    def test_present_malformed_record_identities_fail_closed(self):
        for field, value in (("run_id", []), ("attempt", True), ("attempt", 0),
                             ("trial_id", "invalid"), ("result_sha256", "not-a-hash")):
            with self.subTest(field=field):
                record = self.record("a", True)
                record[field] = value
                with self.assertRaises(ValueError):
                    summarize_runs([record])

    def test_summary_and_markdown_preserve_caller_supplied_association_limit(self):
        records = []
        for task in ("a", "b", "c"):
            record = self.record(task, True)
            record.update(run_id="run-a", attempt=1,
                          trace_result_association={"status": "caller_supplied", "trial_binding_verified": False,
                                                    "detail": "private trajectory text"},
                          warnings=["private trajectory text"])
            records.append(record)
        summary = summarize_runs(records)
        markdown = render_markdown(summary)
        self.assertIn("caller-supplied", markdown)
        self.assertIn("trial binding", markdown)
        self.assertEqual(summary["trace_result_association"]["status_counts"],
                         {"caller_supplied": 3, "unverified": 0, "verified": 0, "unknown": 0, "missing": 0})
        self.assertNotIn("private trajectory text", json.dumps(summary))
        self.assertNotIn("private trajectory text", markdown)

    def test_association_status_counts_are_allowlisted_and_unknown_provenance_is_visible(self):
        associations = [None, {"status": "private arbitrary status", "trial_binding_verified": True},
                        {"status": "verified", "trial_binding_verified": False},
                        {"status": "verified", "trial_binding_verified": True},
                        {"status": "unverified", "trial_binding_verified": True}]
        records = []
        for index, association in enumerate(associations):
            record = self.record(f"task-{index}", True)
            record.update(run_id="run-a", attempt=1)
            if association is not None:
                record["trace_result_association"] = association
            records.append(record)
        summary = summarize_runs(records)
        markdown = render_markdown(summary)
        self.assertIn("missing or unknown", markdown)
        self.assertIn("unverified", markdown)
        self.assertEqual(summary["trace_result_association"]["status_counts"],
                         {"caller_supplied": 0, "unverified": 2, "verified": 1, "unknown": 1, "missing": 1})
        self.assertNotIn("private arbitrary status", json.dumps(summary))
        self.assertNotIn("private arbitrary status", markdown)

    def test_report_cli_rejects_raw_trace_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "raw.json"
            source.write_text(json.dumps([{"type": "message_end", "message": assistant()}]), encoding="utf-8")
            result = subprocess.run([sys.executable, "-m", "evals.analysis.report", str(source)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("raw trajectories", result.stderr)

    def test_report_cli_accepts_normalized_records_and_writes_both_formats(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "metrics.json"
            output = Path(directory) / "report.json"
            markdown = Path(directory) / "report.md"
            source.write_text(json.dumps([self.record("a", True)]), encoding="utf-8")
            result = subprocess.run([sys.executable, "-m", "evals.analysis.report", str(source),
                                     "--output", str(output), "--markdown", str(markdown)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(output.read_text())["pass_rate"]["mean"], 1)
            self.assertIn("Synthetic", markdown.read_text())
            self.assertIn("task clusters", markdown.read_text())


if __name__ == "__main__":
    unittest.main()
