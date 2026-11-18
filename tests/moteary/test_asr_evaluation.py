"""Evaluation guards only; actual ASR results are separate real-inference evidence."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[2] / 'moteary/asr-evaluation/evaluate.py'
spec = importlib.util.spec_from_file_location('asr_evaluation', SCRIPT)
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


class ASREvaluationGuards(unittest.TestCase):
    def test_reuse_audio_checks_original_hash_without_regenerating(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            records = []
            for identifier, filename in [('synthetic-zh', 'synthetic-zh.wav'), ('synthetic-en', 'synthetic-en.wav'), ('synthetic-silence', 'silence.wav')]:
                data = identifier.encode()
                (root / filename).write_bytes(data)
                records.append({'id': identifier, 'sha256': hashlib.sha256(data).hexdigest(), 'language_hint': 'en', 'expected': 'synthetic'})
            reference = root / 'reference.json'
            reference.write_text(json.dumps({'cases': records}))
            self.assertEqual(len(evaluation.reuse_audio(root, reference)), 3)
            (root / 'silence.wav').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'do not regenerate'):
                evaluation.reuse_audio(root, reference)
            self.assertEqual((root / 'silence.wav').read_bytes(), b'changed')

    def test_vad_missing_or_corrupt_asset_rejected_locally(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'silero_vad_v6.onnx'
            package = SimpleNamespace(locate_file=lambda name: path)
            with patch.object(evaluation.importlib.metadata, 'distribution', return_value=package):
                with self.assertRaisesRegex(ValueError, 'no download attempted'):
                    evaluation.verify_vad()
                path.write_bytes(b'corrupt local synthetic vad')
                with self.assertRaisesRegex(ValueError, 'no download attempted'):
                    evaluation.verify_vad()

    def test_required_local_files_and_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            names = ['model.bin', 'tokenizer.json', 'config.json', 'vocabulary.txt']
            manifest = {'files': [{'file': name, 'sha256': hashlib.sha256(name.encode()).hexdigest()} for name in names]}
            for name in names:
                (root / name).write_bytes(name.encode())
            evaluation.verify_model(root, manifest)
            for name in names:
                with self.subTest(name=name):
                    (root / name).unlink()
                    with self.assertRaises(ValueError): evaluation.verify_model(root, manifest)
                    (root / name).write_bytes(b'corrupt')
                    with self.assertRaises(ValueError): evaluation.verify_model(root, manifest)
                    (root / name).write_bytes(name.encode())

    def test_error_metric(self):
        self.assertEqual(evaluation.edit_distance(['a', 'b'], ['a', 'x', 'b']), 1)
        self.assertEqual(evaluation.units('Hello, WORLD!', 'en'), ['hello', 'world'])
        self.assertEqual(evaluation.units('合成，测试。', 'zh'), list('合成测试'))

    def test_network_guard_allows_ssl_import_but_rejects_connections(self):
        code = '''import importlib.util,sys,socket
s=importlib.util.spec_from_file_location('evaluation',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
attempts=m.disable_python_network()
import ssl
for action in [lambda:socket.socket(),lambda:socket.create_connection(('127.0.0.1',9))]:
 try:action()
 except OSError as e:assert str(e)=='network_disabled'
 else:raise AssertionError('network enabled')
assert len(attempts)==2
'''
        result = subprocess.run([sys.executable, '-c', code, str(SCRIPT)], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
