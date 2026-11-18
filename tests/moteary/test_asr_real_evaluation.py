"""Guard/metric tests; these do not simulate or replace real ASR evidence."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2] / 'moteary/asr-real-evaluation'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


evaluation, fetch = load('evaluate'), load('fetch_samples')


class RealASREvaluationGuards(unittest.TestCase):
    def test_fixed_selection_ignores_duplicate_sentences_and_long_audio(self):
        rows = [['long', 'long.wav', 'too long', '', '', '320001', 'unused']]
        for i in range(6):
            row = [str(i), str(i) + '.wav', '公开参考', '', '', '16000', 'unused']
            rows.extend([row, row])
        self.assertEqual([s['sentence_id'] for s in fetch.select(rows)], ['0', '1', '2', '3', '4'])

    def test_selection_rejects_path_traversal_and_insufficient_data(self):
        with self.assertRaises(ValueError):
            fetch.select([['0', '../private.wav', 'reference', '', '', '16000', 'unused']])
        with self.assertRaises(ValueError): fetch.select([])

    def test_hash_and_size_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'synthetic'
            p.write_bytes(b'synthetic')
            digest = hashlib.sha256(b'synthetic').hexdigest()
            evaluation.verify_file(p, digest, 9)
            with self.assertRaises(ValueError): evaluation.verify_file(p, digest, 8)
            with self.assertRaises(ValueError): evaluation.verify_file(p, '0' * 64, 9)
            p.unlink()
            with self.assertRaises(ValueError): evaluation.verify_file(p, digest, 9)

    def test_cer_normalization_and_insertions(self):
        self.assertEqual(evaluation.characters('中文，ＡＢＣ！ １２'), list('中文abc12'))
        self.assertEqual(evaluation.distance(list('甲'), list('甲乙丙')), 2)
        self.assertEqual(evaluation.distance(list('繁體'), list('繁体')), 1)

    def test_network_guard_preserves_ssl_import_and_blocks_sockets(self):
        code = '''import importlib.util,sys,socket
s=importlib.util.spec_from_file_location('evaluation',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
attempts=m.disable_network()
import ssl
for operation in (lambda:socket.socket(),lambda:socket.create_connection(('127.0.0.1',9))):
 try:operation()
 except OSError as error:assert str(error)=='network_disabled'
 else:raise AssertionError('network not blocked')
assert len(attempts)==2
'''
        result = subprocess.run([sys.executable, '-c', code, str(ROOT / 'evaluate.py')], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
