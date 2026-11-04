"""Real CLI/Git/raw-file evolution smoke; all outcomes are synthetic, no inference."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from uuid import uuid4

from evals.analysis.normalize import normalize_attempt
from evals.analysis.trace_store import ingest_trace
from evals.harbor.datasets import freeze_dataset
from .loop import ROOT, _run, environment, read_json, write_json


DEV = 'SYNTHETIC_DEV_RAW_EVIDENCE'
HELDOUT = 'SYNTHETIC_HELDOUT_RAW_NEVER_EXPORT'


def _cli(arguments, *, ok=True):
    result = subprocess.run([sys.executable, '-B', '-m', 'evolve', *map(str, arguments)], cwd=ROOT,
                            env=environment(), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=90)
    if (result.returncode == 0) != ok:
        raise ValueError('evolution CLI returned unexpected status: ' + result.stdout + result.stderr)
    return json.loads(result.stdout if result.returncode == 0 or result.stdout else result.stderr)


def make_fixture(root):
    """Small frozen synthetic corpus with actual Git revisions and native JSONL bytes."""
    root = Path(root)
    repository = root / 'repository'
    repository.mkdir()
    (repository / 'prompts').mkdir()
    prompt = repository / 'prompts/system.md'
    prompt.write_text('Finish the task.\n', encoding='utf8')
    git = ['git', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'user.name=Evolution smoke', '-c', 'user.email=smoke@example.invalid']
    _run([*git, 'init', '--quiet'], cwd=repository)
    _run([*git, 'add', '.'], cwd=repository)
    _run([*git, 'commit', '--quiet', '--no-verify', '-m', 'synthetic prior version'], cwd=repository)
    prior = _run([*git, 'rev-parse', 'HEAD'], cwd=repository).strip()
    prompt.write_text('Verify the task result.\n', encoding='utf8')
    _run([*git, 'add', '.'], cwd=repository)
    _run([*git, 'commit', '--quiet', '--no-verify', '-m', 'synthetic baseline'], cwd=repository)
    baseline = _run([*git, 'rev-parse', 'HEAD'], cwd=repository).strip()
    registry = root / 'registry-source.json'
    tasks = [f'micro-evolution-task-{number:02d}' for number in range(8)]
    write_json(registry, [{'name': 'synthetic-evolution', 'version': '1', 'description': 'Mechanical fixture, not benchmark tasks',
                           'tasks': [{'name': task, 'path': 'synthetic/' + task, 'git_url': 'https://example.invalid/fixtures.git',
                                      'git_commit_id': baseline} for task in tasks]}])
    manifest = freeze_dataset(registry, root / 'dataset', 'synthetic-evolution@1', source_commit=baseline, dev_size=4, heldout_size=4)
    metadata = read_json(manifest)
    limits = root / 'evolution.json'
    write_json(limits, {'schema_version': 1, 'max_iterations': 2, 'bootstrap_samples': 100, 'image': None})
    inventory = root / 'integrity.json'
    write_json(inventory, {'expected_outputs': ['SYNTHETIC_EXPECTED_OUTPUT'], 'reviewed': True})
    fixture = {'repository': repository, 'prior': prior, 'baseline': baseline, 'manifest': manifest,
               'splits': metadata['splits'], 'limits': limits, 'inventory': inventory, 'traces': root / 'runs', 'root': root}
    fixture['baseline_records'] = seed_records(fixture, baseline, 'synthetic-baseline', improved=False)
    path = root / 'baseline-records.json'
    write_json(path, fixture['baseline_records'])
    fixture['records_path'] = path
    return fixture


def seed_records(fixture, commit, run_id, *, improved):
    records = []
    for split in ('dev', 'heldout'):
        for task in fixture['splits'][split]:
            sentinel = DEV if split == 'dev' else HELDOUT
            source = fixture['root'] / ('source-' + uuid4().hex + '.jsonl')
            usage = {'input': 10, 'cacheRead': 0, 'cacheWrite': 0, 'output': 2, 'totalTokens': 12,
                     'cost': {'input': 0.000001, 'cacheRead': 0, 'cacheWrite': 0, 'output': 0.0000004, 'total': 0.0000014}}
            rows = [{'type': 'message', 'id': 'synthetic-user', 'message': {'role': 'user', 'timestamp': 1000,
                      'content': [{'type': 'text', 'text': sentinel + ' constructed task, never executed'}]}},
                    {'type': 'message', 'id': 'synthetic-assistant', 'message': {'role': 'assistant', 'timestamp': 2000,
                      'provider': 'openrouter', 'model': 'meta/muse-spark-1.3-contributor', 'stopReason': 'stop',
                      'content': [{'type': 'text', 'text': sentinel}], 'usage': usage}}]
            raw = ('\r\n'.join(json.dumps(row) for row in rows) + '\r\n').encode('utf8')
            source.write_bytes(raw)
            directory = ingest_trace(fixture['traces'], run_id + '-' + split, task, 1, source, commit, split)
            outcome = fixture['root'] / ('outcome-' + uuid4().hex + '.json')
            write_json(outcome, {'id': str(uuid4()), 'task_name': task, 'task_checksum': hashlib.sha256(task.encode('ascii')).hexdigest(),
                                'verifier_result': {'rewards': {'reward': int(improved and split == 'dev')}},
                                'config': {'agent': {'name': 'apex', 'model_name': 'openrouter/meta/muse-spark-1.3-contributor'}}})
            record = normalize_attempt(directory, outcome, run_id, ROOT / 'evals/pricing.json')
            record.update(synthetic=True, protocol={'attempts': 1, 'thinking': 'xhigh'})
            records.append(record)
            if split == 'heldout':
                # Export must inspect split metadata first and never open even this corrupt heldout file.
                (directory / 'trace.jsonl').write_bytes(b'poisoned heldout trace, deliberately not JSON')
    return records


def run_evolution_micro():
    checks = {}
    report = {'schema_version': 1, 'kind': 'offline_evolution_contract', 'status': 'FAIL', 'synthetic': True,
              'provider_calls': 0, 'benchmark_runs': 0, 'checks': checks,
              'provenance': 'real temporary Git and CLI; all task text, outcomes and usage are constructed mechanical fixtures'}
    temporary_path = None
    def check(condition, name):
        checks[name] = bool(condition)
        if not condition:
            raise ValueError('evolution smoke check failed: ' + name)
    try:
        with tempfile.TemporaryDirectory(prefix='apex-evolution-micro-') as temporary:
            temporary_path = Path(temporary)
            fixture = make_fixture(temporary_path)
            campaign = temporary_path / 'campaign'
            prepared = _cli(['prepare', '--campaign', campaign, '--campaign-id', 'synthetic-evolution', '--history', fixture['repository'],
                             '--baseline-commit', fixture['baseline'], '--records', fixture['records_path'], '--trace-root', fixture['traces'],
                             '--dataset-manifest', fixture['manifest'], '--evolution-config', fixture['limits'],
                             '--integrity-terms', fixture['inventory'], '--synthetic'])
            check(prepared['prior_versions'] == 2 and prepared['dev_attempts'] == 4, 'history_and_raw_feedback_cli')
            corpus_files = [path for path in (campaign / 'corpus').rglob('*') if path.is_file()]
            contents = b'\n'.join(path.read_bytes() for path in corpus_files)
            check(DEV.encode() in contents and HELDOUT.encode() not in contents and b'poisoned heldout' not in contents, 'heldout_content_excluded')
            check(all(task.encode() not in contents for task in fixture['splits']['heldout']), 'heldout_identities_excluded')
            exported = next((campaign / 'corpus' / 'traces').rglob('trace.jsonl'))
            check(b'\r\n' in exported.read_bytes(), 'exact_raw_framing_preserved')
            proposal = temporary_path / 'proposal.json'
            patch = 'diff --git a/prompts/system.md b/prompts/system.md\n--- a/prompts/system.md\n+++ b/prompts/system.md\n@@ -1 +1 @@\n-Verify the task result.\n+Verify the task result before finishing.\n'
            forbidden = dict(schema_version=1, kind='prompt', change='synthetic forbidden specialization',
                             patch=patch.replace('Verify the task result before finishing.', 'SYNTHETIC_EXPECTED_OUTPUT'))
            write_json(proposal, forbidden)
            refused = _cli(['import', '--campaign', campaign, '--proposal', proposal], ok=False)
            check(refused['status'] == 'refused', 'expected_output_patch_rejected')
            write_json(proposal, {'schema_version': 1, 'kind': 'prompt', 'change': 'synthetic general verification instruction', 'patch': patch})
            candidate = _cli(['import', '--campaign', campaign, '--proposal', proposal])
            check(candidate['status'] == 'proposed' and candidate['harness_commit'] != fixture['baseline'], 'isolated_candidate_committed')
            check((fixture['repository'] / 'prompts/system.md').read_text() == 'Verify the task result.\n', 'source_checkout_unchanged')
            measures = seed_records(fixture, candidate['harness_commit'], 'synthetic-candidate', improved=True)
            measured_file = temporary_path / 'candidate-records.json'
            write_json(measured_file, measures)
            decided = _cli(['decide', '--campaign', campaign, '--records', measured_file])
            check(decided['status'] == 'accepted' and decided['dev']['ci95'] == [1.0, 1.0] and decided['heldout']['ci95'] == [0.0, 0.0], 'dev_noise_and_heldout_gate_cli')
            board = read_json(campaign / 'leaderboard.json')
            check(len(board['entries']) == 1 and board['entries'][0]['synthetic'] is True, 'synthetic_leaderboard_persisted')
            check(read_json(campaign / 'campaign.json')['baseline_commit'] == fixture['baseline'], 'synthetic_never_promoted')
            refused = _cli(['import', '--campaign', campaign, '--proposal', proposal], ok=False)
            check(refused['status'] == 'refused' and 'iteration limit' in refused['reason'], 'iteration_cap_enforced')
            blocked = _cli(['run', '--campaign', temporary_path / 'nonexistent', '--estimate-usd', '0.1'], ok=False)
            check(blocked['status'] == 'blocked' and not (temporary_path / 'nonexistent').exists(), 'offline_denial_before_allocation')
            check(HELDOUT not in json.dumps(decided) + (campaign / 'leaderboard.md').read_text(), 'aggregate_decision_boundary')
        report['status'] = 'PASS'
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as exc:
        report['failure'] = str(exc) if type(exc) is ValueError else 'mechanical smoke operation failed'
    finally:
        checks['temporary_fixture_removed'] = temporary_path is not None and not temporary_path.exists()
    return report


def main():
    result = run_evolution_micro()
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
