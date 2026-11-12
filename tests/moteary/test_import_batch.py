import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / 'moteary'))
import import_batch as batch


class BatchContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        (self.root / '日记.txt').write_text('今天的一点灵感', encoding='utf-8')
        (self.root / '讲座.md').write_text('# 技术与生活', encoding='utf-8')
        self.manifest = self.root / 'sources.json'

    def load(self, entries):
        self.manifest.write_text(json.dumps(entries, ensure_ascii=False), encoding='utf-8')
        return batch.load_batch(self.manifest)

    def test_multiple_inputs_relative_to_manifest(self):
        items = self.load([{'file': '日记.txt', 'kind': 'diary'}, {'file': '讲座.md', 'kind': 'lecture'}])
        self.assertEqual(len(items), 2)
        self.assertIn('今天', items[0]['content'])
        self.assertEqual(items[1]['kind'], 'lecture')

    def test_preflight_entire_batch(self):
        with self.assertRaises(ValueError):
            self.load([{'file': '日记.txt'}, {'file': 'missing.md'}])

    def test_reject_empty_or_overlarge(self):
        for entries in ([], [{'file': '日记.txt'}] * 101, {}):
            with self.subTest(entries=len(entries)), self.assertRaises(ValueError):
                self.load(entries)

    def test_reject_unknown_fields_and_wrong_types(self):
        for entry in ({'file': '日记.txt', 'token': 'secret'}, {'file': '日记.txt', 'note': []}, {'file': 4}):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                self.load([entry])

    def test_duplicate_identity_rejected(self):
        with self.assertRaises(ValueError):
            self.load([{'file': '日记.txt'}, {'file': '日记.txt'}])

    def test_separate_purpose_kept(self):
        self.assertEqual(len(self.load([{'file': '日记.txt', 'kind': 'work'}, {'file': '日记.txt', 'kind': 'diary'}])), 2)

    def test_manifest_symlink_rejected(self):
        self.load([{'file': '日记.txt'}])
        link = self.root / 'link.json'
        link.symlink_to(self.manifest)
        with self.assertRaises(ValueError):
            batch.load_batch(link)

    def test_receipt_omits_content_and_notes(self):
        items = self.load([{'file': '日记.txt', 'note': 'private note'}])
        class Client:
            def ingest(self, item):
                return {'status': 'imported', 'name': 'memos/' + item['id']}
        receipt = self.root / 'receipt.json'
        records, ok = batch.run_batch(items, Client(), receipt)
        self.assertTrue(ok)
        self.assertEqual(records[0]['status'], 'imported')
        text = receipt.read_text()
        self.assertNotIn('private note', text)
        self.assertNotIn('今天', text)
        self.assertEqual(list(self.root.glob('.moteary-receipt-*')), [])

    def test_failure_stops_and_records_uncertainty(self):
        items = self.load([{'file': '日记.txt'}, {'file': '讲座.md'}])
        class Client:
            calls = 0
            def ingest(self, item):
                self.calls += 1
                raise RuntimeError('sensitive provider payload')
        client = Client()
        receipt = self.root / 'receipt.json'
        records, ok = batch.run_batch(items, client, receipt)
        self.assertFalse(ok)
        self.assertEqual(client.calls, 1)
        self.assertEqual([r['status'] for r in records], ['needs-review', 'not-started'])
        self.assertNotIn('sensitive provider payload', receipt.read_text())

    def test_retry_revalidates_sources_via_client(self):
        items = self.load([{'file': '日记.txt'}])
        class Client:
            calls = 0
            def ingest(self, item):
                self.calls += 1
                return {'status': 'already-imported', 'name': 'memos/' + item['id']}
        client = Client()
        result, ok = batch.run_batch(items, client, self.root / 'receipt.json')
        self.assertTrue(ok)
        self.assertEqual(client.calls, 1)
        self.assertEqual(result[0]['status'], 'already-imported')


if __name__ == '__main__':
    unittest.main()
