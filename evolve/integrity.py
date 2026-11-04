"""Validate one textual proposal, then commit it in an isolated runtime-only repo."""
import hashlib
import os
import re
import shutil
import stat
import tempfile
import unicodedata

from .sources import (MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, RUNTIME_DIRS,
                      RUNTIME_FILES, _git, _new_directory, _read_bytes, _relative,
                      _runtime_path, _safe_path, _walk_files)

MAX_PATCH_BYTES = 1024 * 1024
_HUNK = re.compile(r'@@ -(0|[1-9][0-9]*)(?:,(0|[1-9][0-9]*))? \+(0|[1-9][0-9]*)(?:,(0|[1-9][0-9]*))? @@(?: [^\n]*)?\n')
_INDEX = re.compile(r'index [0-9a-f]{7,40}\.\.[0-9a-f]{7,40}(?: 100(?:644|755))?\n')


def _fold(text):
    return re.sub(r'[\\/]+', '/', unicodedata.normalize('NFKC', text).casefold())


def _guard(text, terms):
    folded = _fold(text)
    if any(term in folded for term in terms):
        raise ValueError('proposal references protected evaluation material')


def _lines(data):
    parts = data.split(b'\n')
    return [part + b'\n' for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def _parse_patch(patch, terms):
    lines = patch.splitlines(keepends=True)
    blocks = []
    index = 0
    seen = set()
    while index < len(lines):
        header = lines[index]
        match = re.fullmatch(r'diff --git a/(.+) b/(.+)\n', header)
        if not match or match[1] != match[2]:
            raise ValueError('only standard same-path text Git patches are supported')
        path = match[1]
        _relative(path)
        if '/' not in path or not _runtime_path(path, packages=False) or path in seen:
            raise ValueError('proposal target is outside the mutable runtime or repeated')
        seen.add(path)
        _guard(path, terms)
        index += 1
        operation = 'modify'
        mode_hint = None
        object_ids = None
        if index < len(lines) and lines[index] in {'new file mode 100644\n', 'deleted file mode 100644\n', 'deleted file mode 100755\n'}:
            operation = 'add' if lines[index].startswith('new') else 'delete'
            mode_hint = lines[index].split()[-1]
            index += 1
        if index < len(lines) and _INDEX.fullmatch(lines[index]):
            fields = lines[index].split()
            old_id, new_id = fields[1].split('..')
            object_ids = (old_id, new_id)
            if ((set(old_id) == {'0'}) != (operation == 'add')
                    or (set(new_id) == {'0'}) != (operation == 'delete')):
                raise ValueError('patch index contradicts its file operation')
            if len(fields) == 3:
                if mode_hint is not None and mode_hint != fields[-1]:
                    raise ValueError('patch file modes are inconsistent')
                mode_hint = fields[-1]
            index += 1
        if index == len(lines) or lines[index].startswith('diff --git '):
            empty_blob = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
            declared_blob = object_ids[1 if operation == 'add' else 0] if object_ids else ''
            if (operation == 'modify' or not declared_blob
                    or declared_blob != empty_blob[:len(declared_blob)]):
                raise ValueError('nontextual/mode-only changes are prohibited')
            blocks.append((path, operation, mode_hint, []))
            if len(blocks) > MAX_FILES:
                raise ValueError('proposal target count exceeds its bound')
            continue
        expected_old = '--- /dev/null\n' if operation == 'add' else f'--- a/{path}\n'
        expected_new = '+++ /dev/null\n' if operation == 'delete' else f'+++ b/{path}\n'
        if index + 1 >= len(lines) or lines[index:index + 2] != [expected_old, expected_new]:
            raise ValueError('unsupported patch headers, modes, binary, rename or copy')
        index += 2
        hunks = []
        changed = []
        while index < len(lines) and not lines[index].startswith('diff --git '):
            match = _HUNK.fullmatch(lines[index])
            if not match:
                raise ValueError('unsupported or malformed text patch hunk')
            old_start, old_count, new_start, new_count = (int(match[1]), int(match[2] or '1'),
                                                        int(match[3]), int(match[4] or '1'))
            if (max(old_start, old_count, new_start, new_count) > MAX_FILE_BYTES
                    or old_count and not old_start or new_count and not new_start):
                raise ValueError('patch hunk coordinates exceed supported bounds')
            index += 1
            body = []
            while index < len(lines):
                line = lines[index]
                if line.startswith(('@@ ', 'diff --git ')):
                    break
                if line == '\\ No newline at end of file\n':
                    if not body or not body[-1][1].endswith(b'\n'):
                        raise ValueError('invalid no-newline patch marker')
                    prefix, content = body[-1]
                    body[-1] = (prefix, content[:-1])
                elif line and line[0] in ' +-':
                    prefix, content = line[0], line[1:].encode('utf8')
                    body.append((prefix, content))
                    if prefix in '+-':
                        changed.append(line[1:])
                else:
                    raise ValueError('unsupported text patch content')
                index += 1
            if (sum(prefix != '+' for prefix, _ in body) != old_count
                    or sum(prefix != '-' for prefix, _ in body) != new_count):
                raise ValueError('text patch hunk counts do not match its body')
            hunks.append((old_start, old_count, new_start, new_count, body))
        if not hunks or not changed:
            raise ValueError('proposal contains a no-op or nontextual file change')
        _guard(''.join(changed), terms)
        blocks.append((path, operation, mode_hint, hunks))
        if len(blocks) > MAX_FILES:
            raise ValueError('proposal target count exceeds its bound')
    if not blocks:
        raise ValueError('proposal is empty')
    return blocks


def _runtime_inventory(base):
    inventory = {}
    total = 0
    for name in (*RUNTIME_DIRS, *RUNTIME_FILES):
        source = base / name
        if not os.path.lexists(source):
            continue
        source = _safe_path(source)
        if name in RUNTIME_DIRS:
            if not source.is_dir():
                raise ValueError('runtime roots must be directories')
            paths = _walk_files(source)
        else:
            if not source.is_file():
                raise ValueError('runtime package inputs must be regular files')
            paths = [source]
        for path in paths:
            relative = path.relative_to(base).as_posix()
            _relative(relative)
            info = path.lstat()
            if info.st_size > MAX_FILE_BYTES:
                raise ValueError('base runtime file exceeds its bound')
            total += info.st_size
            inventory[relative] = info.st_mode
            if len(inventory) > MAX_FILES or total > MAX_TOTAL_BYTES:
                raise ValueError('base runtime exceeds its bound')
    if not inventory:
        raise ValueError('candidate requires a nonempty runtime base')
    return inventory


def _planned_files(base, inventory, blocks):
    planned = {}
    for path, operation, mode_hint, hunks in blocks:
        exists = path in inventory
        if operation == 'add' and exists or operation != 'add' and not exists:
            raise ValueError('patch operation disagrees with its base file')
        expected_mode = '100755' if exists and inventory[path] & stat.S_IXUSR else '100644'
        if mode_hint is not None and mode_hint != expected_mode:
            raise ValueError('patch attempts a file mode change')
        before = _read_bytes(base / path) if exists else b''
        try:
            before.decode('utf8')
        except UnicodeError:
            raise ValueError('binary or non-UTF-8 runtime patches are prohibited') from None
        if b'\0' in before:
            raise ValueError('binary runtime patches are prohibited')
        source = _lines(before)
        after = []
        cursor = 0
        for old_start, old_count, new_start, new_count, body in hunks:
            position = old_start - 1 if old_count else old_start
            if position < cursor or position + old_count > len(source):
                raise ValueError('patch hunks overlap or escape their base file')
            after.extend(source[cursor:position])
            if (new_start - 1 if new_count else new_start) != len(after):
                raise ValueError('patch new-file coordinates are inconsistent')
            old = [content for prefix, content in body if prefix != '+']
            if source[position:position + old_count] != old:
                raise ValueError('patch context does not exactly match its base file')
            after.extend(content for prefix, content in body if prefix != '-')
            cursor = position + old_count
        after.extend(source[cursor:])
        result = b''.join(after)
        if len(result) > MAX_FILE_BYTES:
            raise ValueError('candidate file exceeds its bound')
        if operation == 'delete':
            if result:
                raise ValueError('deleted-file patch retains content')
            planned[path] = None
        else:
            if result == before and operation != 'add':
                raise ValueError('proposal contains a no-op file change')
            planned[path] = result
    remaining = set(inventory)
    for path, data in planned.items():
        if data is None:
            remaining.remove(path)
        else:
            remaining.add(path)
    for root in RUNTIME_DIRS:
        prefix = root + '/'
        if any(path.startswith(prefix) for path in inventory) and not any(path.startswith(prefix) for path in remaining):
            raise ValueError('proposal deletes an entire runtime root')
    # Casefold collisions and parent/file collisions are unsafe on Windows too.
    folded = [_fold(path) for path in remaining]
    if len(set(folded)) != len(folded):
        raise ValueError('candidate paths collide after normalization')
    paths = set(folded)
    for path in folded:
        pieces = path.split('/')
        if any('/'.join(pieces[:index]) in paths for index in range(1, len(pieces))):
            raise ValueError('candidate file/directory paths collide')
    final_size = sum((len(planned[path]) if path in planned else (base / path).stat().st_size)
                     for path in remaining)
    if len(remaining) > MAX_FILES or final_size > MAX_TOTAL_BYTES:
        raise ValueError('candidate runtime exceeds its bound')
    return planned


# ponytail: literal guard; independent semantic review is needed for adversarial proposals.
def apply_proposal(base_directory, destination, proposal, rules):
    """Preflight bytes before allocation; Git applies/commits only in a private repo.

    A single rationale is required. Semantic unity and obfuscated benchmark knowledge
    cannot be proven by a lexical guard; no evaluator/verifier code is loaded here.
    """
    if (not isinstance(proposal, dict) or set(proposal) != {'schema_version', 'kind', 'change', 'patch'}
            or type(proposal.get('schema_version')) is not int or proposal['schema_version'] != 1
            or proposal.get('kind') not in {'prompt', 'tool', 'policy', 'code'}
            or not isinstance(proposal.get('change'), str) or not proposal['change'].strip()
            or len(proposal['change'].encode('utf8')) > 4096
            or any(ord(char) < 32 and char not in '\n\t' for char in proposal['change'])):
        raise ValueError('proposal must declare one bounded change and supported kind')
    patch = proposal.get('patch')
    if (not isinstance(patch, str) or not patch or len(patch.encode('utf8')) > MAX_PATCH_BYTES
            or not patch.endswith('\n') or '\r' in patch or '\0' in patch
            or any(ord(char) < 32 and char not in '\n\t' for char in patch)
            or any(char in patch for char in '\u0085\u2028\u2029')):
        raise ValueError('proposal requires a bounded LF-framed UTF-8 text Git patch')
    if (not isinstance(rules, dict) or not isinstance(rules.get('terms'), list)
            or not rules['terms'] or len(rules['terms']) > MAX_FILES
            or any(not isinstance(term, str) or not term or len(term.encode('utf8')) > MAX_FILE_BYTES
                   for term in rules['terms'])):
        raise ValueError('trusted bounded integrity rules are required')
    terms = [_fold(term) for term in rules['terms']]
    _guard(proposal['change'], terms)
    blocks = _parse_patch(patch, terms)
    base = _safe_path(base_directory)
    if not base.is_dir():
        raise ValueError('candidate base must be a directory')
    target = _safe_path(destination, missing=True)
    if target == base or base in target.parents or target in base.parents:
        raise ValueError('candidate must be separate from its base checkout')
    if os.path.lexists(target):
        raise ValueError('candidate destination must be exclusive')
    inventory = _runtime_inventory(base)
    planned = _planned_files(base, inventory, blocks)
    candidate = _new_directory(target)
    try:
        for path, mode in inventory.items():
            output = candidate / path
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open('xb') as stream:
                stream.write(_read_bytes(base / path))
            output.chmod(0o755 if mode & stat.S_IXUSR else 0o644)
        # Empty template prevents installed init templates from adding hooks/config.
        with tempfile.TemporaryDirectory(prefix='apex-git-template-') as template:
            _git(candidate, 'init', '--template=' + template)
        identity = ('-c', 'user.name=Apex Evolution', '-c', 'user.email=evolution@localhost',
                    '-c', 'commit.gpgSign=false', '-c', 'core.filemode=true')
        _git(candidate, *identity, 'add', '--force', '--all', '--', '.')
        _git(candidate, *identity, 'commit', '--no-verify', '-m', 'Evolution runtime base')
        # Check and apply the same already-modeled patch through Git's text parser.
        encoded = patch.encode('utf8')
        _git(candidate, 'apply', '--check', '--whitespace=nowarn', '-', input_data=encoded)
        _git(candidate, 'apply', '--whitespace=nowarn', '-', input_data=encoded)
        for path, expected in planned.items():
            output = candidate / path
            if expected is None:
                if os.path.lexists(output):
                    raise ValueError('Git patch output does not match validated deletion')
            elif _read_bytes(output) != expected:
                raise ValueError('Git patch output does not match validated bytes')
        _walk_files(candidate)
        _git(candidate, *identity, 'add', '--force', '--all', '--', '.')
        changed = _git(candidate, 'diff', '--cached', '--name-only', '-z').split(b'\0')
        changed_paths = sorted(path.decode('utf8') for path in changed if path)
        if changed_paths != sorted(planned):
            raise ValueError('candidate includes unexpected changes or is a no-op')
        _git(candidate, *identity, 'commit', '--no-verify', '-m', 'Evolution candidate: ' + proposal['kind'])
        commit = _git(candidate, 'rev-parse', 'HEAD', limit=128).decode('ascii').strip()
        if not re.fullmatch(r'[0-9a-f]{40}', commit):
            raise ValueError('candidate commit is not a real Git identity')
        _walk_files(candidate)
        return {'schema_version': 1, 'harness_commit': commit,
                'patch_sha256': hashlib.sha256(encoded).hexdigest(), 'changed_paths': changed_paths,
                'kind': proposal['kind'], 'change': proposal['change'].strip()}
    except BaseException:
        # Only a directory created exclusively by this call is ever removed.
        shutil.rmtree(candidate)
        raise
