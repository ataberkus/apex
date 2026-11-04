"""Freeze and validate local registry metadata without fetching benchmark contents."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from urllib.parse import urlsplit

from evals.analysis.trace_store import freeze_splits


DEFAULT_DATASET = 'terminal-bench@2.0'
_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,179}')
_COMMIT = re.compile(r'[0-9a-fA-F]{40}')
_HASH = re.compile(r'[0-9a-f]{64}')


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _dataset_parts(dataset):
    if not isinstance(dataset, str) or dataset.count('@') != 1:
        raise ValueError('dataset must be an explicit legacy name@version')
    name, version = dataset.split('@')
    if not _matches(_NAME, name) or not _matches(_NAME, version):
        raise ValueError('dataset must be an explicit legacy name@version')
    return name, version


def _validate_tasks(row):
    tasks = row.get('tasks')
    if not isinstance(row.get('description'), str) or not isinstance(tasks, list) or not tasks:
        raise ValueError('dataset requires a description and nonempty task metadata')
    if 'metrics' in row and row['metrics'] != []:
        raise ValueError('Phase 0 metadata snapshots support only absent or empty metrics')
    names = []
    for task in tasks:
        if not isinstance(task, dict) or not _matches(_NAME, task.get('name')):
            raise ValueError('task names must be safe path components')
        name, path = task['name'], task.get('path')
        if (not isinstance(path, str) or not path or '\\' in path or ':' in path
                or any(ord(char) < 32 or ord(char) == 127 for char in path)):
            raise ValueError('task paths must be normalized relative POSIX paths')
        posix = PurePosixPath(path)
        if (posix.is_absolute() or str(posix) != path or '..' in posix.parts
                or posix.name != name):
            raise ValueError('task paths must be normalized relative POSIX paths matching task names')
        url = task.get('git_url')
        if not isinstance(url, str) or any(char.isspace() or ord(char) < 32 for char in url):
            raise ValueError('tasks require HTTPS Git URLs without credentials')
        try:
            parsed = urlsplit(url)
            valid_url = (parsed.scheme == 'https' and parsed.hostname and parsed.path
                         and parsed.username is None and parsed.password is None
                         and not parsed.query and not parsed.fragment)
            parsed.port  # Reject malformed ports rather than retaining unusable URLs.
        except ValueError:
            valid_url = False
        if not valid_url:
            raise ValueError('tasks require HTTPS Git URLs without credentials')
        if not _matches(_COMMIT, task.get('git_commit_id')):
            raise ValueError('every task requires a full 40-hex Git commit ID')
        names.append(name)
    if len({name.lower() for name in names}) != len(names):
        raise ValueError('task names must be unique ignoring ASCII case')
    return sorted(names)


def _select_row(registry, dataset):
    name, version = _dataset_parts(dataset)
    if not isinstance(registry, list) or any(not isinstance(row, dict) for row in registry):
        raise ValueError('registry must be a JSON list of dataset metadata')
    rows = [row for row in registry if row.get('name') == name and row.get('version') == version]
    if len(rows) != 1:
        raise ValueError('registry must contain exactly one matching dataset')
    return rows[0], _validate_tasks(rows[0])


def _render(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode('utf8')


def freeze_dataset(source_registry, output_dir, dataset=DEFAULT_DATASET, *, source_commit,
                   seed=0, dev_size=18, heldout_size=20):
    """Write an exclusive registry snapshot and prospective split manifest; return its path."""
    if not _matches(_COMMIT, source_commit):
        raise ValueError('source_commit must be a full 40-hex Git SHA')
    if type(seed) is not int:
        raise ValueError('split seed must be an integer')
    source = Path(source_registry).read_bytes()
    row, names = _select_row(json.loads(source), dataset)
    splits = freeze_splits(names, dev_size=dev_size, heldout_size=heldout_size, seed=seed)
    splits['heldout_status'] = 'frozen'
    registry_bytes = _render([row])
    manifest_bytes = _render({
        'schema_version': 1, 'dataset': dataset, 'registry_path': 'registry.json',
        'registry_sha256': hashlib.sha256(registry_bytes).hexdigest(),
        'source_registry_sha256': hashlib.sha256(source).hexdigest(), 'source_commit': source_commit,
        'task_count': len(names), 'metadata_only': True, 'benchmark_contents_fetched': False,
        'image_digests_status': 'unresolved', 'splits': splits,
    })
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=False)
    with (directory / 'registry.json').open('xb') as stream:
        stream.write(registry_bytes)
    manifest_path = directory / 'manifest.json'
    with manifest_path.open('xb') as stream:
        stream.write(manifest_bytes)
    return manifest_path


def _validate_splits(splits, names):
    if (not isinstance(splits, dict) or type(splits.get('schema_version')) is not int
            or splits['schema_version'] != 1 or type(splits.get('seed')) is not int
            or splits.get('status') != 'prospective_dev_pending_discrimination'
            or splits.get('heldout_status') != 'frozen'):
        raise ValueError('invalid prospective/frozen split schema')
    all_names = []
    for key in ('dev', 'heldout', 'remainder'):
        selection = splits.get(key)
        if (not isinstance(selection, list) or (key != 'remainder' and not selection)
                or any(not _matches(_NAME, name) for name in selection)):
            raise ValueError('invalid or empty split selection')
        all_names.extend(selection)
    if len(all_names) != len(set(all_names)) or set(all_names) != set(names):
        raise ValueError('splits must be unique, disjoint and cover the complete dataset')
    expected = freeze_splits(names, dev_size=len(splits['dev']), heldout_size=len(splits['heldout']), seed=splits['seed'])
    if any(sorted(splits[key]) != expected[key] for key in ('dev', 'heldout', 'remainder')):
        raise ValueError('split membership does not match the recorded deterministic seed')


def load_dataset_manifest(path, dataset=DEFAULT_DATASET, split='dev'):
    """Validate retained metadata and return an exact evaluator-only task selection."""
    if split not in {'dev', 'heldout', 'full'}:
        raise ValueError('split must be dev, heldout or full')
    manifest_path = Path(path).resolve()
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if (not isinstance(manifest, dict) or type(manifest.get('schema_version')) is not int
            or manifest['schema_version'] != 1 or manifest.get('dataset') != dataset):
        raise ValueError('manifest schema or dataset does not match')
    if (manifest.get('metadata_only') is not True or manifest.get('benchmark_contents_fetched') is not False
            or manifest.get('image_digests_status') != 'unresolved'):
        raise ValueError('manifest must declare metadata-only evidence and unresolved image digests')
    if (not _matches(_COMMIT, manifest.get('source_commit'))
            or not _matches(_HASH, manifest.get('source_registry_sha256'))
            or not _matches(_HASH, manifest.get('registry_sha256'))):
        raise ValueError('manifest requires source provenance and snapshot hashes')
    if manifest.get('registry_path') != 'registry.json':
        raise ValueError('registry_path must be the local registry.json snapshot')
    registry_path = (manifest_path.parent / 'registry.json').resolve()
    if registry_path.parent != manifest_path.parent:
        raise ValueError('registry snapshot must remain beside its manifest')
    registry_bytes = registry_path.read_bytes()
    if hashlib.sha256(registry_bytes).hexdigest() != manifest['registry_sha256']:
        raise ValueError('registry snapshot hash changed')
    registry = json.loads(registry_bytes)
    _, names = _select_row(registry, dataset)
    if len(registry) != 1 or type(manifest.get('task_count')) is not int or manifest['task_count'] != len(names):
        raise ValueError('manifest task count or selected registry inventory does not match')
    _validate_splits(manifest.get('splits'), names)
    selected = names if split == 'full' else sorted(manifest['splits'][split])
    if not selected:
        raise ValueError('empty dataset selection')
    return {'dataset': dataset, 'split': split, 'task_names': selected, 'registry_path': str(registry_path),
            'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
            'registry_sha256': manifest['registry_sha256'], 'source_commit': manifest['source_commit'],
            'source_registry_sha256': manifest['source_registry_sha256'],
            'task_count': len(names), 'image_digests_status': manifest['image_digests_status']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    freeze = commands.add_parser('freeze', help='freeze local registry metadata without downloading tasks')
    freeze.add_argument('--source-registry', type=Path, required=True)
    freeze.add_argument('--output-dir', type=Path, required=True)
    freeze.add_argument('--source-commit', required=True)
    freeze.add_argument('--dataset', default=DEFAULT_DATASET)
    freeze.add_argument('--seed', type=int, default=0)
    freeze.add_argument('--dev-size', type=int, default=18)
    freeze.add_argument('--heldout-size', type=int, default=20)
    verify = commands.add_parser('verify', help='validate retained snapshot and split metadata')
    verify.add_argument('manifest', type=Path)
    verify.add_argument('--dataset', default=DEFAULT_DATASET)
    verify.add_argument('--split', choices=['dev', 'heldout', 'full'], default='dev')
    args = parser.parse_args()
    try:
        if args.command == 'freeze':
            path = freeze_dataset(args.source_registry, args.output_dir, args.dataset,
                                  source_commit=args.source_commit, seed=args.seed,
                                  dev_size=args.dev_size, heldout_size=args.heldout_size)
            result = load_dataset_manifest(path, args.dataset, 'full')
        else:
            result = load_dataset_manifest(args.manifest, args.dataset, args.split)
    except (OSError, ValueError) as exc:
        parser.exit(2, f'Metadata operation failed: {exc}\n')
    summary = {key: result[key] for key in ('dataset', 'split', 'manifest_sha256', 'registry_sha256',
                                          'source_commit', 'task_count', 'image_digests_status')}
    summary['selected_task_count'] = len(result['task_names'])
    summary['metadata_only'] = True
    summary['benchmark_contents_fetched'] = False
    print(json.dumps(summary, indent=2, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
