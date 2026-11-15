"""Regression tests for bounded source reads and non-destructive receipt claims."""
import io
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[2] / 'moteary'))
import import_sources as sources
import import_batch as batch


class ImportSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.source = self.root / 'note.txt'
        self.source.write_text('合成测试材料', encoding='utf-8')
        self.item = sources.prepare(self.source, 'diary')

    def test_read_is_bounded_before_rejecting_oversized_file(self):
        class TrackingReader(io.BytesIO):
            def read(self, size=-1):
                self.requested = size
                return super().read(size)
        reader = TrackingReader(b'x' * (sources.MAX_SOURCE_BYTES + 2))
        with patch.object(pathlib.Path, 'open', return_value=reader):
            with self.assertRaises(ValueError):
                sources.prepare(self.source, 'diary')
        self.assertEqual(reader.requested, sources.MAX_SOURCE_BYTES + 1)

    def test_exact_limit_is_accepted(self):
        with patch.object(sources, 'MAX_SOURCE_BYTES', 3):
            self.source.write_bytes(b'abc')
            self.assertEqual(sources.prepare(self.source, 'diary')['data'], b'abc')
            self.source.write_bytes(b'abcd')
            with self.assertRaises(ValueError):
                sources.prepare(self.source, 'diary')

    def reject_receipt_without_remote_write(self, receipt):
        class Client:
            def ingest(self, item):
                raise AssertionError('Must not attempt remote writes')
        with self.assertRaises(FileExistsError):
            batch.run_batch([self.item], Client(), receipt)
        self.assertEqual(list(self.root.glob('.moteary-receipt-*')), [])

    def test_existing_receipt_preserved(self):
        receipt = self.root / 'receipt.json'
        receipt.write_text('previous recovery evidence')
        self.reject_receipt_without_remote_write(receipt)
        self.assertEqual(receipt.read_text(), 'previous recovery evidence')

    def test_source_as_receipt_preserved(self):
        self.reject_receipt_without_remote_write(self.source)
        self.assertEqual(self.source.read_text(), '合成测试材料')

    def test_dangling_symlink_preserved(self):
        receipt = self.root / 'receipt.json'
        target = self.root / 'missing.json'
        receipt.symlink_to(target)
        self.reject_receipt_without_remote_write(receipt)
        self.assertTrue(receipt.is_symlink())
        self.assertFalse(target.exists())

    def test_second_claim_cannot_replace_first(self):
        receipt = self.root / 'receipt.json'
        batch.write_receipt(receipt, [{'status': 'in-progress'}], exclusive=True)
        before = receipt.read_bytes()
        with self.assertRaises(FileExistsError):
            batch.write_receipt(receipt, [], exclusive=True)
        self.assertEqual(receipt.read_bytes(), before)
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)

    def test_concurrent_claims_have_only_one_winner(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        start = Barrier(2)
        receipt = self.root / 'concurrent.json'
        def claim(index):
            start.wait()
            try:
                batch.write_receipt(receipt, [{'worker': index}], exclusive=True)
                return True
            except FileExistsError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(claim, (1, 2)))
        self.assertEqual(outcomes.count(True), 1)
        self.assertEqual(list(self.root.glob('.moteary-receipt-*')), [])
