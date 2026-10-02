import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch


PROJECT = Path(__file__).resolve().parents[1]


def pipeline():
    spec = importlib.util.find_spec('evals.micro.pipeline')
    if spec is None:
        raise AssertionError('offline CLI pipeline micro gate must exist')
    from evals.micro.pipeline import run_pipeline_micro
    return run_pipeline_micro


class PipelineMicroTests(unittest.TestCase):
    def test_import_is_inert_without_allocating_a_fixture_or_starting_a_process(self):
        self.assertIsNotNone(importlib.util.find_spec('evals.micro.pipeline'),
                             'offline CLI pipeline micro gate must exist')
        source = '''
import subprocess, tempfile
def forbidden(*args, **kwargs):
    raise AssertionError("import performed work")
subprocess.Popen = forbidden
tempfile.TemporaryDirectory = forbidden
import evals.micro.pipeline
print("inert")
'''
        result = subprocess.run([sys.executable, '-c', source], cwd=PROJECT,
                                env={'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1'},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'inert')

    def test_real_clis_preserve_measurements_guards_and_scrubbed_environment_then_clean_up(self):
        run = pipeline()
        before = set(PROJECT.glob('pipeline-micro-*'))
        real_popen = subprocess.Popen
        environments = []
        modules = set()

        def observe(command, *args, **kwargs):
            environments.append(set(kwargs['env']))
            modules.add(command[2])
            return real_popen(command, *args, **kwargs)

        with patch.dict(os.environ, {'APEX_PIPELINE_UNSAFE_ENV': 'test-only-sentinel'}), \
                patch('subprocess.Popen', side_effect=observe):
            artifact = run(PROJECT)
        self.assertEqual(artifact['status'], 'PASS', artifact)
        self.assertEqual(artifact['kind'], 'offline_pipeline_contract')
        self.assertEqual(artifact['provider_calls'], 0)
        self.assertEqual(artifact['benchmark_runs'], 0)
        self.assertTrue(artifact['synthetic'])
        self.assertTrue(all(artifact['checks'].values()), artifact['checks'])
        observation = artifact['observations']
        self.assertEqual((observation['task_clusters'], observation['attempts'], observation['successful_trials']), (1, 2, 1))
        self.assertEqual(observation['synthetic_mean_pass_fraction'], 0.5)
        self.assertIsNone(observation['ci95'])
        self.assertEqual(observation['tokens'], {'input': 140, 'cache_read': 50, 'cache_write': 7, 'output': 15, 'total': 212})
        for field in ('thinking_tokens', 'mean_wall_seconds', 'total_registry_token_cost_usd', 'billed_total_usd'):
            self.assertIsNone(observation[field], field)
        self.assertAlmostEqual(observation['known_registry_token_cost_usd'], 0.0000121)
        self.assertEqual(observation['known_mean_wall_seconds'], 3)
        self.assertEqual(observation['association_status'], 'caller_supplied')
        self.assertFalse(observation['trial_binding_verified'])
        self.assertEqual(observation['duplicate_rejection_identity'], 'trial_id')
        self.assertEqual(observation['heldout_refusal'], 'PermissionError')
        self.assertNotIn('SYNTHETIC_RAW_ONLY_', json.dumps(artifact))
        self.assertEqual(set(PROJECT.glob('pipeline-micro-*')), before)
        self.assertTrue(environments, 'gate must exercise real CLI boundaries')
        self.assertTrue({'evals.analysis.trace_store', 'evals.analysis.normalize',
                         'evals.analysis.report', 'evals.analysis.failures'} <= modules)
        allowed = {'PATH', 'LANG', 'LC_ALL', 'PYTHONIOENCODING', 'PYTHONDONTWRITEBYTECODE',
                   'PYTHONNOUSERSITE', 'SystemRoot', 'SYSTEMROOT'}
        self.assertTrue(all(environment <= allowed for environment in environments))

    def test_cli_failure_emits_safe_json_and_exits_nonzero(self):
        pipeline()
        result = subprocess.run([sys.executable, '-m', 'evals.micro.pipeline', '--project-root',
                                 str(PROJECT / 'missing-pipeline-project')], cwd=PROJECT,
                                env={'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1'},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1, result.stderr)
        artifact = json.loads(result.stdout)
        self.assertEqual(artifact['status'], 'FAIL')
        self.assertEqual(artifact['provider_calls'], 0)
        self.assertEqual(artifact['benchmark_runs'], 0)
        self.assertEqual(result.stderr, '')
        self.assertNotIn('SYNTHETIC_RAW_ONLY_', result.stdout)


if __name__ == '__main__':
    unittest.main()
