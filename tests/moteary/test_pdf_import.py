"""Real pinned pypdf extraction plus deterministic import planning tests."""
import hashlib
import io
import subprocess
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'moteary'))
import import_pdf as pdf
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject


def fixture(texts=('SyntheticPDFNeedle source text', '', 'PageThreeNeedle')):
    writer = PdfWriter()
    for text in texts:
        page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject()
        escaped = text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        stream.set_data(('BT /F1 12 Tf 72 720 Td (' + escaped + ') Tj ET').encode())
        page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def item(data=None):
    data = fixture() if data is None else data
    return dict(id='mw-synthetic', filename='synthetic.pdf', data=data, sha256=hashlib.sha256(data).hexdigest(), content='', type='application/pdf', kind='work')


class PDFTests(unittest.TestCase):
    def test_real_parser_preserves_page_positions(self):
        pages = pdf.extract(fixture())
        self.assertEqual([p['page'] for p in pages], [1, 2, 3])
        self.assertIn('SyntheticPDFNeedle', pages[0]['text'])
        self.assertFalse(pages[1]['text'].strip())
        self.assertIn('PageThreeNeedle', pages[2]['text'])

    def test_worker_timeout_fails_closed(self):
        with patch.object(pdf.subprocess, 'run', side_effect=subprocess.TimeoutExpired('worker', 15)):
            with self.assertRaisesRegex(ValueError, 'resource limits'):
                pdf.extract(b'%PDF-synthetic')

    def test_worker_receives_only_bytes_and_sanitized_environment(self):
        def worker(command, **kwargs):
            self.assertIn('-I', command)
            self.assertEqual(kwargs['env'], {'LANG': 'C.UTF-8'})
            self.assertEqual(kwargs['input'], b'%PDF-synthetic')
            self.assertEqual(kwargs['timeout'], 15)
            kwargs['stdout'].write(b'{"parser":"pypdf","version":"7.1.1","pages":[{"page":1,"text":"safe"}]}')
            return Mock(returncode=0)
        with patch.object(pdf.subprocess, 'run', side_effect=worker):
            self.assertEqual(pdf.extract(b'%PDF-synthetic')[0]['text'], 'safe')

    def test_cleanup_requires_explicit_comment_cascade_acknowledgement(self):
        client = Mock()
        client.call.return_value = {'user': {'name': 'users/a'}}
        with self.assertRaisesRegex(ValueError, '--include-comments'):
            pdf.delete_pdf(client, item(), [{'page': 1, 'text': 'hello'}], 'memos/mp-example')
        self.assertEqual(client.call.call_args.args, ('GET', 'auth/me'))

    def test_real_chinese_fixture(self):
        pages = pdf.extract((Path(__file__).parent / 'fixtures/synthetic-chinese.pdf').read_bytes())
        self.assertIn('中文检索水杉', pages[0]['text'])
        self.assertIn('SyntheticPDFNeedle', pages[1]['text'])

    def test_cross_entry_refused_before_writes(self):
        client = Mock()
        client.call.side_effect = [{'user': {'name': 'users/a'}}, {'limits': {'memoContentBytes': 0}}, {'memos': [{'name': 'memos/mw-existing'}]}]
        with self.assertRaisesRegex(ValueError, 'existing original'):
            pdf.ingest_pdf(client, item(), [{'page': 1, 'text': 'hello'}])
        client.ingest.assert_not_called()

    def test_invalid_and_scanned_rejected(self):
        for data in (b'not a pdf', b'%PDF-broken', fixture(('',))):
            with self.subTest(data=data[:12]), self.assertRaises(ValueError):
                pdf.extract(data)

    def test_encryption_rejected(self):
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        writer.encrypt('')
        output = io.BytesIO()
        writer.write(output)
        with self.assertRaisesRegex(ValueError, 'Encrypted'):
            pdf.extract(output.getvalue())

    def test_page_limit(self):
        with self.assertRaisesRegex(ValueError, '64 pages'):
            pdf.extract(fixture(tuple('x' for _ in range(65))))

    def test_original_and_provenance(self):
        original = item()
        records = pdf.plan(original, pdf.extract(original['data']), 0, 'users/a')
        self.assertEqual(records[0]['data'], original['data'])
        self.assertEqual(len(records), 3)
        self.assertIn('第 2 页：无可提取正文', records[0]['content'])
        self.assertIn('第 3 页', records[2]['content'])
        self.assertIn(original['sha256'], records[2]['content'])
        self.assertIn(records[0]['id'], records[2]['content'])
        self.assertEqual(records, pdf.plan(original, pdf.extract(original['data']), 0, 'users/a'))
        self.assertNotEqual(records[0]['id'], pdf.plan(original, pdf.extract(original['data']), 0, 'users/b')[0]['id'])

    def test_utf8_and_fences(self):
        text = '中文段落' * 1100 + '\n```\n![tracker](https://invalid.example/x)\n<script>x</script>'
        records = pdf.plan(item(), [{'page': 1, 'text': text}], 0, 'users/a')
        self.assertEqual(b''.join(r['data'] for r in records[1:]).decode(), text)
        self.assertTrue(all(len(r['data']) <= 4096 for r in records[1:]))
        self.assertIn('````\n', records[-1]['content'])

    def test_quota_before_writes(self):
        client = Mock()
        client.call.side_effect = [{'user': {'name': 'users/a'}}, {'limits': {'memoContentBytes': 10}}]
        with self.assertRaisesRegex(ValueError, 'quota'):
            pdf.ingest_pdf(client, item(), [{'page': 1, 'text': 'hello'}])
        client.ingest.assert_not_called()

    def test_partial_receipt_and_no_rollback(self):
        client = Mock()
        client.call.side_effect = [{'user': {'name': 'users/a'}}, {'limits': {'memoContentBytes': 0}}, {'memos': []}]
        client.ingest.side_effect = [{'name': 'memos/root'}, RuntimeError('synthetic failure')]
        with self.assertRaisesRegex(RuntimeError, '1/2 verified'):
            pdf.ingest_pdf(client, item(), [{'page': 1, 'text': 'hello'}])
        self.assertEqual(client.call.call_count, 3)


if __name__ == '__main__':
    unittest.main()
