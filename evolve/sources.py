"""Offline, evaluator-owned corpus export. Raw held-out trajectories are never opened."""
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
import time

from evals.analysis.metrics import summarize_runs
from evals.harbor.datasets import load_dataset_manifest

RUNTIME_DIRS = ('bin', 'lib', 'extensions', 'prompts', 'skills', 'templates')
RUNTIME_FILES = ('package.json', 'package-lock.json')
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TRACE_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_FILES = 20000
MAX_COMMITS = 10000
_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,179}')
_SHA = re.compile(r'[0-9a-f]{40}')
_HASH = re.compile(r'[0-9a-f]{64}')
_TOKEN_KEYS = {'input', 'output', 'cache_read', 'cache_write', 'thinking_tokens', 'total'}
_RAW_KEYS = {'type', 'message', 'messages', 'content', 'trajectory', 'events', 'raw',
             'verifier_result', 'rewards', 'config', 'agent_execution'}


def _identifier(value):
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise ValueError('invalid corpus identity')
    _relative(value)
    return value


def _relative(value):
    if (not isinstance(value, str) or not value or '\\' in value or ':' in value
            or any(char in value for char in '<>"|?*')
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ValueError('unsafe relative path')
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in {'.', '..'} for part in path.parts):
        raise ValueError('unsafe relative path')
    for part in path.parts:
        stem = part.split('.')[0].casefold()
        if (part.endswith((' ', '.')) or part.casefold() in {'.git', '.gitattributes', '.gitmodules'}
                or stem in {'con', 'prn', 'aux', 'nul'}
                or re.fullmatch(r'(com|lpt)[0-9]', stem)):
            raise ValueError('unsafe relative path')
    return path


def _safe_path(value, *, missing=False):
    """Check every ancestor with lstat, including Windows junction/reparse points."""
    path = Path(os.path.abspath(os.fspath(value)))
    for current in (*reversed(path.parents), path):
        try:
            info = current.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise ValueError('required corpus path is missing') from None
        except OSError:
            raise ValueError('corpus path is inaccessible') from None
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('symlink/reparse paths are prohibited')
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise ValueError('only regular files and directories are supported')
    return path


def _read_bytes(path, limit=MAX_FILE_BYTES):
    path = _safe_path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise ValueError('unsupported or oversized corpus file')
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise ValueError('corpus file is inaccessible') from None
    with os.fdopen(descriptor, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('corpus file changed while opening')
        data = stream.read(limit + 1)
    after = _safe_path(path).lstat()
    if (len(data) > limit or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)):
        raise ValueError('corpus file changed or exceeded its bound')
    return data


def _loads(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON keys')
            result[key] = value
        return result

    def constant(_):
        raise ValueError('nonfinite JSON number')

    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError('invalid corpus JSON') from None


def _write_json(path, value):
    data = (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode('utf8')
    with Path(path).open('xb') as stream:
        stream.write(data)


def _new_directory(path):
    directory = _safe_path(path, missing=True)
    directory.mkdir(parents=True, exist_ok=False)
    return directory


def _export_directory(path, owned_paths):
    directory = _safe_path(path, missing=True)
    if directory.exists() and not directory.is_dir():
        raise ValueError('corpus destination must be a directory')
    if any(os.path.lexists(directory / name) for name in owned_paths):
        raise ValueError('corpus export output already exists')
    if directory.exists():
        _walk_files(directory)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _git(directory, *arguments, limit=64 * 1024 * 1024, input_data=None):
    environment = {key: value for key, value in os.environ.items()
                   if not key.upper().startswith('GIT_')}
    environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_TERMINAL_PROMPT='0', GIT_NO_REPLACE_OBJECTS='1',
                       GIT_NO_LAZY_FETCH='1', GIT_OPTIONAL_LOCKS='0')
    command = ['git', '--no-optional-locks', '-c', 'core.hooksPath=' + os.devnull,
               '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false',
               '-c', 'core.attributesFile=' + os.devnull, '-c', 'protocol.allow=never',
               '-c', 'protocol.file.allow=always', '-C', str(directory), *arguments]
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err, tempfile.TemporaryFile() as supplied:
        if input_data is not None:
            if len(input_data) > MAX_FILE_BYTES:
                raise ValueError('Git input exceeds its bound')
            supplied.write(input_data)
            supplied.seek(0)
        try:
            process = subprocess.Popen(command, stdin=supplied, stdout=out, stderr=err, env=environment)
        except OSError:
            raise ValueError('bounded offline Git operation failed') from None
        deadline = time.monotonic() + 60
        while process.poll() is None:
            if (time.monotonic() >= deadline or os.fstat(out.fileno()).st_size > limit
                    or os.fstat(err.fileno()).st_size > 1024 * 1024):
                process.kill()
                process.wait()
                raise ValueError('bounded offline Git operation failed')
            time.sleep(0.01)
        if process.returncode or os.fstat(out.fileno()).st_size > limit or os.fstat(err.fileno()).st_size > 1024 * 1024:
            raise ValueError('bounded offline Git operation failed')
        out.seek(0)
        return out.read(limit + 1)


def _runtime_path(path, *, packages=True):
    if not isinstance(path, str):
        raise ValueError('unsafe runtime path')
    selected = (packages and path in RUNTIME_FILES) or path.split('/')[0] in RUNTIME_DIRS
    if not selected:
        return False
    _relative(path)
    return True


def _walk_files(directory):
    directory = _safe_path(directory)
    if not directory.is_dir():
        raise ValueError('corpus root must be a directory')
    files = []
    for root, dirs, names in os.walk(directory, followlinks=False):
        for name in dirs:
            _safe_path(Path(root) / name)
        for name in names:
            path = _safe_path(Path(root) / name)
            if not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError('corpus contains a nonregular file')
            files.append(path)
            if len(files) > MAX_FILES:
                raise ValueError('corpus file count exceeds its bound')
    return files


def export_history(history_path, destination, commits=None):
    """Export all reachable versions, plus explicitly retained full-SHA commits."""
    source = _safe_path(history_path)
    extra = list(commits or ())
    if len(extra) > MAX_COMMITS or any(not isinstance(sha, str) or not _SHA.fullmatch(sha) for sha in extra):
        raise ValueError('history references must be full lowercase Git SHAs')
    target = _safe_path(destination, missing=True)
    if target == source or source in target.parents:
        raise ValueError('history export must be outside its source')
    with tempfile.TemporaryDirectory(prefix='apex-history-') as temporary:
        if source.is_file():
            if source.suffix != '.bundle' or source.stat().st_size > MAX_TOTAL_BYTES:
                raise ValueError('history requires a bounded local Git bundle')
            repository = Path(temporary) / 'history.git'
            _git(temporary, 'clone', '--bare', '--no-local', '--', str(source), str(repository))
        else:
            repository = source
            git_dir = source / '.git' if os.path.lexists(source / '.git') else source
            if not _safe_path(git_dir).is_dir():
                raise ValueError('history requires a regular Git metadata directory')
            _walk_files(git_dir)
            if (git_dir / 'objects' / 'info' / 'alternates').exists():
                raise ValueError('external Git object stores are prohibited')
            reported = _git(repository, 'rev-parse', '--absolute-git-dir', limit=8192).decode('utf8').strip()
            if Path(reported) != git_dir:
                raise ValueError('history Git metadata is outside its repository')
        order = _git(repository, 'rev-list', '--reverse', '--topo-order', '--all', *extra).decode('ascii').splitlines()
        if not order or len(order) > MAX_COMMITS or any(not _SHA.fullmatch(sha) for sha in order):
            raise ValueError('invalid or oversized runtime history')
        snapshots = []
        count = total = 0
        for sha in order:
            entries = _git(repository, 'ls-tree', '-r', '-z', sha).split(b'\0')
            snapshot = []
            for entry in entries:
                if not entry:
                    continue
                try:
                    attributes, raw_path = entry.split(b'\t', 1)
                    mode, kind, object_id = attributes.decode('ascii').split(' ')
                    path = raw_path.decode('utf8')
                except (ValueError, UnicodeError):
                    raise ValueError('unsupported history tree entry') from None
                if not _runtime_path(path):
                    continue
                if mode not in {'100644', '100755'} or kind != 'blob' or not _SHA.fullmatch(object_id):
                    raise ValueError('runtime history contains a symlink/gitlink or unsupported file')
                size = int(_git(repository, 'cat-file', '-s', object_id, limit=128))
                if size > MAX_FILE_BYTES:
                    raise ValueError('runtime history file exceeds its bound')
                count += 1
                total += size
                if count > MAX_FILES or total > MAX_TOTAL_BYTES:
                    raise ValueError('runtime history exceeds its bound')
                snapshot.append((path, object_id, mode))
            snapshots.append((sha, snapshot))
        directory = _export_directory(target, ('versions', 'history.json'))
        (directory / 'versions').mkdir()
        for sha, snapshot in snapshots:
            version = directory / 'versions' / sha
            version.mkdir(parents=True)
            for path, object_id, mode in snapshot:
                output = version / path
                output.parent.mkdir(parents=True, exist_ok=True)
                with output.open('xb') as stream:
                    stream.write(_git(repository, 'cat-file', 'blob', object_id, limit=MAX_FILE_BYTES))
                output.chmod(0o755 if mode == '100755' else 0o644)
        result = {'schema_version': 1, 'commits': order, 'files': count}
        _write_json(directory / 'history.json', result)
        return result


def _number(value):
    try:
        valid = value is None or type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError('normalized metrics contain invalid numbers')
    return value


def _record(record, allowed_dev_tasks, allowed_commits):
    if (not isinstance(record, dict) or type(record.get('schema_version')) is not int
            or record['schema_version'] != 1 or _RAW_KEYS.intersection(record)
            or record.get('trace_format') not in {'session', 'json_events', 'mixed', 'unknown'}
            or type(record.get('passed')) is not bool):
        raise ValueError('verified normalized metric records are required')
    run, task = _identifier(record.get('run_id')), _identifier(record.get('task_id'))
    attempt, commit, split = record.get('attempt'), record.get('harness_commit'), record.get('split')
    configuration = record.get('configuration_id')
    if (not isinstance(configuration, str) or not configuration.strip() or len(configuration) > 256
            or any(ord(char) < 32 or ord(char) == 127 for char in configuration)):
        raise ValueError('normalized configuration identity is invalid')
    if (type(attempt) is not int or attempt < 1 or not isinstance(commit, str)
            or not _SHA.fullmatch(commit) or commit not in allowed_commits
            or split not in {'dev', 'heldout', 'full', 'micro'}
            or split == 'dev' and task not in allowed_dev_tasks
            or split == 'heldout' and task in allowed_dev_tasks):
        raise ValueError('normalized record identity is not allowlisted')
    association = record.get('trace_result_association')
    if (not isinstance(association, dict) or association.get('task_name_match') is not True
            or not (association.get('status') == 'caller_supplied' and association.get('trial_binding_verified') is False
                    or association.get('status') == 'verified' and association.get('trial_binding_verified') is True)):
        raise ValueError('normalized record association provenance is unsupported')
    result_hash = record.get('result_sha256')
    if not isinstance(result_hash, str) or not _HASH.fullmatch(result_hash):
        raise ValueError('normalized record requires a result identity')
    tokens = record.get('tokens')
    cost = record.get('cost')
    if (not isinstance(tokens, dict) or set(tokens) != _TOKEN_KEYS
            or not isinstance(cost, dict) or type(cost.get('complete')) is not bool
            or type(record.get('usage_complete')) is not bool):
        raise ValueError('normalized metric shape is invalid')
    safe_tokens = {}
    for key, value in tokens.items():
        safe_tokens[key] = _number(value)
        if value is not None and type(value) is not int:
            raise ValueError('normalized token counts must be integers')
    components = [safe_tokens[key] for key in ('input', 'output', 'cache_read', 'cache_write')]
    if (record['usage_complete'] and any(value is None for value in (*components, safe_tokens['total']))
            or all(value is not None for value in (*components, safe_tokens['total']))
            and sum(components) != safe_tokens['total']
            or cost['complete'] and (not record['usage_complete'] or cost.get('registry_usd') is None)):
        raise ValueError('normalized metric completeness/totals are inconsistent')
    models = record.get('models')
    if not isinstance(models, list) or len(models) > 100:
        raise ValueError('normalized model identities are invalid')
    safe_models = []
    for model in models:
        if (not isinstance(model, dict)
                or any(not isinstance(model.get(key), str)
                       or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.+/@-]{0,255}', model[key])
                       for key in ('provider', 'requested_model', 'model'))):
            raise ValueError('normalized model identities are invalid')
        safe_models.append({key: model[key] for key in ('provider', 'requested_model', 'model')})
    safe = {'schema_version': 1, 'run_id': run, 'task_id': task, 'attempt': attempt,
            'harness_commit': commit, 'split': split, 'configuration_id': configuration,
            'passed': record['passed'], 'result_sha256': result_hash,
            'tokens': safe_tokens, 'usage_complete': record['usage_complete'], 'models': safe_models,
            'cost': {'registry_usd': _number(cost.get('registry_usd')), 'complete': cost['complete']},
            'wall_seconds': _number(record.get('wall_seconds')),
            'trace_result_association': {key: association[key] for key in
                                         ('status', 'task_name_match', 'trial_binding_verified')}}
    if record.get('trial_id') is not None:
        safe['trial_id'] = record['trial_id']
    return safe


def _metadata(directory):
    value = _loads(_read_bytes(Path(directory) / 'metadata.json', 64 * 1024))
    if (not isinstance(value, dict) or type(value.get('schema_version')) is not int
            or value['schema_version'] != 1 or type(value.get('attempt')) is not int
            or value['attempt'] < 1 or value.get('split') not in {'dev', 'heldout', 'full', 'micro'}
            or not isinstance(value.get('harness_commit'), str) or not _SHA.fullmatch(value['harness_commit'])
            or not isinstance(value.get('sha256'), str) or not _HASH.fullmatch(value['sha256'])
            or type(value.get('bytes')) is not int or not 0 < value['bytes'] <= MAX_TRACE_BYTES):
        raise ValueError('invalid raw trace metadata')
    _identifier(value.get('run_id'))
    _identifier(value.get('task_id'))
    return {key: value[key] for key in ('schema_version', 'run_id', 'task_id', 'attempt',
                                       'harness_commit', 'split', 'sha256', 'bytes')}


def _dev_bytes(directory, metadata):
    if metadata['split'] != 'dev':
        raise ValueError('only development raw traces may be opened')
    data = _read_bytes(Path(directory) / 'trace.jsonl', MAX_TRACE_BYTES)
    if len(data) != metadata['bytes'] or hashlib.sha256(data).hexdigest() != metadata['sha256']:
        raise ValueError('development trace hash/size mismatch')
    return data


def export_feedback(trace_root, records, destination, allowed_dev_tasks, allowed_commits):
    """Retain exact dev bytes, with only allowlisted metrics and aggregate scores."""
    root = _safe_path(trace_root)
    tasks, commits = set(allowed_dev_tasks), set(allowed_commits)
    if (not tasks or not commits or any(_identifier(task) != task for task in tasks)
            or any(not isinstance(sha, str) or not _SHA.fullmatch(sha) for sha in commits)):
        raise ValueError('explicit dev-task and commit allowlists are required')
    normalized = [_record(record, tasks, commits) for record in records]
    if len(normalized) > MAX_FILES:
        raise ValueError('feedback attempt count exceeds its bound')
    # Validate identities across configurations/splits before opening any trajectory.
    identities = set()
    groups = {}
    from evals.analysis.metrics import _record_identities
    for record in normalized:
        for identity in _record_identities(record):
            if identity in identities:
                raise ValueError('duplicate feedback record identity')
            identities.add(identity)
        groups.setdefault((record['configuration_id'], record['split']), []).append(record)
    summaries = []
    for (configuration, split), group in sorted(groups.items()):
        if split not in {'dev', 'heldout'}:
            continue  # Full/micro records are validated but are not proposer feedback.
        summary = summarize_runs(group)
        summary.pop('warnings', None)
        label = ({'configuration_id': configuration} if split == 'dev' else
                 {'configuration_sha256': hashlib.sha256(configuration.encode('utf8')).hexdigest()})
        summaries.append({**label, 'split': split, 'summary': summary})
    dev = [record for record in normalized if record['split'] == 'dev']
    if not dev:
        raise ValueError('at least one prior development attempt is required')
    raw = []
    total = 0
    for record in dev:
        directory = root / record['run_id'] / record['task_id'] / f"attempt-{record['attempt']}"
        metadata = _metadata(directory)
        if any(metadata[key] != record[key] for key in ('run_id', 'task_id', 'attempt', 'harness_commit', 'split')):
            raise ValueError('development trace identity mismatch')
        data = _dev_bytes(directory, metadata)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ValueError('development feedback exceeds its bound')
        raw.append((record, metadata, data))
    target = _safe_path(destination, missing=True)
    if target == root or root in target.parents:
        raise ValueError('feedback destination must be outside its source')
    output = _export_directory(target, ('traces', 'dev-records.json', 'scores.json'))
    (output / 'traces').mkdir()
    for record, metadata, data in raw:
        directory = output / 'traces' / record['run_id'] / record['task_id'] / f"attempt-{record['attempt']}"
        directory.mkdir(parents=True)
        with (directory / 'trace.jsonl').open('xb') as stream:
            stream.write(data)
        _write_json(directory / 'metadata.json', metadata)
    _write_json(output / 'dev-records.json', dev)
    _write_json(output / 'scores.json', summaries)
    return {'schema_version': 1, 'dev_attempts': len(dev),
            'dev_scores': [summary for summary in summaries if summary['split'] == 'dev']}


def _trace_directories(root):
    root = _safe_path(root)
    visited = 0
    for run in root.iterdir():
        _safe_path(run)
        visited += 1
        if visited > MAX_FILES:
            raise ValueError('trace store exceeds its discovery bound')
        if not run.is_dir():
            continue
        for task in run.iterdir():
            _safe_path(task)
            visited += 1
            if visited > MAX_FILES:
                raise ValueError('trace store exceeds its discovery bound')
            if not task.is_dir():
                continue
            for attempt in task.iterdir():
                _safe_path(attempt)
                visited += 1
                if visited > MAX_FILES:
                    raise ValueError('trace store exceeds its discovery bound')
                if not attempt.is_dir() or not re.fullmatch(r'attempt-[1-9][0-9]*', attempt.name):
                    continue
                if not os.path.lexists(attempt / 'metadata.json'):
                    continue  # Native/unregistered artifacts are not scored attempts.
                _identifier(run.name)
                _identifier(task.name)
                metadata = _metadata(attempt)
                if (metadata['run_id'] != run.name or metadata['task_id'] != task.name
                        or f"attempt-{metadata['attempt']}" != attempt.name):
                    raise ValueError('trace directory identity mismatch')
                yield attempt, metadata


def build_rules(manifest_path, trace_root, expected_outputs=()):
    """Lexical guard terms; trusted output literals must be supplied, not inferred."""
    manifest_path = _safe_path(manifest_path)
    _safe_path(manifest_path.parent / 'registry.json')
    manifest = _loads(_read_bytes(manifest_path))
    if not isinstance(manifest, dict) or not isinstance(manifest.get('dataset'), str):
        raise ValueError('invalid frozen dataset manifest')
    selection = load_dataset_manifest(manifest_path, dataset=manifest['dataset'], split='full')
    registry = _loads(_read_bytes(selection['registry_path']))
    terms = {'terminal-bench', 'terminal_bench', 'terminalbench', 'task_checksum',
             'verifier', 'verifier_result', 'reward.txt', '/tests/', 'tests/test.sh',
             'registry.json', 'dataset_manifest', 'registry_path', manifest['dataset']}
    terms.update(task['name'] for task in registry[0]['tasks'])
    terms.update(task['path'] for task in registry[0]['tasks'])
    terms.add(manifest['dataset'].split('@')[0])
    if isinstance(expected_outputs, (str, bytes)):
        raise ValueError('expected outputs must be a sequence of text literals')
    supplied = list(expected_outputs)
    if len(supplied) > MAX_FILES or any(not isinstance(value, str) or not value or len(value.encode('utf8')) > MAX_FILE_BYTES for value in supplied):
        raise ValueError('expected outputs must be bounded nonempty text literals')
    terms.update(supplied)
    absolute = re.compile(r"(?<![\w:/\\])(?:[A-Za-z]:[\\/]|/)[^\s\"'`<>\[\]{}(),;|]+")
    quoted_absolute = re.compile(r'''(["'])((?:[A-Za-z]:[\\/]|/)[^\r\n]*?)\1''')
    dev_count = 0
    total = 0

    def strings(value, depth=0):
        if depth > 100:
            raise ValueError('development trace nesting exceeds its bound')
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for child in value.values():
                yield from strings(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                yield from strings(child, depth + 1)

    for directory, metadata in _trace_directories(trace_root):
        if metadata['split'] != 'dev':
            continue  # Deliberately do not stat/open non-dev trace.jsonl.
        if metadata['task_id'] not in manifest['splits']['dev']:
            raise ValueError('dev trace task is outside frozen development membership')
        data = _dev_bytes(directory, metadata)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ValueError('development rule inputs exceed their bound')
        dev_count += 1
        try:
            lines = data.decode('utf8').split('\n')
        except UnicodeError:
            raise ValueError('development trace is not UTF-8') from None
        for line in lines:
            if not line.strip():
                continue
            for value in strings(_loads(line)):
                if re.match(r'^(?:[A-Za-z]:[\\/]|/)', value) and '\n' not in value and '\r' not in value:
                    terms.add(value)
                terms.update(match[2] for match in quoted_absolute.finditer(value))
                for match in absolute.finditer(value):
                    term = match.group().rstrip('.:!?')
                    if len(term) > 1:
                        terms.add(term)
        if (len(terms) > MAX_FILES or any(len(term.encode('utf8')) > MAX_FILE_BYTES for term in terms)
                or sum(len(term.encode('utf8')) for term in terms) > MAX_FILE_BYTES):
            raise ValueError('integrity rules exceed their count/text bound')
    if not dev_count:
        raise ValueError('integrity rules require development raw feedback')
    return {'schema_version': 1, 'terms': sorted(terms), 'manifest_sha256': selection['manifest_sha256'],
            'dev_attempts': dev_count, 'expected_output_literals': len(supplied),
            'coverage': 'lexical dataset identifiers, dev-observed absolute paths, supplied output literals'}
