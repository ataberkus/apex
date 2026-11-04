import json
from pathlib import Path
import tempfile
import unittest
from evals.analysis.trace_store import ingest_trace, load_dev_trace, freeze_splits

COMMIT = 'a' * 40


class TraceStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'input.jsonl'
        self.source.write_bytes(b'{"type":"agent_start"}\n')

    def test_ingest_preserves_raw_bytes_and_records_commit_and_hash(self):
        directory = ingest_trace(self.root / 'runs', 'run-1', 'task-a', 1, self.source, COMMIT, 'dev')
        self.assertEqual((directory / 'trace.jsonl').read_bytes(), self.source.read_bytes())
        meta = json.loads((directory / 'metadata.json').read_text())
        self.assertEqual(meta['harness_commit'], COMMIT)
        self.assertEqual(meta['split'], 'dev')
        self.assertEqual(len(meta['sha256']), 64)
        self.assertEqual(load_dev_trace(directory), [{'type': 'agent_start'}])

    def test_heldout_rejected_before_content_is_opened(self):
        directory = ingest_trace(self.root / 'runs', 'run-1', 'task-b', 1, self.source, COMMIT, 'heldout')
        (directory / 'trace.jsonl').write_bytes(b'not json and must never be parsed')
        with self.assertRaisesRegex(PermissionError, 'held-out'):
            load_dev_trace(directory)

    def test_unicode_string_separators_preserve_lf_framing_and_ingested_bytes(self):
        for index, separator in enumerate(('\u2028', '\u2029', '\u0085')):
            for ending_index, ending in enumerate(('\n', '\r\n')):
                with self.subTest(separator=hex(ord(separator)), ending=repr(ending)):
                    records = [{'type': 'message', 'message': {'role': 'user', 'content': 'before' + separator + 'after'}},
                               {'type': 'agent_start'}]
                    raw = (ending.join(json.dumps(row, ensure_ascii=False) for row in records) + ending).encode('utf8')
                    self.source.write_bytes(raw)
                    directory = ingest_trace(self.root / 'runs', f'unicode-{index}-{ending_index}', 'task-a', 1,
                                             self.source, COMMIT, 'dev')
                    self.assertEqual((directory / 'trace.jsonl').read_bytes(), raw)
                    self.assertEqual(load_dev_trace(directory), records)

    def test_heldout_rejected_before_missing_trace_file_is_read(self):
        directory = ingest_trace(self.root / 'runs', 'heldout-missing', 'task-b', 1, self.source, COMMIT, 'heldout')
        (directory / 'trace.jsonl').unlink()
        with self.assertRaisesRegex(PermissionError, 'held-out'):
            load_dev_trace(directory)

    def test_collisions_and_path_traversal_are_rejected(self):
        ingest_trace(self.root / 'runs', 'run-1', 'task-a', 1, self.source, COMMIT, 'dev')
        with self.assertRaises(FileExistsError):
            ingest_trace(self.root / 'runs', 'run-1', 'task-a', 1, self.source, COMMIT, 'dev')
        for bad_id in ['../escape', 'a/b', '', '..', 'C:\\escape']:
            with self.subTest(bad_id=bad_id), self.assertRaises(ValueError):
                ingest_trace(self.root / 'runs', 'run-1', bad_id, 1, self.source, COMMIT, 'dev')

    def test_tampered_dev_trace_cannot_be_analyzed(self):
        directory = ingest_trace(self.root / 'runs', 'run-1', 'task-a', 1, self.source, COMMIT, 'dev')
        (directory / 'trace.jsonl').write_text('{}\n')
        with self.assertRaisesRegex(ValueError, 'hash'):
            load_dev_trace(directory)

    def test_splits_are_reproducible_disjoint_and_exhaustive(self):
        tasks = [f'fixture-{i}' for i in range(50)]
        splits = freeze_splits(tasks, seed=17)
        self.assertEqual(splits, freeze_splits(list(reversed(tasks)), seed=17))
        self.assertEqual(len(splits['dev']), 18)
        self.assertEqual(len(splits['heldout']), 20)
        self.assertFalse(set(splits['dev']) & set(splits['heldout']))
        self.assertEqual(set(splits['dev'] + splits['heldout'] + splits['remainder']), set(tasks))
        with self.assertRaises(ValueError):
            freeze_splits(['duplicate', 'duplicate'], dev_size=1, heldout_size=1)
