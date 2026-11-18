"""Local retrieval contract tests; inference quality is measured separately."""
import importlib.util
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

WORKER = Path(__file__).resolve().parents[2] / 'moteary/retrieval_worker.py'
spec = importlib.util.spec_from_file_location('retrieval_worker', WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class RetrievalWorkerContract(unittest.TestCase):
    def test_encoder_uses_independent_single_input_batches(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest('Optional retrieval NumPy dependency is unavailable')
        encoder = worker.Encoder.__new__(worker.Encoder)
        encoder.np = np
        tokenized, shapes = [], []
        def encode_batch(texts):
            tokenized.append(texts)
            return [SimpleNamespace(ids=[1, 2], attention_mask=[1, 1]) for _ in texts]
        def infer(outputs, inputs):
            shapes.append(inputs['input_ids'].shape)
            return [np.ones((*inputs['input_ids'].shape, 3))]
        encoder.tokenizer = SimpleNamespace(encode_batch=encode_batch)
        encoder.session = SimpleNamespace(get_inputs=lambda: [], run=infer)
        result = encoder.encode(['query: synthetic', 'passage: first', 'passage: second'])
        self.assertEqual(tokenized, [['query: synthetic'], ['passage: first'], ['passage: second']])
        self.assertEqual(shapes, [(1, 2)] * 3)
        self.assertEqual(result.shape, (3, 3))

    def test_missing_model(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                worker.verify_model(directory)

    def test_corrupt_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            for filename in worker.FILES:
                (Path(directory) / filename).write_bytes(b'corrupt synthetic model')
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                worker.verify_model(directory)

    def test_invalid_requests(self):
        for data in [None, [], {}, {'query': '', 'documents': []},
                     {'query': ' ' * 5, 'documents': []}, {'query': 'q' * 201, 'documents': []},
                     {'query': 'q', 'documents': None},
                     {'query': 'q', 'documents': [{'id': 'x', 'text': 'a'}] * 101},
                     {'query': 'q', 'documents': [{'id': 'x', 'text': 'a'}] * 2},
                     {'query': 'q', 'documents': [{'id': '', 'text': 'a'}]},
                     {'query': 'q', 'documents': [{'id': 'x', 'text': 123}]}]:
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, 'invalid_request'):
                worker.validate(data)

    def test_plain_text_windows_are_exact_original_substrings(self):
        text = '<script>synthetic()</script> **原文** & source\n' * 20
        parts, truncated = worker.passages([{'id': 's1', 'text': text}])
        self.assertFalse(truncated)
        for index, (identifier, excerpt) in enumerate(parts):
            self.assertEqual(identifier, 's1')
            self.assertEqual(excerpt, text[index * 224:index * 224 + 256])
            self.assertIn(excerpt, text)

    def test_segment_limit_round_robin_and_truncation(self):
        documents = [{'id': str(i), 'text': '文' * 2000} for i in range(100)]
        parts, truncated = worker.passages(documents)
        self.assertTrue(truncated)
        self.assertEqual(len(parts), 400)
        self.assertEqual([identifier for identifier, _ in parts[:100]], [str(i) for i in range(100)])
        exact, truncated = worker.passages([{'id': str(i), 'text': '文' * (224 * 4)} for i in range(100)])
        self.assertEqual(len(exact), 400)
        self.assertFalse(truncated)

    def test_empty_corpus_needs_no_encode(self):
        encoder = worker.Encoder.__new__(worker.Encoder)
        with patch.object(encoder, 'encode', side_effect=AssertionError('must not encode')):
            self.assertEqual(encoder.search({'query': 'empty', 'documents': []})['hits'], [])

    def test_cli_rejects_invalid_input_without_leaking_it(self):
        for raw in [b'private-invalid-json', b'x' * ((1 << 20) + 1)]:
            result = subprocess.run([sys.executable, str(WORKER), '--model-dir', '/missing-synthetic-model'],
                                    input=raw, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout), {'error': 'retrieval_unavailable'})
            self.assertEqual(result.stderr, b'')

    def test_native_network_is_denied_by_os_filter(self):
        code = """import ctypes, errno, importlib.util, json, sys
s=importlib.util.spec_from_file_location('worker',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
libc=ctypes.CDLL(None,use_errno=True)
fd=libc.socket(2,1,0)
assert fd >= 0, 'baseline native socket unavailable in this environment'
libc.close(fd)
m.restrict_native_network()
for family in (2,10,1):
 ctypes.set_errno(0)
 assert libc.socket(family,1,0) == -1
 assert ctypes.get_errno() == errno.EPERM
print(json.dumps({'baseline_ipv4_socket':True,'native_ipv4_ipv6_unix_denied':True}))
"""
        result = subprocess.run([sys.executable, '-c', code, str(WORKER)], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['native_ipv4_ipv6_unix_denied'])

    def test_inherited_socket_is_closed_and_filter_inherits(self):
        code = """import ctypes, errno, importlib.util, json, os, subprocess, sys, threading
s=importlib.util.spec_from_file_location('worker',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
fd=int(sys.argv[2]);os.fstat(fd)
m.restrict_native_network()
try: os.fstat(fd)
except OSError as error: assert error.errno == errno.EBADF
else: raise AssertionError('inherited descriptor survived')
results=[]
def probe():
 libc=ctypes.CDLL(None,use_errno=True)
 results.append(libc.socket(2,1,0)==-1 and ctypes.get_errno()==errno.EPERM)
t=threading.Thread(target=probe);t.start();t.join();assert results==[True]
child=subprocess.run([sys.executable,'-c','import ctypes,errno;c=ctypes.CDLL(None,use_errno=True);assert c.socket(2,1,0)==-1 and ctypes.get_errno()==errno.EPERM'],capture_output=True)
assert child.returncode==0, child.stderr
print(json.dumps({'inherited_socket_closed':True,'thread_and_child_denied':True}))
"""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as inherited:
            os.set_inheritable(inherited.fileno(), True)
            result = subprocess.run([sys.executable, '-c', code, str(WORKER), str(inherited.fileno())],
                                    pass_fds=(inherited.fileno(),), input=b'', capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['inherited_socket_closed'])

    def test_socket_standard_input_is_rejected_before_model_load(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as inherited:
            result = subprocess.run([sys.executable, str(WORKER), '--model-dir', '/missing-synthetic-model'],
                                    stdin=inherited, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout), {'error': 'retrieval_unavailable'})

    def test_cli_disables_socket_before_loading_encoder(self):
        # A probe replaces only the encoder in a child process; no real model
        # inference is claimed by this control-flow and network guard test.
        code = '''import importlib.util, os, socket, sys
s=importlib.util.spec_from_file_location("worker", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
class Probe:
 def __init__(self, directory):
  assert os.environ["HF_HUB_OFFLINE"] == "1"
  assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
  for operation in (lambda: socket.socket(), lambda: socket.create_connection(("127.0.0.1", 9))):
   try: operation()
   except OSError as e: assert str(e) == "network_disabled"
   else: raise AssertionError("network enabled")
 def search(self, data): return {"network_guard_verified": True}
m.Encoder=Probe
sys.argv=[sys.argv[1], "--model-dir", "/synthetic"]
sys.exit(m.main())
'''
        result = subprocess.run([sys.executable, '-c', code, str(WORKER)],
                                input=b'{"query":"synthetic","documents":[]}', capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'network_guard_verified': True})


if __name__ == '__main__':
    unittest.main()
