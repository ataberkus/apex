"""Normalize ingested JSONL plus a Harbor result artifact; never inspect verifier code."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
from uuid import UUID

from .metrics import analyze_pi_trace


def _identity_fields(value, fields, label):
    """Copy only declared scalar identities, never an entire Harbor config."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f'invalid Harbor {label}')
    selected = {}
    for field in fields:
        if field in value:
            if value[field] is not None and not isinstance(value[field], str):
                raise ValueError(f'invalid Harbor {label}.{field}')
            selected[field] = value[field]
    return selected


def normalize_attempt(directory, result_path, configuration_id, prices=None):
    directory = Path(directory)
    if not isinstance(configuration_id, str) or not configuration_id.strip():
        raise ValueError('configuration_id is required')
    metadata = json.loads((directory / 'metadata.json').read_text(encoding='utf8'))
    raw = directory / 'trace.jsonl'
    if hashlib.sha256(raw.read_bytes()).hexdigest() != metadata.get('sha256'):
        raise ValueError('raw trace hash changed')
    result_bytes = Path(result_path).read_bytes()
    outcome = json.loads(result_bytes)
    if not isinstance(outcome, dict) or outcome.get('task_name') != metadata.get('task_id'):
        raise ValueError('Harbor result task does not match ingested task')
    trial_id = outcome.get('id')
    if trial_id is not None:
        try:
            if not isinstance(trial_id, str):
                raise ValueError
            trial_id = str(UUID(trial_id))
        except ValueError:
            raise ValueError('invalid Harbor id: expected trial UUID') from None
    result_identity = _identity_fields(outcome, ('trial_name', 'task_checksum'), 'result')
    config = outcome.get('config')
    if config is not None and not isinstance(config, dict):
        raise ValueError('invalid Harbor config')
    declared_agent = _identity_fields(config.get('agent') if config is not None else None,
                                      ('name', 'import_path', 'model_name'), 'config.agent')
    supplied_agent_info = outcome.get('agent_info')
    agent_info = _identity_fields(supplied_agent_info, ('name', 'version'), 'agent_info')
    if supplied_agent_info is not None and 'model_info' in supplied_agent_info:
        agent_info['model_info'] = _identity_fields(supplied_agent_info['model_info'], ('name', 'provider'),
                                                   'agent_info.model_info')
    verifier = outcome.get('verifier_result')
    rewards = verifier.get('rewards') if isinstance(verifier, dict) else None
    reward = rewards.get('reward') if isinstance(rewards, dict) else None
    if type(reward) not in (int, float) or reward not in (0, 1):
        raise ValueError('unscored/nonbinary outcome: retain it and declare its failure/scoring policy; do not silently drop trials')
    wall = None
    timing = outcome.get('agent_execution')
    if isinstance(timing, dict) and timing.get('started_at') and timing.get('finished_at'):
        start = datetime.fromisoformat(timing['started_at'].replace('Z', '+00:00'))
        finish = datetime.fromisoformat(timing['finished_at'].replace('Z', '+00:00'))
        if start.tzinfo is None or finish.tzinfo is None or finish < start:
            raise ValueError('invalid Harbor agent execution timing')
        wall = (finish - start).total_seconds()
    metrics = analyze_pi_trace(raw, prices)
    metrics['trace_timestamp_span_seconds'] = metrics['wall_seconds']
    metrics['wall_seconds'] = wall
    metrics['availability']['wall_seconds'] = {'status': 'observed' if wall is not None else 'unknown',
                                              'source': 'Harbor agent_execution timing'}
    metrics.update({key: metadata[key] for key in ('task_id', 'attempt', 'harness_commit', 'split')})
    if 'run_id' in metadata:
        metrics['run_id'] = metadata['run_id']
    metrics.update(configuration_id=configuration_id, passed=reward == 1, result_sha256=hashlib.sha256(result_bytes).hexdigest(),
                   task_checksum=result_identity.get('task_checksum'), trial_id=trial_id,
                   trial_name=result_identity.get('trial_name'), declared_agent=declared_agent, agent_info=agent_info,
                   trace_result_association={'status': 'caller_supplied', 'task_name_match': True,
                                             'trial_binding_verified': False})
    metrics['warnings'] = sorted(set(metrics['warnings'] + [
        'trace/result association is caller-supplied; matching task names do not verify trial binding']))
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--configuration-id', required=True)
    parser.add_argument('--prices', type=Path, default=Path('evals/pricing.json'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = normalize_attempt(args.directory, args.result, args.configuration_id, args.prices)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n', encoding='utf8')
    print(f'Wrote normalized metrics to {args.output}; raw trajectory content was not printed.')


if __name__ == '__main__':
    main()
