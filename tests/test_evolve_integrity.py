"""Real local Git/trace regressions; no model, registry, verifier or network calls."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from evals.analysis.normalize import normalize_attempt
from evals.analysis.trace_store import ingest_trace
from evals.harbor.datasets import freeze_dataset
from evolve.integrity import apply_proposal
from evolve.sources import build_rules, export_feedback, export_history

SHA = 'c' * 40


class EvolutionIntegrityTests(unittest.TestCase):
    def setUp(self):
        if shutil.which('git') is None:
            self.skipTest('real Git is required')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'base'
        self.base.mkdir()
        self.command(self.base, 'init', '--template=')
        self.write('lib/runtime.js', b'export const mode = "bounded";\n')
        self.write('lib/keep.js', b'export const kept = true;\n')
        self.write('prompts/system.md', b'Use available tools carefully.\n')
        self.write('package.json', b'{"name":"fixture","version":"1.0.0"}\n')
        self.write('evals/private.json', b'private evaluator data\n')
        self.command(self.base, 'add', '--all')
        self.command(self.base, 'commit', '-m', 'first')
        self.first = self.command(self.base, 'rev-parse', 'HEAD').decode().strip()

    def command(self, directory, *arguments, data=None):
        environment = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
        environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                           GIT_TERMINAL_PROMPT='0')
        return subprocess.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
                               '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false',
                               '-C', str(directory), *arguments], input=data, capture_output=True,
                              check=True, timeout=30, env=environment).stdout

    def write(self, path, data):
        output = self.base / path
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)

    def proposal(self, replacement=b'Use tools and verify the result.\n', path='prompts/system.md'):
        original = (self.base / path).read_bytes()
        self.write(path, replacement)
        diff = self.command(self.base, 'diff', '--no-ext-diff', '--', path).decode('utf8')
        self.write(path, original)
        return {'schema_version': 1, 'kind': 'prompt', 'change': 'Clarify tool discipline', 'patch': diff}

    def trace(self, task='dev-task', run='run-dev', split='dev', content='private dev answer', attempt=1):
        source = self.root / f'{run}-{task}-{attempt}.jsonl'
        row = {'type': 'message', 'id': 'a', 'message': {
            'role': 'assistant', 'provider': 'example', 'model': 'model', 'stopReason': 'stop',
            'content': [{'type': 'text', 'text': content}],
            'usage': {'input': 10, 'cacheRead': 0, 'cacheWrite': 0, 'output': 2, 'totalTokens': 12,
                      'cost': {'input': 0.01, 'cacheRead': 0, 'cacheWrite': 0, 'output': 0.02, 'total': 0.03}}}}
        # Non-ASCII separators inside JSON strings and CRLF are evidence, not framing rewrites.
        raw = (json.dumps(row, ensure_ascii=False) + '\r\n').encode('utf8')
        source.write_bytes(raw)
        directory = ingest_trace(self.root / 'runs', run, task, attempt, source, SHA, split)
        result = self.root / f'{run}-{task}-{attempt}-result.json'
        result.write_text(json.dumps({'task_name': task, 'verifier_result': {'rewards': {'reward': 1}},
                                      'agent_execution': {'started_at': '2026-10-01T00:00:00Z',
                                                          'finished_at': '2026-10-01T00:00:03Z'}}))
        record = normalize_attempt(directory, result, 'apex:core=verify,time')
        return directory, record, raw

    def frozen(self):
        registry = self.root / 'input-registry.json'
        registry.write_text(json.dumps([{'name': 'terminal-bench', 'version': '2.0', 'description': 'fixture',
                                        'tasks': [{'name': f'fixture-task-{i}', 'path': f'tasks/fixture-task-{i}',
                                                   'git_url': 'https://example.invalid/tasks.git', 'git_commit_id': SHA}
                                                  for i in range(4)]}]))
        manifest = freeze_dataset(registry, self.root / 'frozen', source_commit=SHA, dev_size=1, heldout_size=1)
        metadata = json.loads(manifest.read_text())
        return manifest, metadata

    def test_history_exports_every_reachable_version_and_extra_commit_without_checkout_mutation(self):
        self.write('lib/runtime.js', b'export const mode = "careful";\n')
        self.command(self.base, 'add', '--all')
        self.command(self.base, 'commit', '-m', 'second')
        second = self.command(self.base, 'rev-parse', 'HEAD').decode().strip()
        tree = self.command(self.base, 'rev-parse', 'HEAD^{tree}').decode().strip()
        extra = self.command(self.base, 'commit-tree', tree, '-p', self.first, data=b'explicit prior version\n').decode().strip()
        output = self.root / 'history'
        exported = export_history(self.base, output, commits=[extra])
        self.assertEqual(set(exported['commits']), {self.first, second, extra})
        self.assertLess(exported['commits'].index(self.first), exported['commits'].index(second))
        self.assertEqual((output / 'versions' / self.first / 'lib/runtime.js').read_bytes(), b'export const mode = "bounded";\n')
        self.assertEqual((output / 'versions' / second / 'lib/runtime.js').read_bytes(), b'export const mode = "careful";\n')
        self.assertFalse(any(path.name in {'.git', 'evals'} for path in output.rglob('*')))
        self.assertEqual(self.command(self.base, 'rev-parse', 'HEAD').decode().strip(), second)
        self.assertEqual(self.command(self.base, 'status', '--porcelain'), b'')

    def test_exporters_share_existing_corpus_root_but_refuse_overwriting_owned_outputs(self):
        corpus = self.root / 'shared-corpus'
        corpus.mkdir()
        export_history(self.base, corpus)
        historical = (corpus / 'versions' / self.first / 'lib/runtime.js').read_bytes()
        _, record, raw = self.trace()
        export_feedback(self.root / 'runs', [record], corpus, ['dev-task'], [SHA])
        self.assertEqual((corpus / 'versions' / self.first / 'lib/runtime.js').read_bytes(), historical)
        self.assertEqual((corpus / 'traces/run-dev/dev-task/attempt-1/trace.jsonl').read_bytes(), raw)
        with self.assertRaises(ValueError):
            export_history(self.base, corpus)
        with self.assertRaises(ValueError):
            export_feedback(self.root / 'runs', [record], corpus, ['dev-task'], [SHA])
        self.assertEqual((corpus / 'versions' / self.first / 'lib/runtime.js').read_bytes(), historical)
        self.assertEqual((corpus / 'traces/run-dev/dev-task/attempt-1/trace.jsonl').read_bytes(), raw)

    def test_bundle_exports_all_history_not_only_explicit_commit(self):
        self.write('lib/runtime.js', b'export const mode = "next";\n')
        self.command(self.base, 'add', '--all')
        self.command(self.base, 'commit', '-m', 'next')
        second = self.command(self.base, 'rev-parse', 'HEAD').decode().strip()
        bundle = self.root / 'history.bundle'
        self.command(self.base, 'bundle', 'create', str(bundle), '--all')
        before = bundle.read_bytes()
        exported = export_history(bundle, self.root / 'bundle-corpus', commits=[self.first])
        self.assertEqual(exported['commits'], [self.first, second])
        self.assertEqual(bundle.read_bytes(), before)

    def test_history_rejects_symlink_and_gitlink_runtime_entries_before_export(self):
        for mode, name in [('120000', 'lib/link'), ('160000', 'lib/vendor')]:
            with self.subTest(mode=mode):
                repository = self.root / f'unsafe-{mode}'
                repository.mkdir()
                self.command(repository, 'init', '--template=')
                (repository / 'lib').mkdir()
                (repository / 'lib' / 'safe.js').write_bytes(b'export const safe = true;\n')
                self.command(repository, 'add', '--all')
                self.command(repository, 'commit', '-m', 'safe base')
                if mode == '120000':
                    object_id = self.command(repository, 'hash-object', '-w', '--stdin', data=b'/outside/private\n').decode().strip()
                else:
                    object_id = self.command(repository, 'rev-parse', 'HEAD').decode().strip()
                self.command(repository, 'update-index', '--add', '--cacheinfo', f'{mode},{object_id},{name}')
                self.command(repository, 'commit', '-m', 'unsafe tree')
                destination = self.root / f'history-{mode}'
                with self.assertRaises(ValueError):
                    export_history(repository, destination)
                self.assertFalse(destination.exists())

    def test_feedback_preserves_bytes_and_never_opens_missing_or_poisoned_heldout_raw(self):
        dev_directory, dev, raw = self.trace(content='raw answer\u2028stays byte-identical')
        held_directory, held, _ = self.trace(task='heldout-secret-task', run='held-run', split='heldout', content='PRIVATE HELDOUT TEXT')
        dev['warnings'] = ['UNKNOWN PRIVATE WARNING']
        dev['unknown_private_field'] = {'text': 'PRIVATE UNKNOWN FIELD'}
        held['configuration_id'] = 'heldout-secret-task'
        protected = held_directory / 'trace.jsonl'
        original_open = os.open

        def checked_open(path, *args, **kwargs):
            if Path(path) == protected:
                raise AssertionError('heldout raw opened')
            return original_open(path, *args, **kwargs)

        for poison in (False, True):
            with self.subTest(poison=poison):
                if poison:
                    protected.write_bytes(b'not JSON; opening this is forbidden')
                else:
                    protected.unlink()
                output = self.root / f'feedback-{poison}'
                with patch('os.open', side_effect=checked_open):
                    result = export_feedback(self.root / 'runs', [dev, held], output, ['dev-task'], [SHA])
                self.assertEqual(result['dev_attempts'], 1)
                copied = output / 'traces' / 'run-dev' / 'dev-task' / 'attempt-1' / 'trace.jsonl'
                self.assertEqual(copied.read_bytes(), raw)
                self.assertEqual(copied.read_bytes(), (dev_directory / 'trace.jsonl').read_bytes())
                exported = '\n'.join(path.read_text() for path in output.rglob('*.json'))
                for forbidden in ('heldout-secret-task', 'held-run', 'PRIVATE HELDOUT TEXT',
                                  'UNKNOWN PRIVATE WARNING', 'PRIVATE UNKNOWN FIELD'):
                    self.assertNotIn(forbidden, exported)
                self.assertFalse((output / 'traces' / 'held-run').exists())
                score = json.loads((output / 'scores.json').read_text())
                held_score = next(row for row in score if row['split'] == 'heldout')
                self.assertEqual(held_score['summary']['pass_rate']['mean'], 1)
                self.assertEqual(held_score['summary']['tokens']['total']['total'], 12)

    def test_feedback_rejects_hash_mismatch_and_missing_prior_dev(self):
        directory, record, _ = self.trace()
        raw = directory / 'trace.jsonl'
        raw.write_bytes(b'changed bytes')
        with self.assertRaisesRegex(ValueError, 'hash/size'):
            export_feedback(self.root / 'runs', [record], self.root / 'bad-hash', ['dev-task'], [SHA])
        self.assertFalse((self.root / 'bad-hash').exists())
        raw.unlink()
        with self.assertRaises(ValueError):
            export_feedback(self.root / 'runs', [record], self.root / 'missing-dev', ['dev-task'], [SHA])
        self.assertFalse((self.root / 'missing-dev').exists())

    def test_feedback_validates_all_normalized_identities_before_opening_dev_raw(self):
        _, record, _ = self.trace()
        invalid = []
        for field, value in [('passed', 1), ('harness_commit', 'f' * 40), ('task_id', '../outside'),
                             ('attempt', True), ('run_id', '../escape'), ('result_sha256', 'invalid'),
                             ('schema_version', True), ('tokens', {'private-task-key': 1}),
                             ('trace_result_association', {'status': 'unverified', 'task_name_match': True,
                                                           'trial_binding_verified': False}),
                             ('message', {'content': 'raw shaped'})]:
            changed = copy.deepcopy(record)
            changed[field] = value
            invalid.append([changed])
        invalid.append([record, record])
        for index, records in enumerate(invalid):
            with self.subTest(index=index), patch('evolve.sources._dev_bytes', side_effect=AssertionError('raw opened before validation')):
                with self.assertRaises(ValueError):
                    export_feedback(self.root / 'runs', records, self.root / f'invalid-{index}', ['dev-task'], [SHA])
        self.assertFalse(any(self.root.glob('invalid-*')))

    def test_feedback_rejects_metadata_identity_mismatch_before_raw_open(self):
        directory, record, _ = self.trace()
        metadata = json.loads((directory / 'metadata.json').read_text())
        metadata['split'] = 'heldout'
        (directory / 'metadata.json').write_text(json.dumps(metadata))
        with patch('evolve.sources._dev_bytes', side_effect=AssertionError('protected trace opened')):
            with self.assertRaises(ValueError):
                export_feedback(self.root / 'runs', [record], self.root / 'mismatch', ['dev-task'], [SHA])

    def test_rules_ignore_readme_and_unregistered_native_traces_but_fail_corrupt_registered_metadata(self):
        manifest, frozen = self.frozen()
        directory, _, _ = self.trace(task=frozen['splits']['dev'][0], content='/dev/visible/input.csv')
        runs = self.root / 'runs'
        (runs / 'README.md').write_text('Unregistered trace store notes /native/protected/oracle.txt')
        native = runs / 'model-smoke' / 'native-session'
        native.mkdir(parents=True)
        (native / 'session.jsonl').write_bytes(b'poison native raw; this is not evaluator feedback')
        (native / 'output.json').write_bytes(b'invalid native artifact')
        unregistered = native / 'attempt-9'
        unregistered.mkdir()
        (unregistered / 'trace.jsonl').write_bytes(b'poison unregistered attempt raw')
        original_open = os.open

        def checked_open(path, *args, **kwargs):
            path = Path(path)
            if path == runs / 'README.md' or native == path or native in path.parents:
                raise AssertionError('unregistered native content opened')
            return original_open(path, *args, **kwargs)

        with patch('os.open', side_effect=checked_open):
            rules = build_rules(manifest, runs)
        self.assertEqual(rules['dev_attempts'], 1)
        self.assertIn('/dev/visible/input.csv', rules['terms'])
        self.assertNotIn('/native/protected/oracle.txt', rules['terms'])
        (directory / 'metadata.json').write_bytes(b'corrupt registered metadata')
        with self.assertRaises(ValueError):
            build_rules(manifest, runs)

    def test_rules_include_all_task_metadata_dev_paths_and_explicit_outputs_without_verifier_access(self):
        manifest, frozen = self.frozen()
        dev_task, held_task = frozen['splits']['dev'][0], frozen['splits']['heldout'][0]
        self.trace(task=dev_task, content='cat /work/private/input.csv and C:\\work\\secret\\answer.txt')
        held_directory, _, _ = self.trace(task=held_task, run='held-rule', split='heldout', content='/heldout/private/oracle.txt')
        (held_directory / 'trace.jsonl').unlink()
        rules = build_rules(manifest, self.root / 'runs', expected_outputs=['EXACT OUTPUT 90721'])
        for index in range(4):
            self.assertIn(f'fixture-task-{index}', rules['terms'])
            self.assertIn(f'tasks/fixture-task-{index}', rules['terms'])
        for term in ('terminal-bench', 'verifier', '/work/private/input.csv',
                     'C:\\work\\secret\\answer.txt', 'EXACT OUTPUT 90721'):
            self.assertIn(term, rules['terms'])
        self.assertNotIn('/heldout/private/oracle.txt', rules['terms'])
        self.assertEqual(rules['expected_output_literals'], 1)
        self.assertEqual(rules['dev_attempts'], 1)
        # A poison heldout file remains unreachable too, even when present.
        (held_directory / 'trace.jsonl').write_bytes(b'corrupt protected raw')
        original_open = os.open

        def checked_open(path, *args, **kwargs):
            if Path(path) == held_directory / 'trace.jsonl':
                raise AssertionError('heldout raw opened by rule builder')
            return original_open(path, *args, **kwargs)

        with patch('os.open', side_effect=checked_open):
            self.assertEqual(build_rules(manifest, self.root / 'runs', ['EXACT OUTPUT 90721']), rules)

    def test_rule_builder_rejects_registry_hash_mismatch(self):
        manifest, frozen = self.frozen()
        self.trace(task=frozen['splits']['dev'][0])
        (manifest.parent / 'registry.json').write_bytes(b'[]')
        with self.assertRaisesRegex(ValueError, 'hash'):
            build_rules(manifest, self.root / 'runs')

    def test_guard_rejects_dataset_paths_and_expected_output_without_leaking_terms(self):
        manifest, frozen = self.frozen()
        self.trace(task=frozen['splits']['dev'][0], content='cat /work/private/input.csv and C:\\work\\private\\input.csv')
        rules = build_rules(manifest, self.root / 'runs', ['EXACT OUTPUT 90721'])
        values = ['terminal-bench', frozen['splits']['heldout'][0], '/work/private/input.csv',
                  '\\work\\private\\input.csv', 'C:\\\\work\\\\private\\\\input.csv', 'EXACT OUTPUT 90721',
                  'ＴＥＲＭＩＮＡＬ－ＢＥＮＣＨ', 'ｅｘａｃｔ ｏｕｔｐｕｔ ９０７２１']
        for index, value in enumerate(values):
            destination = self.root / f'guard-{index}'
            with self.subTest(value=value):
                with self.assertRaises(ValueError) as caught:
                    apply_proposal(self.base, destination, self.proposal((value + '\n').encode()), rules)
                self.assertNotIn(value, str(caught.exception))
                self.assertFalse(destination.exists())
        task = frozen['splits']['heldout'][0]
        guarded_path = f'lib/{task}.js'
        proposal = {'schema_version': 1, 'kind': 'code', 'change': 'Add a utility',
                    'patch': f'diff --git a/{guarded_path} b/{guarded_path}\nnew file mode 100644\n'
                             f'--- /dev/null\n+++ b/{guarded_path}\n@@ -0,0 +1 @@\n+export const safe = true;\n'}
        with self.assertRaises(ValueError):
            apply_proposal(self.base, self.root / 'guard-path', proposal, rules)

    def test_safe_valid_patch_has_real_candidate_commit_and_keeps_checkout_and_hooks_untouched(self):
        hook = self.base / '.git' / 'hooks' / 'post-commit'
        hook.parent.mkdir(exist_ok=True)
        marker = self.root / 'hook-ran'
        hook.write_text(f'#!/bin/sh\nprintf bad > "{marker.as_posix()}"\n')
        hook.chmod(0o755)
        proposal = self.proposal()
        original = (self.base / 'prompts/system.md').read_bytes()
        destination = self.root / 'candidate'
        result = apply_proposal(self.base, destination, proposal, {'terms': ['protected-fixture']})
        self.assertRegex(result['harness_commit'], r'^[0-9a-f]{40}$')
        self.assertEqual(result['harness_commit'], self.command(destination, 'rev-parse', 'HEAD').decode().strip())
        self.assertEqual(self.command(destination, 'cat-file', '-t', result['harness_commit']), b'commit\n')
        self.assertEqual(self.command(destination, 'rev-list', '--count', 'HEAD'), b'2\n')
        self.assertEqual(result['changed_paths'], ['prompts/system.md'])
        self.assertEqual(result['patch_sha256'], hashlib.sha256(proposal['patch'].encode()).hexdigest())
        self.assertEqual((destination / 'prompts/system.md').read_bytes(), b'Use tools and verify the result.\n')
        self.assertEqual((self.base / 'prompts/system.md').read_bytes(), original)
        self.assertEqual(self.command(self.base, 'rev-parse', 'HEAD').decode().strip(), self.first)
        self.assertFalse((destination / 'evals').exists())
        self.assertFalse((destination / '.git' / 'hooks' / 'post-commit').exists())
        self.assertFalse(marker.exists())
        self.assertEqual(self.command(destination, 'status', '--porcelain'), b'')
        with self.assertRaises(ValueError):
            apply_proposal(self.base, destination, proposal, {'terms': ['protected-fixture']})

    def test_empty_regular_file_addition_and_deletion_are_real_tree_changes(self):
        path = 'lib/empty.txt'
        empty_blob = 'e69de29'
        added = self.root / 'empty-added'
        proposal = {'schema_version': 1, 'kind': 'code', 'change': 'Add an empty runtime marker',
                    'patch': f'diff --git a/{path} b/{path}\nnew file mode 100644\nindex 0000000..{empty_blob}\n'}
        first = apply_proposal(self.base, added, proposal, {'terms': ['protected-fixture']})
        self.assertEqual((added / path).read_bytes(), b'')
        self.assertEqual(first['changed_paths'], [path])
        self.assertEqual(self.command(added, 'cat-file', '-t', first['harness_commit']), b'commit\n')
        deleted = self.root / 'empty-deleted'
        proposal['change'] = 'Remove the empty runtime marker'
        proposal['patch'] = f'diff --git a/{path} b/{path}\ndeleted file mode 100644\nindex {empty_blob}..0000000\n'
        second = apply_proposal(added, deleted, proposal, {'terms': ['protected-fixture']})
        self.assertFalse((deleted / path).exists())
        self.assertEqual(second['changed_paths'], [path])
        self.assertEqual(self.command(deleted, 'cat-file', '-t', second['harness_commit']), b'commit\n')

    def test_regular_additions_and_deletions_are_committed_without_entire_root_deletion(self):
        patch_text = ('diff --git a/lib/runtime.js b/lib/runtime.js\n'
                      'deleted file mode 100644\n--- a/lib/runtime.js\n+++ /dev/null\n'
                      '@@ -1 +0,0 @@\n-export const mode = "bounded";\n'
                      'diff --git a/lib/new.js b/lib/new.js\nnew file mode 100644\n'
                      '--- /dev/null\n+++ b/lib/new.js\n@@ -0,0 +1 @@\n+export const mode = "safe";\n')
        proposal = {'schema_version': 1, 'kind': 'code', 'change': 'Replace the runtime mode', 'patch': patch_text}
        output = self.root / 'added-deleted'
        result = apply_proposal(self.base, output, proposal, {'terms': ['protected-fixture']})
        self.assertFalse((output / 'lib/runtime.js').exists())
        self.assertEqual((output / 'lib/new.js').read_bytes(), b'export const mode = "safe";\n')
        self.assertEqual(result['changed_paths'], ['lib/new.js', 'lib/runtime.js'])
        self.assertEqual(self.command(output, 'cat-file', '-t', result['harness_commit']), b'commit\n')

    def test_noop_and_patch_tricks_rejected_before_destination_allocation(self):
        standard = self.proposal()['patch']
        tricks = [standard.replace('prompts/system.md', '../outside'),
                  standard.replace('prompts/system.md', 'lib/../../outside'),
                  standard.replace('prompts/system.md', 'package.json'),
                  standard.replace('prompts/system.md', 'tests/test.py'),
                  standard.replace('prompts/system.md', 'lib/.git/config'),
                  standard.replace('prompts/system.md', 'lib/C:secret'),
                  standard.replace('prompts/system.md', 'lib/nul.txt'),
                  standard.replace('prompts/system.md', 'lib\\outside'),
                  standard.replace('prompts/system.md', 'lib/.gitattributes'),
                  standard.replace('--- a/', 'old mode 100644\nnew mode 100755\n--- a/', 1),
                  standard.replace(' 100644\n', ' 100755\n', 1),
                  standard.replace('--- a/', 'similarity index 100%\nrename from old\nrename to new\n--- a/', 1),
                  'diff --git a/lib/x b/lib/x\nGIT binary patch\nliteral 1\nA\n',
                  'diff --git a/lib/x b/lib/x\nnew file mode 120000\n--- /dev/null\n+++ b/lib/x\n@@ -0,0 +1 @@\n+/private\n',
                  standard.replace('+Use tools and verify the result.', '+Use available tools carefully.'),
                  standard.replace('@@ -1 +1 @@', '@@ -2 +2 @@'),
                  standard + standard,
                  standard.replace('\n', '\r\n')]
        for index, text in enumerate(tricks):
            proposal = {'schema_version': 1, 'kind': 'code', 'change': 'Improve runtime', 'patch': text}
            destination = self.root / f'trick-{index}'
            with self.subTest(index=index), patch('evolve.integrity._git', side_effect=AssertionError('Git ran before rejection')):
                with self.assertRaises(ValueError):
                    apply_proposal(self.base, destination, proposal, {'terms': ['protected-fixture']})
                self.assertFalse(destination.exists())
        root_delete = ('diff --git a/prompts/system.md b/prompts/system.md\ndeleted file mode 100644\n'
                       '--- a/prompts/system.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-Use available tools carefully.\n')
        with self.assertRaisesRegex(ValueError, 'entire runtime root'):
            apply_proposal(self.base, self.root / 'deleted-root',
                           {'schema_version': 1, 'kind': 'code', 'change': 'Remove a prompt', 'patch': root_delete},
                           {'terms': ['protected-fixture']})
        self.assertFalse((self.root / 'deleted-root').exists())

    def test_symlink_and_reparse_escapes_are_rejected(self):
        outside = self.root / 'outside.txt'
        outside.write_bytes(b'PRIVATE OUTSIDE DATA')
        link = self.base / 'lib' / 'leak'
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest('filesystem does not permit symlink creation')
        with self.assertRaises(ValueError):
            apply_proposal(self.base, self.root / 'symlink-candidate', self.proposal(), {'terms': ['protected-fixture']})
        directory, record, _ = self.trace()
        (directory / 'trace.jsonl').unlink()
        (directory / 'trace.jsonl').symlink_to(outside)
        with self.assertRaises(ValueError):
            export_feedback(self.root / 'runs', [record], self.root / 'symlink-feedback', ['dev-task'], [SHA])
        self.assertEqual(outside.read_bytes(), b'PRIVATE OUTSIDE DATA')

    def test_windows_reparse_flag_rejected_even_if_reported_as_regular_file(self):
        from evolve.sources import _safe_path
        actual = (self.base / 'lib/runtime.js').lstat()

        class Reparse:
            st_mode = actual.st_mode
            st_file_attributes = 0x400

        original = Path.lstat
        protected = self.base / 'lib/runtime.js'

        def lstat(path, *args, **kwargs):
            return Reparse() if path == protected else original(path, *args, **kwargs)

        with patch.object(Path, 'lstat', lstat):
            with self.assertRaisesRegex(ValueError, 'reparse'):
                _safe_path(protected)


if __name__ == '__main__':
    unittest.main()
