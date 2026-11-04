"""Credential-free synthetic gate across the existing offline analysis CLIs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading


_MODEL = 'meta/muse-spark-1.3-contributor'
_PROVIDER = 'openrouter'
_TASK = 'synthetic-pipeline-task'
_RUN = 'synthetic-pipeline-run'
_COMMIT = 'f' * 40  # Deliberate fixture placeholder, never a claimed git revision.
_CHECKSUM = 'd' * 64
_SENTINEL = 'SYNTHETIC_RAW_ONLY_DO_NOT_REPORT'
_MODULES = {'evals.analysis.trace_store', 'evals.analysis.normalize',
            'evals.analysis.report', 'evals.analysis.failures'}
_OUTPUT_LIMIT = 65536
_CHILD_TIMEOUT = 5


class _GateFailure(Exception):
    pass


def _environment():
    env = {'PATH': str(Path(sys.executable).resolve().parent) + os.pathsep + os.defpath,
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'PYTHONIOENCODING': 'utf-8',
           'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'}
    if os.name == 'nt':
        for name in ('SystemRoot', 'SYSTEMROOT'):
            if name in os.environ:
                env[name] = os.environ[name]
    return env


def _cli(project_root, module, arguments):
    if module not in _MODULES:
        raise _GateFailure('unexpected_cli')
    command = [str(Path(sys.executable).resolve()), '-m', module, *map(str, arguments)]
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()
    # Readers enforce the cap while the child runs, rather than retaining an
    # unbounded communicate() result and checking its size afterward.
    with subprocess.Popen(command, cwd=project_root, env=_environment(), shell=False,
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        def collect(pipe, buffer):
            while chunk := pipe.read(4096):
                if len(buffer) + len(chunk) > _OUTPUT_LIMIT:
                    overflow.set()
                    process.kill()
                    return
                buffer.extend(chunk)

        readers = [threading.Thread(target=collect, args=(pipe, buffer), daemon=True)
                   for pipe, buffer in zip((process.stdout, process.stderr), buffers)]
        for reader in readers:
            reader.start()
        timed_out = False
        try:
            process.wait(timeout=_CHILD_TIMEOUT)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            process.wait(timeout=1)
        for reader in readers:
            reader.join(timeout=1)
        if timed_out:
            raise _GateFailure('cli_timeout')
        if overflow.is_set():
            raise _GateFailure('cli_output_limit')
        if any(reader.is_alive() for reader in readers):
            raise _GateFailure('cli_output_unavailable')
        try:
            return subprocess.CompletedProcess(command, process.returncode,
                                               buffers[0].decode('utf8'), buffers[1].decode('utf8'))
        except UnicodeDecodeError:
            raise _GateFailure('cli_output_encoding') from None


def _write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n', encoding='utf8')


def _fixture_trace(attempt):
    input_tokens, cached, written, output = (100, 50, 0, 10) if attempt == 1 else (40, 0, 7, 5)
    catalog_input, catalog_cache, catalog_output = (0.00001, 0.0000001, 0.000002) if attempt == 1 else (0.000004, 0, 0.000001)
    content = [{'type': 'text', 'text': _SENTINEL + '\u2028synthetic assistant text'}]
    if attempt == 2:
        content.append({'type': 'toolCall', 'id': 'synthetic-tool', 'name': 'bash',
                        'arguments': {'command': 'synthetic placeholder; never executed'}})
    message = {'role': 'assistant', 'api': 'openai-completions', 'provider': _PROVIDER, 'model': _MODEL,
               'timestamp': 2000, 'stopReason': 'stop' if attempt == 1 else 'toolUse', 'content': content,
               'usage': {'input': input_tokens, 'cacheRead': cached, 'cacheWrite': written, 'output': output,
                         'totalTokens': input_tokens + cached + written + output,
                         'cost': {'input': catalog_input, 'cacheRead': catalog_cache, 'cacheWrite': 0,
                                  'output': catalog_output, 'total': catalog_input + catalog_cache + catalog_output}}}
    events = [{'type': 'message', 'id': 'synthetic-user', 'message': {
        'role': 'user', 'timestamp': 1000, 'content': [{'type': 'text', 'text': _SENTINEL + ' synthetic task'}]}},
        {'type': 'message', 'id': f'synthetic-assistant-{attempt}', 'message': message}]
    if attempt == 2:
        events.append({'type': 'message', 'id': 'synthetic-tool-result', 'message': {
            'role': 'toolResult', 'toolCallId': 'synthetic-tool', 'toolName': 'bash', 'timestamp': 2500,
            'isError': True, 'content': [{'type': 'text', 'text': 'Synthetic command timed out; no command was executed.'}]}})
    return ('\r\n'.join(json.dumps(event, ensure_ascii=False) for event in events) + '\r\n').encode('utf8')


def run_pipeline_micro(project_root):
    """Use temporary synthetic fixtures; return safe evidence, never a benchmark score."""
    project_root = Path(project_root).resolve()
    artifact = {'schema_version': 1, 'kind': 'offline_pipeline_contract', 'status': 'FAIL',
                'provider_calls': 0, 'benchmark_runs': 0, 'synthetic': True, 'checks': {},
                'synthetic_provenance': {'usage_and_results': 'constructed fixtures; no agent or benchmark executed',
                                         'pricing': 'test-only registry; not billing evidence',
                                         'harness_commit': _COMMIT, 'harness_commit_is_synthetic': True}}
    checks = artifact['checks']

    def check(condition, name):
        checks[name] = bool(condition)
        if not condition:
            raise _GateFailure(name)

    fixture_directory = None
    try:
        if not project_root.is_dir():
            raise _GateFailure('project_root_invalid')
        with tempfile.TemporaryDirectory(prefix='pipeline-micro-', dir=project_root) as temporary:
            fixture_directory = Path(temporary)
            prices = fixture_directory / 'synthetic-prices.json'
            _write_json(prices, {'schema_version': 1, 'currency': 'USD', 'unit': 'per_million_tokens', 'models': [{
                'provider': _PROVIDER, 'model': _MODEL, 'input': 0.1, 'cache_read': 0.002,
                'cache_write': None, 'output': 0.2, 'source_url': 'https://example.invalid/synthetic-pricing',
                'retrieved_at': '2026-10-01T00:00:00Z', 'notes': 'Synthetic regression fixture; not official pricing evidence.'}]})
            records = []
            directories = []
            for attempt in (1, 2):
                raw = _fixture_trace(attempt)
                source = fixture_directory / f'synthetic-source-{attempt}.jsonl'
                source.write_bytes(raw)
                ingested = _cli(project_root, 'evals.analysis.trace_store', [
                    '--source', source, '--root', fixture_directory / 'runs', '--run-id', _RUN,
                    '--task-id', _TASK, '--attempt', attempt, '--harness-commit', _COMMIT, '--split', 'dev'])
                check(ingested.returncode == 0, f'ingest_attempt_{attempt}')
                directory = Path(ingested.stdout.strip())
                directories.append(directory)
                metadata = json.loads((directory / 'metadata.json').read_text(encoding='utf8'))
                check((directory / 'trace.jsonl').read_bytes() == raw and metadata['bytes'] == len(raw) and
                      metadata['sha256'] == hashlib.sha256(raw).hexdigest(), f'raw_integrity_attempt_{attempt}')
                result = fixture_directory / f'synthetic-result-{attempt}.json'
                trial_id = f'4b6ac4cc-0797-4c31-97a2-00000000000{attempt}'
                outcome = {'id': trial_id, 'task_name': _TASK, 'trial_name': f'{_TASK}__synthetic-{attempt}',
                           'task_checksum': _CHECKSUM, 'verifier_result': {'rewards': {'reward': 1 if attempt == 1 else 0}},
                           'config': {'agent': {'name': 'pi', 'model_name': f'{_PROVIDER}/{_MODEL}'}},
                           'agent_info': {'name': 'pi', 'version': 'synthetic-fixture',
                                          'model_info': {'name': _MODEL, 'provider': _PROVIDER}}}
                if attempt == 1:
                    outcome['agent_execution'] = {'started_at': '2026-10-01T00:00:00Z',
                                                  'finished_at': '2026-10-01T00:00:03Z'}
                _write_json(result, outcome)
                normalized_path = fixture_directory / f'normalized-{attempt}.json'
                normalized = _cli(project_root, 'evals.analysis.normalize', [directory, '--result', result,
                    '--configuration-id', 'synthetic-offline-muse', '--prices', prices, '--output', normalized_path])
                check(normalized.returncode == 0, f'normalize_attempt_{attempt}')
                record = json.loads(normalized_path.read_text(encoding='utf8'))
                check(record['run_id'] == _RUN and record['task_id'] == _TASK and record['attempt'] == attempt and
                      record['trial_id'] == trial_id and record['task_checksum'] == _CHECKSUM and
                      record['harness_commit'] == _COMMIT and record['split'] == 'dev' and
                      record['declared_agent']['model_name'] == f'{_PROVIDER}/{_MODEL}' and
                      record['agent_info']['model_info'] == {'name': _MODEL, 'provider': _PROVIDER},
                      f'identity_attempt_{attempt}')
                check(_SENTINEL not in normalized.stdout + normalized.stderr + json.dumps(record),
                      f'normalized_content_boundary_{attempt}')
                records.append(record)
            # normalize emits individual objects; report intentionally consumes an
            # explicitly assembled array rather than opening any raw trajectory.
            records_path = fixture_directory / 'record-array.json'
            _write_json(records_path, records)
            report_path, markdown_path = fixture_directory / 'report.json', fixture_directory / 'report.md'
            reported = _cli(project_root, 'evals.analysis.report', [records_path, '--output', report_path,
                '--markdown', markdown_path, '--seed', 17, '--bootstrap-samples', 100])
            check(reported.returncode == 0, 'report_cli')
            report = json.loads(report_path.read_text(encoding='utf8'))
            markdown = markdown_path.read_text(encoding='utf8')
            check((report['tasks'], report['attempts'], report['successful_trials']) == (1, 2, 1) and
                  report['pass_rate']['mean'] == 0.5 and report['pass_rate']['ci95'] is None, 'clustered_accounting')
            expected_tokens = {'input': 140, 'cache_read': 50, 'cache_write': 7, 'output': 15, 'total': 212}
            check(all(report['tokens'][name]['total'] == value for name, value in expected_tokens.items()), 'token_accounting')
            check(abs(records[0]['cost']['registry_usd'] - 0.0000121) < 1e-15 and
                  records[1]['cost']['registry_usd'] is None and report['cost']['total_usd'] is None and
                  abs(report['cost']['known_total_usd'] - 0.0000121) < 1e-15 and
                  report['cost']['billed_total_usd'] is None, 'unknown_pricing_retained')
            check(all(record['tokens']['thinking_tokens'] is None for record in records) and
                  records[1]['wall_seconds'] is None and report['tokens']['thinking_tokens']['total'] is None and
                  report['wall_seconds']['mean'] is None and report['wall_seconds']['known_mean'] == 3,
                  'unknown_observations_retained')
            check(report['trace_result_association']['status_counts']['caller_supplied'] == 2 and
                  all(record['trace_result_association']['trial_binding_verified'] is False for record in records) and
                  'caller-supplied' in markdown and 'unknown' in markdown and 'Synthetic' in markdown,
                  'provenance_and_limits_visible')
            check(_SENTINEL not in report_path.read_text(encoding='utf8') + markdown +
                  reported.stdout + reported.stderr, 'report_content_boundary')
            reused_trial = dict(records[1], trial_id=records[0]['trial_id'])
            duplicates_path = fixture_directory / 'duplicate-trial-array.json'
            _write_json(duplicates_path, [records[0], reused_trial])
            duplicate_output = fixture_directory / 'duplicate-report.json'
            duplicate = _cli(project_root, 'evals.analysis.report', [duplicates_path, '--output', duplicate_output])
            check(duplicate.returncode == 2 and 'duplicate' in duplicate.stderr and 'trial_id' in duplicate.stderr and
                  not duplicate_output.exists() and _SENTINEL not in duplicate.stdout + duplicate.stderr,
                  'duplicate_trial_rejected')
            dev_failure = _cli(project_root, 'evals.analysis.failures', [directories[1]])
            check(dev_failure.returncode == 0, 'dev_failure_cli')
            suggestion = json.loads(dev_failure.stdout)
            check(suggestion['status'] == 'provisional' and suggestion['label'] == 'timeout' and
                  not (directories[1] / 'classification.json').exists(), 'dev_suggestion_is_provisional')
            heldout = _cli(project_root, 'evals.analysis.trace_store', ['--source', source,
                '--root', fixture_directory / 'runs', '--run-id', 'synthetic-heldout-run', '--task-id', _TASK,
                '--attempt', 1, '--harness-commit', _COMMIT, '--split', 'heldout'])
            check(heldout.returncode == 0, 'heldout_ingest')
            protected_directory = Path(heldout.stdout.strip())
            (protected_directory / 'trace.jsonl').unlink()
            refused = _cli(project_root, 'evals.analysis.failures', [protected_directory])
            check(refused.returncode != 0 and 'PermissionError' in refused.stderr and
                  'FileNotFoundError' not in refused.stderr and 'dev-only' in refused.stderr and
                  _SENTINEL not in refused.stdout + refused.stderr and
                  not (protected_directory / 'classification.json').exists(), 'heldout_refused_before_trace_read')
            artifact['observations'] = {'task_clusters': 1, 'attempts': 2, 'successful_trials': 1,
                'synthetic_mean_pass_fraction': report['pass_rate']['mean'], 'ci95': report['pass_rate']['ci95'],
                'tokens': {name: report['tokens'][name]['total'] for name in expected_tokens},
                'thinking_tokens': report['tokens']['thinking_tokens']['total'],
                'mean_wall_seconds': report['wall_seconds']['mean'], 'known_mean_wall_seconds': report['wall_seconds']['known_mean'],
                'total_registry_token_cost_usd': report['cost']['total_usd'],
                'known_registry_token_cost_usd': report['cost']['known_total_usd'], 'billed_total_usd': report['cost']['billed_total_usd'],
                'association_status': 'caller_supplied', 'trial_binding_verified': False,
                'duplicate_rejection_identity': 'trial_id', 'heldout_refusal': 'PermissionError'}
            check(_SENTINEL not in json.dumps(artifact), 'artifact_content_boundary')
        check(not fixture_directory.exists(), 'fixture_removed')
        artifact['status'] = 'PASS'
    except _GateFailure as error:
        artifact['failure'] = str(error)
    except Exception:
        # Child output, paths and fixture data stay private even on an unexpected
        # analysis failure. The gate returns a failure rather than a false PASS.
        artifact['failure'] = 'unexpected_pipeline_failure'
    finally:
        if fixture_directory is not None:
            checks['fixture_removed'] = not fixture_directory.exists()
    return artifact


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-root', type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    artifact = run_pipeline_micro(args.project_root)
    print(json.dumps(artifact, indent=2, sort_keys=True, allow_nan=False))
    return 0 if artifact['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
