"""Regression tests for bounded source reads and non-destructive receipt claims."""
import io
import pathlib
import sys
import tempfile
import unittest
import zipfile
from urllib.error import HTTPError
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[2] / 'moteary'))
import import_sources as sources
import import_batch as batch


class AttachmentRecovery(unittest.TestCase):
    def setUp(self):
        self.item = {'id': 'mw-synthetic-image', 'filename': 'synthetic.png',
                     'data': b'synthetic image bytes', 'type': 'image/png',
                     'content': 'synthetic image source', 'sha256': sources.hashlib.sha256(b'synthetic image bytes').hexdigest()}
        self.client = sources.Client('http://127.0.0.1:5231', 'synthetic')
        self.calls = []
        self.existing = None
        self.upload_count = 0

    def install_api(self, fail_archive=False, lose_memo_response=False, unknown_archive=False):
        def call(method, route, body=None):
            self.calls.append((method, route, body))
            if method == 'GET' and route == 'memos/' + self.item['id']:
                if self.existing is not None:
                    return self.existing
                raise HTTPError('', 404, 'missing', {}, None)
            if route == 'auth/me':
                return {'user': {'name': 'users/synthetic'}}
            if route == 'users/synthetic/usage':
                return {'limits': {'memoContentBytes': 10000}}
            if method == 'GET' and route.startswith('memos?'):
                return {'memos': []}
            if method == 'POST' and route == 'attachments':
                self.upload_count += 1
                if self.upload_count == 2 and fail_archive:
                    raise TimeoutError('archive response lost')
                if self.upload_count == 2 and unknown_archive:
                    return {}
                return {'name': 'attachments/' + ('preview' if self.upload_count == 1 else 'archive')}
            if method == 'POST' and route.startswith('memos?'):
                self.existing = dict(body, name='memos/' + self.item['id'])
                for attachment in self.existing['attachments']:
                    attachment['filename'] = self.item['filename'] + ('.original.zip' if attachment['name'].endswith('/archive') else '')
                if lose_memo_response:
                    raise TimeoutError('memo response lost after commit')
                raise RuntimeError('memo rejected')
            raise AssertionError((method, route))
        self.client.call = call

    def test_preview_receipt_survives_archive_response_loss(self):
        self.install_api(fail_archive=True)
        with self.assertRaises(RuntimeError) as caught:
            self.client.ingest(self.item)
        message = str(caught.exception)
        self.assertIn('uploaded preview=attachments/preview;', message)
        self.assertIn('confirmed attachments=["attachments/preview"]', message)
        self.assertIn('target=memos/' + self.item['id'], message)
        self.assertNotIn('uploaded attachment=', message)
        self.assertFalse(any(method == 'DELETE' for method, _, _ in self.calls))
        self.assertFalse(any(method == 'POST' and route.startswith('memos?') for method, route, _ in self.calls))

    def test_memo_failure_reports_archive_and_preview(self):
        self.install_api()
        with self.assertRaises(RuntimeError) as caught:
            self.client.ingest(self.item)
        message = str(caught.exception)
        self.assertRegex(message, r'uploaded attachment=(attachments/[^;]+);')
        self.assertIn('uploaded preview=attachments/preview;', message)
        self.assertIn('confirmed attachments=["attachments/preview", "attachments/archive"]', message)
        self.assertIn('target=memos/' + self.item['id'], message)
        self.assertFalse(any(method == 'DELETE' for method, _, _ in self.calls))

    def test_missing_upload_id_is_not_invented(self):
        self.install_api(unknown_archive=True)
        with self.assertRaises(RuntimeError) as caught:
            self.client.ingest(self.item)
        self.assertNotIn('uploaded attachment=', str(caught.exception))
        self.assertIn('confirmed attachments=["attachments/preview"]', str(caught.exception))
        self.assertFalse(any(method == 'POST' and route.startswith('memos?') for method, route, _ in self.calls))

    def test_lost_memo_response_preserves_linked_attachments_and_retry_verifies(self):
        self.install_api(lose_memo_response=True)
        with self.assertRaises(RuntimeError):
            self.client.ingest(self.item)
        self.assertEqual([a['name'] for a in self.existing['attachments']],
                         ['attachments/archive', 'attachments/preview'])
        archived = io.BytesIO()
        with zipfile.ZipFile(archived, 'w') as archive:
            archive.writestr(self.item['filename'], self.item['data'])
        posts_before = sum(method == 'POST' for method, _, _ in self.calls)
        with patch.object(self.client.opener, 'open', return_value=io.BytesIO(archived.getvalue())):
            result = self.client.ingest(self.item)
        self.assertEqual(result['status'], 'already-imported')
        self.assertEqual(sum(method == 'POST' for method, _, _ in self.calls), posts_before)
        self.assertFalse(any(method == 'DELETE' for method, _, _ in self.calls))


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
