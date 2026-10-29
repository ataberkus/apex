from pathlib import Path
import tempfile
import unittest
from evals.harbor.plan import prepare_plan
from evals.harbor.final_validation import prepare_matrix
from evals.harbor.datasets import freeze_dataset
import json

SHA = 'b' * 40


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        source = root / 'input-registry.json'
        source.write_text(json.dumps([{'name': 'terminal-bench', 'version': '2.0', 'description': 'fixture', 'tasks': [
            {'name': f'fixture-{i}', 'git_url': 'https://example.invalid/tasks.git', 'git_commit_id': SHA, 'path': f'tasks/fixture-{i}'}
            for i in range(3)]}]))
        output = root / 'frozen'
        freeze_dataset(source, output, source_commit=SHA, dev_size=1, heldout_size=1)
        self.manifest = output / 'manifest.json'

    def paid_config(self):
        return {'budget_cap_usd': 20, 'paid_runs_enabled': True, 'main_model': 'provider/model',
                'container_environment': 'docker', 'dataset_manifest': str(self.manifest)}

    def test_current_unconfigured_zero_budget_produces_blocked_plan(self):
        plan = prepare_plan({'budget_cap_usd': 0, 'main_model': None, 'container_environment': None}, 'pilot', 1, SHA)
        self.assertEqual(plan['status'], 'blocked')
        self.assertIsNone(plan['harbor_argv'])
        self.assertGreaterEqual(len(plan['blockers']), 3)

    def test_unpinned_dataset_cannot_become_ready_despite_valid_paid_setup(self):
        config = {'budget_cap_usd': 20, 'paid_runs_enabled': True, 'main_model': 'provider/model', 'container_environment': 'docker'}
        plan = prepare_plan(config, 'pilot', 1, SHA)
        self.assertEqual(plan['status'], 'blocked')
        self.assertIsNone(plan['harbor_argv'])
        self.assertTrue(any('manifest' in item for item in plan['blockers']))

    def test_ready_plan_pins_stock_pi_and_keeps_timeout_resources_untouched(self):
        config = self.paid_config()
        plan = prepare_plan(config, 'pilot', 1, SHA, attempts=5)
        self.assertEqual(plan['status'], 'ready_for_review')
        command = plan['harbor_argv']
        self.assertIn('version=1.4.0', command)
        self.assertIn('5', command)
        self.assertNotIn('--agent-timeout-multiplier', command)
        self.assertNotIn('--force-build', command)
        self.assertNotIn('--upload', command)
        self.assertNotIn('--launch', command)
        self.assertIn('--registry-path', command)
        self.assertIn('--include-task-name', command)
        self.assertEqual(plan['planned_trials'], 5)
        self.assertEqual(len(plan['dataset_manifest_sha256']), 64)
        self.assertEqual(plan['image_digests_status'], 'unresolved')

    def test_apex_plan_requires_an_existing_tarball(self):
        config = self.paid_config()
        self.assertEqual(prepare_plan(config, 'pilot', 1, SHA, agent='apex')['status'], 'blocked')
        with tempfile.TemporaryDirectory() as d:
            archive = Path(d) / 'apex.tgz'
            archive.write_bytes(b'fixture archive')
            plan = prepare_plan(config, 'pilot', 1, SHA, agent='apex', apex_package=archive)
            self.assertIn('evals.harbor.apex:ApexAgent', plan['harbor_argv'])
            self.assertIn(f'apex_package={archive}', plan['harbor_argv'])

    def test_phase1_ablation_flags_have_distinct_configuration_and_argv(self):
        config={**self.paid_config(),'main_model':'openrouter/meta/muse-spark-1.3-contributor','thinking_level':'xhigh'}
        archive=Path(self.temp.name)/'phase1.tgz';archive.write_bytes(b'synthetic package')
        plan=prepare_plan(config,'variant',0.01,SHA,agent='apex',apex_package=archive,context_flags='read,shape')
        self.assertEqual(plan['status'],'ready_for_review')
        self.assertIn('context_flags=read,shape',plan['harbor_argv'])
        self.assertEqual(plan['context_flags'],'read,shape')
        self.assertEqual(plan['configuration'],'apex:read,shape')
        self.assertFalse(plan['executed'])

    def test_phase1_invalid_or_control_flags_never_produce_an_execution_command(self):
        config={**self.paid_config(),'main_model':'openrouter/meta/muse-spark-1.3-contributor','thinking_level':'xhigh'}
        for flags in ('bad','read,read','shape;bad','all,read'):
            plan=prepare_plan(config,'variant',0.01,SHA,context_flags=flags)
            self.assertIsNone(plan['harbor_argv']);self.assertEqual(plan['status'],'blocked')
        plan=prepare_plan(config,'variant',0.01,SHA,context_flags='read')
        self.assertIsNone(plan['harbor_argv'])
        self.assertTrue(any('Apex' in reason for reason in plan['blockers']))

    def test_phase2_variants_and_time_budget_are_distinct_review_only_plans(self):
        config={**self.paid_config(),'main_model':'openrouter/meta/muse-spark-1.3-contributor','thinking_level':'xhigh'}
        archive=Path(self.temp.name)/'phase2.tgz';archive.write_bytes(b'synthetic package')
        plan=prepare_plan(config,'variant',0.01,SHA,agent='apex',apex_package=archive,
                          core_flags='snapshot,todo,verify,time',time_budget_sec=100)
        self.assertEqual(plan['status'],'ready_for_review')
        self.assertIn('core_flags=snapshot,todo,verify,time',plan['harbor_argv'])
        self.assertIn('time_budget_sec=100.0',plan['harbor_argv'])
        self.assertEqual(plan['configuration'],'apex:core=snapshot,todo,verify,time')
        self.assertFalse(plan['executed'])

    def test_phase2_control_flags_or_missing_deadline_produce_no_command(self):
        config={**self.paid_config(),'main_model':'openrouter/meta/muse-spark-1.3-contributor','thinking_level':'xhigh'}
        for values in ({'core_flags':'bad'},{'core_flags':'time','time_budget_sec':False},
                       {'core_flags':'todo','time_budget_sec':10},{'core_flags':'max'}):
            plan=prepare_plan(config,'variant',0.01,SHA,**values)
            self.assertIsNone(plan['harbor_argv'])
            self.assertEqual(plan['status'],'blocked')

    def test_small_phase2_deadline_is_forwarded_as_decimal(self):
        config={**self.paid_config(),'main_model':'openrouter/meta/muse-spark-1.3-contributor','thinking_level':'xhigh'}
        archive=Path(self.temp.name)/'phase2.tgz';archive.write_bytes(b'synthetic package')
        plan=prepare_plan(config,'small',0.01,SHA,agent='apex',apex_package=archive,
                          core_flags='time',time_budget_sec=0.000001)
        self.assertIn('time_budget_sec=0.000001',plan['harbor_argv'])
        self.assertFalse(plan['executed'])

    def test_invalid_attempts_identifiers_and_models_are_rejected(self):
        for attempts in [0, -1, True]:
            with self.assertRaises(ValueError):
                prepare_plan({}, 'pilot', 1, SHA, attempts=attempts)
        with self.assertRaises(ValueError):
            prepare_plan({}, '../outside', 1, SHA)
        with self.assertRaises(ValueError):
            prepare_plan({}, 'pilot', 1, 'shortsha')

    def test_shell_metacharacters_in_model_never_produce_an_executable_plan(self):
        config = {'budget_cap_usd': 20, 'paid_runs_enabled': True, 'container_environment': 'docker'}
        for model in ['openai/example;printf${IFS}unexpected', 'openai/$(cmd)', 'openai/model`cmd`', 'openai/model\ncmd']:
            with self.subTest(model=model):
                plan = prepare_plan({**config, 'main_model': model}, 'pilot', 1, SHA)
                self.assertEqual(plan['status'], 'blocked')
                self.assertIsNone(plan['harbor_argv'])

    def test_explicit_model_allowlist_blocks_any_other_model(self):
        config = self.paid_config()
        config['allowed_models'] = ['openrouter/meta/muse-spark-1.3-contributor']
        plan = prepare_plan(config, 'pilot', 0.01, SHA)
        self.assertEqual(plan['status'], 'blocked')
        self.assertIsNone(plan['harbor_argv'])
        self.assertTrue(any('allowed' in reason for reason in plan['blockers']))

    def test_xhigh_applies_equally_to_stock_and_apex(self):
        config = {**self.paid_config(), 'thinking_level': 'xhigh'}
        with tempfile.TemporaryDirectory() as d:
            archive = Path(d) / 'apex.tgz'
            archive.write_bytes(b'fixture archive')
            for agent in ['stock-pi', 'apex']:
                with self.subTest(agent=agent):
                    plan = prepare_plan(config, 'pilot', 0.01, SHA, agent=agent, apex_package=archive)
                    self.assertEqual(plan['status'], 'ready_for_review')
                    self.assertIn('thinking=xhigh', plan['harbor_argv'])
                    self.assertEqual(plan['thinking_level'], 'xhigh')

    def test_invalid_thinking_never_produces_a_command(self):
        for thinking in ['unknown', 'xhigh;cmd', True, ['xhigh']]:
            plan = prepare_plan({**self.paid_config(), 'thinking_level': thinking}, 'pilot', 0.01, SHA)
            self.assertEqual(plan['status'], 'blocked')
            self.assertIsNone(plan['harbor_argv'])
            self.assertTrue(any('thinking' in reason for reason in plan['blockers']))

    def test_full_and_heldout_scope_remain_explicit(self):
        full = prepare_plan(self.paid_config(), 'full', 1, SHA, attempts=5, split='full')
        self.assertEqual(full['planned_trials'], 15)
        self.assertNotIn('--include-task-name', full['harbor_argv'])
        heldout = prepare_plan(self.paid_config(), 'heldout', 1, SHA, split='heldout')
        self.assertEqual(heldout['task_count'], 1)
        self.assertEqual(heldout['split'], 'heldout')

    def test_changed_snapshot_or_dataset_never_produces_a_command(self):
        wrong = prepare_plan(self.paid_config(), 'pilot', 1, SHA, dataset='terminal-bench@2.1')
        self.assertEqual(wrong['status'], 'blocked')
        (self.manifest.parent / 'registry.json').write_text('[]')
        tampered = prepare_plan(self.paid_config(), 'pilot', 1, SHA)
        self.assertEqual(tampered['status'], 'blocked')
        self.assertIsNone(tampered['harbor_argv'])

    def test_unknown_harness_and_cost_remain_blocked_not_zero(self):
        plan = prepare_plan(self.paid_config(), 'unknown', None, None)
        self.assertIsNone(plan['harness_commit'])
        self.assertIsNone(plan['estimated_token_cost_usd'])
        self.assertIsNone(plan['harbor_argv'])
        self.assertTrue(any('harness commit is unknown' in reason for reason in plan['blockers']))
        self.assertTrue(any('cost is unknown' in reason for reason in plan['blockers']))

    def test_sol_login_cannot_make_stock_or_apex_container_ready(self):
        archive = Path(self.temp.name) / 'apex.tgz'
        archive.write_bytes(b'fixture archive')
        config = {**self.paid_config(), 'main_model': 'openai-codex/gpt-6.1-sol', 'thinking_level': 'xhigh'}
        for agent in ('stock-pi', 'apex'):
            plan = prepare_plan(config, 'oauth', 1, SHA, agent=agent, apex_package=archive)
            self.assertIsNone(plan['harbor_argv'])
            self.assertTrue(any('host login is not container credential provisioning' in reason for reason in plan['blockers']))
            if agent == 'apex':
                self.assertTrue(any('exclusion from logs/artifacts' in reason for reason in plan['blockers']))

    def test_final_matrix_preserves_offline_policy_and_complete_paired_scope(self):
        matrix = json.loads(Path('evals/final-validation.json').read_text(encoding='utf8'))
        matrix['dataset_manifest'] = str(self.manifest)
        policy = {**self.paid_config(), 'execution_policy': 'offline-only', 'paid_runs_enabled': False}
        before = dict(policy)
        result = prepare_matrix(policy, matrix)
        self.assertEqual(policy, before)
        expected = {(model, split, agent) for model in matrix['models']
                    for split in matrix['splits'] for agent in matrix['agents']}
        self.assertEqual({(p['main_model'], p['split'], p['configuration']) for p in result['plans']}, expected)
        self.assertEqual(len(result['plans']), 12)
        self.assertEqual(result['baseline_status'], 'absent')
        self.assertEqual(result['default_on_ablation_count'], 0)
        for plan in result['plans']:
            self.assertIsNone(plan['harbor_argv'])
            self.assertIsNone(plan['estimated_token_cost_usd'])
            self.assertEqual(plan['attempts'], 5)
            self.assertEqual(plan['planned_trials'], 15 if plan['split'] == 'full' else 5)
            self.assertEqual(plan['thinking_level'], 'xhigh')
            self.assertFalse(plan['executed'])
            self.assertTrue(any('offline-only' in reason for reason in plan['blockers']))
            self.assertTrue(any('Docker Linux daemon' in reason for reason in plan['blockers']))
            self.assertTrue(any('reviewed' in reason for reason in plan['blockers']))

    def test_final_matrix_rejects_missing_pairs_or_feature_promotion(self):
        matrix = json.loads(Path('evals/final-validation.json').read_text(encoding='utf8'))
        for change in ({'attempts': 1}, {'models': matrix['models'][:1]},
                       {'splits': ['dev']}, {'default_on_ablations': ['read']}):
            with self.assertRaises(ValueError):
                prepare_matrix({}, {**matrix, **change})
