"""Evaluator-only raw trace storage and split protection; never imported by Apex runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import re


def _identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,179}', value):
        raise ValueError('run/task identifier must be a single safe path component')
    return value


def ingest_trace(root, run_id, task_id, attempt, source, harness_commit, split):
    _identifier(run_id)
    _identifier(task_id)
    if type(attempt) is not int or attempt < 1:
        raise ValueError('attempt must be a positive integer')
    if not isinstance(harness_commit, str) or not re.fullmatch(r'[0-9a-f]{40}', harness_commit):
        raise ValueError('harness commit must be a full 40-character git SHA')
    if split not in {'dev', 'heldout', 'full', 'micro'}:
        raise ValueError('unknown split')
    data = Path(source).read_bytes()
    if not data:
        raise ValueError('raw trace is empty')
    # Do not parse during ingestion: interrupted trajectories are evidence too.
    directory = Path(root) / run_id / task_id / f'attempt-{attempt}'
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'trace.jsonl').write_bytes(data)
    (directory / 'metadata.json').write_text(json.dumps({
        'schema_version': 1, 'run_id': run_id, 'task_id': task_id, 'attempt': attempt,
        'harness_commit': harness_commit, 'split': split,
        'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
    }, indent=2) + '\n', encoding='utf8')
    return directory


def load_dev_trace(directory):
    directory = Path(directory)
    metadata = json.loads((directory / 'metadata.json').read_text(encoding='utf8'))
    if metadata.get('split') != 'dev':
        raise PermissionError('failure analysis is dev-only; held-out/full traces are protected')
    data = (directory / 'trace.jsonl').read_bytes()
    if hashlib.sha256(data).hexdigest() != metadata.get('sha256'):
        raise ValueError('raw trace hash changed')
    # Pi JSONL uses LF framing; Unicode separators inside strings are data.
    return [json.loads(line) for line in data.decode('utf8').split('\n') if line.strip()]


def freeze_splits(task_ids, dev_size=18, heldout_size=20, seed=0):
    tasks = list(task_ids)
    if len(set(tasks)) != len(tasks):
        raise ValueError('task identifiers must be unique')
    for task in tasks:
        _identifier(task)
    for size in (dev_size, heldout_size):
        if type(size) is not int or size < 1:
            raise ValueError('split sizes must be positive integers')
    if len(tasks) < dev_size + heldout_size:
        raise ValueError('not enough task metadata for disjoint splits')
    tasks.sort()
    random.Random(seed).shuffle(tasks)
    return {'schema_version': 1, 'seed': seed, 'status': 'prospective_dev_pending_discrimination',
            'heldout': sorted(tasks[:heldout_size]),
            'dev': sorted(tasks[heldout_size:heldout_size + dev_size]),
            'remainder': sorted(tasks[heldout_size + dev_size:])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--root', type=Path, default=Path('runs'))
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--task-id', required=True)
    parser.add_argument('--attempt', type=int, required=True)
    parser.add_argument('--harness-commit', required=True)
    parser.add_argument('--split', choices=['dev', 'heldout', 'full', 'micro'], required=True)
    args = parser.parse_args()
    print(ingest_trace(args.root, args.run_id, args.task_id, args.attempt, args.source, args.harness_commit, args.split))


if __name__ == '__main__':
    main()
