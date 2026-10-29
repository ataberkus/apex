"""Phase 3 adapter/planner boundaries: fake environments, no paid execution."""

import contextlib
import io
import json
import shlex
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest.mock import patch

from harbor.agents.installed.pi import Pi
from harbor.agents.model_connection import ResolvedModelConnection
from harbor.models.agent.context import AgentContext

from evals.feature_flags import FEATURES, selected_feature_flags, validate_feature_flags
from evals.harbor.apex import ApexAgent, ApexOptions
from evals.harbor.datasets import freeze_dataset
from evals.harbor.plan import main, prepare_plan
from test_harbor_adapter import FakeEnvironment


MODEL = 'openrouter/meta/muse-spark-1.3-contributor'
SHA = 'b' * 40


class FeatureFlagTests(unittest.TestCase):
    def test_exact_ten_flags_and_default_off(self):
        self.assertEqual(FEATURES, ('cost', 'checkpoints', 'review', 'plan', 'remember', 'skills', 'safety', 'report', 'resume', 'autocompact'))
        self.assertEqual(validate_feature_flags(''), '')
        self.assertEqual(selected_feature_flags(''), ())
        self.assertEqual(selected_feature_flags('all'), FEATURES)
        self.assertEqual(selected_feature_flags('remember,plan'), ('remember', 'plan'))

    def test_invalid_duplicate_and_non_string_flags_fail_closed(self):
        for value in ('bad', 'all,cost', 'cost,cost', 'remember;command', ' plan', 'plan,', None, True, [], 1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_feature_flags(value)


class FeatureAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / 'apex ; fixture.tgz'
        self.archive.write_bytes(b'fixture only')
        self.environment = FakeEnvironment()

    def agent(self, **values):
        return ApexAgent(**{
            'logs_dir': self.root / 'logs',
            'environment_logs_dir': PurePosixPath('/logs/agent'),
            'model_name': MODEL,
            'apex_package': str(self.archive),
            **values,
        })

    async def test_feature_variant_forwards_explicit_eval_prefix_and_task_verbatim(self):
        agent = self.agent(feature_flags='remember,plan,cost', thinking='xhigh')
        task = 'literal --apex-features all --apex-eval; do not parse task options'
        await agent.run(task, self.environment, AgentContext())
        call = next(event[1] for event in self.environment.events if event[0] == 'exec' and 'apex --profile' in event[1]['command'])
        self.assertIn('--apex-features remember,plan,cost --apex-eval --print --mode json', call['command'])
        self.assertIn(shlex.quote(task), call['command'])
        self.assertIn('--thinking xhigh', call['command'])
        self.assertIsNone(call['timeout_sec'])

    async def test_combined_three_phase_variant_retains_deadline_and_all_prefixes(self):
        agent = self.agent(context_flags='read,shape', core_flags='todo,time', time_budget_sec=45,
                           feature_flags='cost,checkpoints', thinking='xhigh')
        await agent.run('task', self.environment, AgentContext())
        command = next(event[1]['command'] for event in self.environment.events if event[0] == 'exec' and 'apex --profile' in event[1]['command'])
        self.assertIn('--apex-context read,shape --apex-core todo,time --time-budget 45.0 --apex-features cost,checkpoints --apex-eval --print', command)

    async def test_default_preserves_existing_run_string_and_no_eval_token(self):
        await self.agent(model_name='openai/synthetic-model').run('task', self.environment, AgentContext())
        command = next(event[1]['command'] for event in self.environment.events if event[0] == 'exec' and 'apex --profile' in event[1]['command'])
        self.assertIn('apex --profile headless --print --mode json', command)
        self.assertNotIn('--apex-features', command)
        self.assertNotIn('--apex-eval', command)

    def test_invalid_variants_fail_before_parent_initialization(self):
        variants = ({'feature_flags': 'bad'}, {'feature_flags': 'cost,cost'}, {'feature_flags': 'all,cost'},
                    {'feature_flags': 'cost;bad'}, {'feature_flags': False},
                    {'feature_flags': 'cost', 'model_name': 'openai/synthetic'},
                    {'feature_flags': 'cost', 'thinking': 'high'},
                    {'feature_flags': 'cost', 'reasoning_effort': 'high'})
        for values in variants:
            with self.subTest(values=values), patch.object(Pi, '__init__', return_value=None) as parent:
                with self.assertRaises(ValueError):
                    self.agent(**values)
                parent.assert_not_called()
        self.assertEqual(self.environment.events, [])

    async def test_selected_variant_defaults_xhigh(self):
        await self.agent(feature_flags='all').run('task', self.environment, AgentContext())
        command = next(event[1]['command'] for event in self.environment.events if event[0] == 'exec' and 'apex --profile' in event[1]['command'])
        self.assertIn('--thinking xhigh', command)
        self.assertIn('--apex-features all --apex-eval --print', command)

    async def test_effective_provider_override_blocked_before_environment_access(self):
        agent = self.agent(feature_flags='cost')
        connection = ResolvedModelConnection(provider='openai')
        with patch.object(Pi, 'model_connection', property(lambda self: connection)):
            with self.assertRaisesRegex(ValueError, 'provider'):
                await agent.run('task', self.environment, AgentContext())
        self.assertEqual(self.environment.events, [])

    def test_options_schema_independently_validates_features(self):
        for value in ('bad', 'cost,cost', 'all,plan', False):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApexOptions(apex_package=str(self.archive), feature_flags=value)
        self.assertEqual(ApexOptions(apex_package=str(self.archive)).feature_flags, '')


class FeaturePlannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = self.root / 'fixture-registry.json'
        source.write_text(json.dumps([{'name': 'terminal-bench', 'version': '2.0', 'description': 'fixture', 'tasks': [
            {'name': f'fixture-{i}', 'git_url': 'https://example.invalid/tasks.git', 'git_commit_id': SHA, 'path': f'tasks/fixture-{i}'}
            for i in range(3)]}]))
        freeze_dataset(source, self.root / 'frozen', source_commit=SHA, dev_size=1, heldout_size=1)
        self.archive = self.root / 'fixture.tgz'
        self.archive.write_bytes(b'synthetic package')
        self.config = {'budget_cap_usd': 1, 'paid_runs_enabled': True, 'main_model': MODEL,
                       'thinking_level': 'xhigh', 'container_environment': 'docker',
                       'dataset_manifest': str(self.root / 'frozen' / 'manifest.json')}

    def plan(self, **values):
        return prepare_plan(self.config, 'variant', 0.01, SHA, agent='apex', apex_package=self.archive, **values)

    def test_variant_is_annotated_and_prepared_only(self):
        plan = self.plan(feature_flags='cost,remember')
        self.assertEqual(plan['status'], 'ready_for_review')
        self.assertEqual(plan['configuration'], 'apex:features=cost,remember')
        self.assertEqual(plan['feature_flags'], 'cost,remember')
        self.assertTrue(plan['eval_mode'])
        self.assertIn('feature_flags=cost,remember', plan['harbor_argv'])
        self.assertFalse(plan['executed'])
        self.assertNotIn('--agent-timeout-multiplier', plan['harbor_argv'])
        self.assertNotIn('--env-kwarg', plan['harbor_argv'])

    def test_all_three_phases_get_distinct_annotation(self):
        plan = self.plan(context_flags='shape', core_flags='time', time_budget_sec=12, feature_flags='report')
        self.assertEqual(plan['configuration'], 'apex:shape;core=time;features=report')
        self.assertIn('time_budget_sec=12.0', plan['harbor_argv'])
        self.assertIn('feature_flags=report', plan['harbor_argv'])

    def test_stock_control_and_invalid_flags_produce_no_command(self):
        for value in ('cost', 'bad', 'cost,cost', 'all,cost', 'cost;bad', False):
            with self.subTest(value=value):
                plan = prepare_plan(self.config, 'control', 0.01, SHA, feature_flags=value)
                self.assertEqual(plan['status'], 'blocked')
                self.assertIsNone(plan['harbor_argv'])

    def test_different_model_or_thinking_produces_no_command(self):
        for overrides in ({'main_model': 'openai/synthetic'}, {'thinking_level': 'high'}, {'thinking_level': None}):
            with self.subTest(overrides=overrides):
                plan = prepare_plan({**self.config, **overrides}, 'variant', 0.01, SHA,
                                    agent='apex', apex_package=self.archive, feature_flags='cost')
                self.assertEqual(plan['status'], 'blocked')
                self.assertIsNone(plan['harbor_argv'])

    def test_free_only_policy_retains_block_even_with_zero_estimate(self):
        plan = prepare_plan({**self.config, 'paid_runs_enabled': False}, 'variant', 0, SHA,
                            agent='apex', apex_package=self.archive, feature_flags='all')
        self.assertEqual(plan['status'], 'blocked')
        self.assertIsNone(plan['harbor_argv'])
        self.assertFalse(plan['executed'])

    def test_existing_positional_signature_is_unchanged_and_final_kwarg_is_added(self):
        plan = prepare_plan(self.config, 'legacy', 0.01, SHA, 'apex', 'terminal-bench@2.0', 1,
                            self.archive, 0, 0, None, 'dev', 'shape', 'time', 12)
        self.assertEqual(plan['status'], 'ready_for_review')
        self.assertEqual(plan['configuration'], 'apex:shape;core=time')
        self.assertEqual(plan['feature_flags'], '')
        self.assertFalse(plan['eval_mode'])

    def test_cli_feature_flags_only_prepares_json(self):
        config = self.root / 'config.json'
        config.write_text(json.dumps(self.config))
        args = ['plan', '--config', str(config), '--run-id', 'cli-fixture', '--estimate-usd', '0.01',
                '--harness-commit', SHA, '--agent', 'apex', '--apex-package', str(self.archive),
                '--feature-flags', 'cost,remember']
        output = io.StringIO()
        with patch.object(sys, 'argv', args), contextlib.redirect_stdout(output):
            result = main()
        self.assertEqual(result, 0)
        plan = json.loads(output.getvalue())
        self.assertEqual(plan['feature_flags'], 'cost,remember')
        self.assertFalse(plan['executed'])


if __name__ == '__main__':
    unittest.main()
