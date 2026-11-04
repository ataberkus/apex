import json
from pathlib import Path
import tempfile
import unittest

from evals.analysis.normalize import normalize_attempt
from evals.analysis.metrics import summarize_runs
from evals.analysis.trace_store import ingest_trace


class NormalizeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        source = root / 'session.jsonl'
        source.write_text(json.dumps({'type': 'message', 'id': 'a', 'message': {
            'role': 'assistant', 'provider': 'example', 'model': 'model', 'stopReason': 'stop',
            'content': [{'type': 'text', 'text': 'raw heldout content must not be emitted'}],
            'usage': {'input': 10, 'cacheRead': 0, 'cacheWrite': 0, 'output': 2, 'totalTokens': 12,
                      'cost': {'input': 0.01, 'cacheRead': 0, 'cacheWrite': 0, 'output': 0.02, 'total': 0.03}}
        }}) + '\n')
        self.directory = ingest_trace(root / 'runs', 'run', 'task', 1, source, 'c' * 40, 'heldout')
        self.result = root / 'result.json'
        self.result.write_text(json.dumps({'task_name': 'task', 'verifier_result': {'rewards': {'reward': 1}},
                                          'agent_execution': {'started_at': '2026-10-01T00:00:00Z', 'finished_at': '2026-10-01T00:00:03Z'}}))

    def test_scores_only_final_reward_and_uses_harbor_wall_time_without_raw_text(self):
        result = normalize_attempt(self.directory, self.result, 'stock-pi-example')
        self.assertTrue(result['passed'])
        self.assertEqual(result['wall_seconds'], 3)
        self.assertEqual(result['split'], 'heldout')
        self.assertEqual(result['harness_commit'], 'c' * 40)
        self.assertNotIn('raw heldout', json.dumps(result))

    def test_mismatched_results_and_unscored_outcomes_fail_closed(self):
        for outcome in [{'task_name': 'other', 'verifier_result': {'rewards': {'reward': 1}}},
                        {'task_name': 'task', 'verifier_result': {'rewards': {'reward': 0.5}}},
                        {'task_name': 'task', 'verifier_result': None}]:
            self.result.write_text(json.dumps(outcome))
            with self.assertRaises(ValueError):
                normalize_attempt(self.directory, self.result, 'stock-pi-example')

    def test_preserves_trial_identity_and_declared_agent_with_explicit_allowlists(self):
        outcome = json.loads(self.result.read_text())
        outcome.update({
            'id': '8cb803e1-9f30-4f12-b173-476013f3f9bd', 'trial_name': 'task__fixture',
            'task_checksum': 'd' * 64,
            'config': {'task': {'instruction': 'private task text'},
                       'agent': {'name': 'pi', 'import_path': None, 'model_name': 'example/model',
                                 'env': {'EXAMPLE_API_KEY': 'provider secret'}, 'kwargs': {'secret': 'provider secret'}}},
            'agent_info': {'name': 'pi', 'version': 'fixture-version',
                           'model_info': {'name': 'model', 'provider': 'example', 'secret': 'provider secret'},
                           'extra': 'private task text'},
        })
        self.result.write_text(json.dumps(outcome))
        result = normalize_attempt(self.directory, self.result, 'stock-pi-example')
        self.assertEqual(result['run_id'], 'run')
        self.assertEqual(result['trial_id'], outcome['id'])
        self.assertEqual(result['trial_name'], outcome['trial_name'])
        self.assertEqual(result['task_checksum'], 'd' * 64)
        self.assertEqual(result['declared_agent'], {'name': 'pi', 'import_path': None, 'model_name': 'example/model'})
        self.assertEqual(result['agent_info'], {'name': 'pi', 'version': 'fixture-version',
                                              'model_info': {'name': 'model', 'provider': 'example'}})
        self.assertNotIn('provider secret', json.dumps(result))
        self.assertNotIn('private task text', json.dumps(result))

    def test_trace_result_association_remains_caller_supplied_despite_name_match(self):
        result = normalize_attempt(self.directory, self.result, 'stock-pi-example')
        association = result['trace_result_association']
        self.assertEqual(association['status'], 'caller_supplied')
        self.assertTrue(association['task_name_match'])
        self.assertFalse(association['trial_binding_verified'])
        self.assertTrue(any('caller-supplied' in warning for warning in result['warnings']))

    def test_same_normalized_result_cannot_be_counted_twice(self):
        result = normalize_attempt(self.directory, self.result, 'stock-pi-example')
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            summarize_runs([result, result])

    def test_unprefixed_declared_model_preserves_unknown_provider(self):
        outcome = json.loads(self.result.read_text())
        outcome.update(config={'agent': {'model_name': 'model'}},
                       agent_info={'name': 'pi', 'version': 'unknown',
                                   'model_info': {'name': 'model', 'provider': None}})
        self.result.write_text(json.dumps(outcome))
        result = normalize_attempt(self.directory, self.result, 'stock-pi-example')
        self.assertEqual(result['declared_agent']['model_name'], 'model')
        self.assertIsNone(result['agent_info']['model_info']['provider'])

    def test_malformed_supplied_identity_errors_do_not_echo_private_values(self):
        for field, value in [('id', 'private invalid UUID'), ('agent_info', []),
                             ('config', {'agent': {'model_name': {'private': 'secret'}}})]:
            with self.subTest(field=field):
                outcome = json.loads(self.result.read_text())
                outcome[field] = value
                self.result.write_text(json.dumps(outcome))
                with self.assertRaises(ValueError) as caught:
                    normalize_attempt(self.directory, self.result, 'stock-pi-example')
                self.assertNotIn('private', str(caught.exception))
                self.assertNotIn('secret', str(caught.exception))
                # Keep subtests independent of the malformed prior artifact.
                outcome.pop(field)
                self.result.write_text(json.dumps(outcome))
