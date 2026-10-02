import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from evals.harbor.datasets import freeze_dataset, load_dataset_manifest


SOURCE_COMMIT = 'a' * 40
TASK_COMMIT = 'b' * 40
DATASET = 'terminal-bench@2.0'


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.json'
        self.output = self.root / 'frozen'
        self.row = {'name': 'terminal-bench', 'version': '2.0', 'description': 'metadata fixture',
                    'tasks': [{'name': f'sample-{i}', 'path': f'tasks/sample-{i}',
                               'git_url': 'https://example.com/tasks.git', 'git_commit_id': TASK_COMMIT}
                              for i in range(6)]}
        self.write_source()

    def write_source(self):
        self.source.write_text(json.dumps([self.row, {'name': 'other', 'version': '1.0',
                                                    'description': 'unselected', 'tasks': []}]), encoding='utf8')

    def freeze(self):
        return freeze_dataset(self.source, self.output, source_commit=SOURCE_COMMIT,
                              dev_size=2, heldout_size=2, seed=17)

    def read_manifest(self):
        return json.loads((self.output / 'manifest.json').read_text(encoding='utf8'))

    def replace_manifest(self, change):
        manifest = self.read_manifest()
        change(manifest)
        (self.output / 'manifest.json').write_text(json.dumps(manifest), encoding='utf8')

    def test_freeze_preserves_only_selected_registry_metadata_and_records_pins(self):
        self.freeze()
        snapshot = (self.output / 'registry.json').read_bytes()
        manifest = self.read_manifest()
        self.assertEqual(json.loads(snapshot), [self.row])
        self.assertEqual(manifest['dataset'], DATASET)
        self.assertEqual(manifest['registry_sha256'], hashlib.sha256(snapshot).hexdigest())
        self.assertEqual(manifest['source_registry_sha256'], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(manifest['source_commit'], SOURCE_COMMIT)
        self.assertEqual(manifest['task_count'], 6)
        self.assertIs(manifest['metadata_only'], True)
        self.assertIs(manifest['benchmark_contents_fetched'], False)
        self.assertEqual(manifest['image_digests_status'], 'unresolved')
        splits = manifest['splits']
        self.assertEqual(splits['status'], 'prospective_dev_pending_discrimination')
        self.assertEqual(splits['heldout_status'], 'frozen')
        self.assertEqual([len(splits[key]) for key in ('dev', 'heldout', 'remainder')], [2, 2, 2])
        self.assertEqual(set(splits['dev'] + splits['heldout'] + splits['remainder']),
                         {f'sample-{i}' for i in range(6)})

    def test_load_returns_exact_selection_and_hashes_without_touching_task_paths(self):
        self.freeze()
        manifest_path = self.output / 'manifest.json'
        for split in ('dev', 'heldout', 'full'):
            loaded = load_dataset_manifest(manifest_path, DATASET, split)
            expected = sorted(f'sample-{i}' for i in range(6)) if split == 'full' else self.read_manifest()['splits'][split]
            self.assertEqual(loaded['task_names'], expected)
            self.assertEqual(Path(loaded['registry_path']), (self.output / 'registry.json').resolve())
            self.assertEqual(loaded['manifest_sha256'], hashlib.sha256(manifest_path.read_bytes()).hexdigest())
            self.assertEqual(loaded['registry_sha256'], self.read_manifest()['registry_sha256'])
            self.assertEqual(loaded['source_commit'], SOURCE_COMMIT)
            self.assertEqual(loaded['task_count'], 6)
            self.assertEqual(loaded['image_digests_status'], 'unresolved')
        self.assertFalse((self.root / 'tasks').exists())

    def test_snapshot_is_consumable_through_harbor_local_registry_path(self):
        from harbor.registry.client.factory import RegistryClientFactory
        self.freeze()
        client = RegistryClientFactory.create(registry_path=self.output / 'registry.json')
        metadata = asyncio.run(client.get_dataset_metadata(DATASET))
        self.assertEqual(metadata.name, 'terminal-bench')
        self.assertEqual(metadata.version, '2.0')
        self.assertEqual(len(metadata.task_ids), 6)
        self.assertEqual({task.git_commit_id for task in metadata.task_ids}, {TASK_COMMIT})
        self.assertEqual({task.git_url for task in metadata.task_ids}, {'https://example.com/tasks.git'})

    def test_existing_output_is_never_overwritten(self):
        self.freeze()
        before = (self.output / 'manifest.json').read_bytes()
        with self.assertRaises(FileExistsError):
            self.freeze()
        self.assertEqual((self.output / 'manifest.json').read_bytes(), before)

    def test_invalid_task_metadata_is_rejected_before_output_creation(self):
        invalid = [('name', '../escape'), ('name', 'different-name'),
                   ('path', '/tasks/sample-0'), ('path', 'tasks/../sample-0'),
                   ('path', 'tasks//sample-0'), ('path', 'tasks/./sample-0'),
                   ('path', 'tasks\\sample-0'), ('path', 'C:/tasks/sample-0'),
                   ('path', 'tasks/sample-0/'), ('path', 'tasks/\nsample-0'),
                   ('git_url', 'http://example.com/tasks.git'), ('git_url', 'https:///tasks.git'),
                   ('git_url', 'https://user:secret@example.com/tasks.git'),
                   ('git_commit_id', 'main'), ('git_commit_id', 'b' * 39), ('git_commit_id', None)]
        for field, value in invalid:
            with self.subTest(field=field, value=value):
                original = self.row['tasks'][0][field]
                self.row['tasks'][0][field] = value
                self.write_source()
                with self.assertRaises(ValueError):
                    self.freeze()
                self.assertFalse(self.output.exists())
                self.row['tasks'][0][field] = original

    def test_duplicate_tasks_and_dataset_rows_are_rejected(self):
        self.row['tasks'].append(dict(self.row['tasks'][0]))
        self.write_source()
        with self.assertRaises(ValueError):
            self.freeze()
        self.row['tasks'].pop()
        self.source.write_text(json.dumps([self.row, self.row]), encoding='utf8')
        with self.assertRaises(ValueError):
            self.freeze()

    def test_case_insensitive_task_name_collisions_are_rejected_before_freezing(self):
        self.row['tasks'][0].update(name='Foo', path='tasks/Foo')
        self.row['tasks'][1].update(name='foo', path='tasks/foo')
        self.write_source()
        with self.assertRaises(ValueError):
            self.freeze()
        self.assertFalse(self.output.exists())

    def test_only_absent_or_empty_metric_metadata_is_supported(self):
        for index, metrics in enumerate(('not-a-list', {}, None, [{'type': 'mean'}])):
            with self.subTest(metrics=metrics):
                self.output = self.root / f'metrics-{index}'
                self.row['metrics'] = metrics
                self.write_source()
                with self.assertRaises(ValueError):
                    self.freeze()
                self.assertFalse(self.output.exists())
        self.output = self.root / 'empty-metrics'
        self.row['metrics'] = []
        self.write_source()
        self.freeze()
        self.assertEqual(load_dataset_manifest(self.output / 'manifest.json', DATASET, 'full')['task_count'], 6)

    def test_missing_dataset_short_source_pin_and_insufficient_inventory_are_rejected(self):
        with self.assertRaises(ValueError):
            freeze_dataset(self.source, self.output, dataset='absent@1.0', source_commit=SOURCE_COMMIT)
        with self.assertRaises(ValueError):
            freeze_dataset(self.source, self.output, source_commit='main', dev_size=2, heldout_size=2)
        with self.assertRaises(ValueError):
            freeze_dataset(self.source, self.output, source_commit=SOURCE_COMMIT)
        self.assertFalse(self.output.exists())

    def test_modified_snapshot_is_rejected_even_if_valid_json(self):
        self.freeze()
        snapshot = self.output / 'registry.json'
        snapshot.write_text(snapshot.read_text() + ' ', encoding='utf8')
        with self.assertRaisesRegex(ValueError, 'hash'):
            load_dataset_manifest(self.output / 'manifest.json', DATASET, 'dev')

    def test_load_revalidates_task_pins_after_snapshot_hash_is_recomputed(self):
        self.freeze()
        snapshot = self.output / 'registry.json'
        row = json.loads(snapshot.read_text())
        row[0]['tasks'][0]['git_commit_id'] = 'main'
        snapshot.write_text(json.dumps(row), encoding='utf8')
        self.replace_manifest(lambda m: m.update(registry_sha256=hashlib.sha256(snapshot.read_bytes()).hexdigest()))
        with self.assertRaises(ValueError):
            load_dataset_manifest(self.output / 'manifest.json', DATASET, 'full')

    def test_unknown_duplicate_overlapping_or_incomplete_splits_are_rejected(self):
        self.freeze()
        original = (self.output / 'manifest.json').read_bytes()
        changes = [lambda s: s['dev'].append('unknown'),
                   lambda s: s['dev'].append(s['dev'][0]),
                   lambda s: s['heldout'].append(s['dev'][0]),
                   lambda s: s['remainder'].pop(),
                   lambda s: s.update(dev=[]),
                   lambda s: s.update(heldout=[])]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                (self.output / 'manifest.json').write_bytes(original)
                self.replace_manifest(lambda m: change(m['splits']))
                with self.assertRaises(ValueError):
                    load_dataset_manifest(self.output / 'manifest.json', DATASET, 'dev')

    def test_split_reassignment_or_changed_seed_is_rejected(self):
        self.freeze()
        original = (self.output / 'manifest.json').read_bytes()

        def swap_members(manifest):
            splits = manifest['splits']
            splits['dev'][0], splits['heldout'][0] = splits['heldout'][0], splits['dev'][0]
            splits['dev'].sort()
            splits['heldout'].sort()

        for change in (swap_members, lambda m: m['splits'].update(seed=0)):
            with self.subTest(change=change.__name__):
                (self.output / 'manifest.json').write_bytes(original)
                self.replace_manifest(change)
                with self.assertRaises(ValueError):
                    load_dataset_manifest(self.output / 'manifest.json', DATASET, 'dev')

    def test_manifest_schema_provenance_dataset_and_registry_path_are_validated(self):
        self.freeze()
        original = (self.output / 'manifest.json').read_bytes()
        changes = [('schema_version', True), ('schema_version', 99), ('task_count', 7),
                   ('metadata_only', False), ('benchmark_contents_fetched', True),
                   ('source_commit', 'main'), ('source_registry_sha256', 'bad'),
                   ('dataset', 'other@1.0'), ('registry_path', '../source.json'),
                   ('registry_path', str((self.output / 'registry.json').resolve())),
                   ('image_digests_status', 'resolved')]
        for field, value in changes:
            with self.subTest(field=field, value=value):
                (self.output / 'manifest.json').write_bytes(original)
                self.replace_manifest(lambda m: m.update({field: value}))
                with self.assertRaises(ValueError):
                    load_dataset_manifest(self.output / 'manifest.json', DATASET, 'dev')
        (self.output / 'manifest.json').write_bytes(original)
        with self.assertRaises(ValueError):
            load_dataset_manifest(self.output / 'manifest.json', DATASET, 'remainder')

    def test_cli_freeze_and_verify_report_counts_without_task_names(self):
        command = [sys.executable, '-m', 'evals.harbor.datasets']
        frozen = subprocess.run(command + ['freeze', '--source-registry', str(self.source), '--output-dir', str(self.output),
                                          '--source-commit', SOURCE_COMMIT, '--dev-size', '2', '--heldout-size', '2'],
                                capture_output=True, text=True)
        self.assertEqual(frozen.returncode, 0, frozen.stderr)
        verified = subprocess.run(command + ['verify', str(self.output / 'manifest.json'), '--split', 'dev'],
                                  capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertEqual(json.loads(verified.stdout)['selected_task_count'], 2)
        for output in (frozen.stdout, verified.stdout):
            self.assertNotIn('sample-', output)


if __name__ == '__main__':
    unittest.main()
