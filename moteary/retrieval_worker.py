"""Optional local E5 retrieval. JSON stdin/stdout; no downloads or persistent index."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import sys

MODEL = 'intfloat/multilingual-e5-small'
REVISION = '614241f622f53c4eeff9890bdc4f31cfecc418b3'
FILES = {
    'model_qint8_avx512_vnni.onnx': 'dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88',
    'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    'config.json': 'bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6',
}



def restrict_native_network():
    """Deny socket creation and socket-specific calls on Linux x86_64.

    Launch only with pipe stdio and no inherited network descriptors (as the
    Go handler does). This grants no capabilities and is not a filesystem or
    complete process sandbox. Unsupported platforms fail closed in the CLI.
    """
    import ctypes
    import errno
    import platform
    import stat
    if sys.platform != 'linux' or platform.machine() not in ('x86_64', 'AMD64'):
        raise RuntimeError('network_sandbox_unavailable')
    libc = ctypes.CDLL(None, use_errno=True)
    bad_stdio = False
    for descriptor in range(3):
        if stat.S_ISSOCK(os.fstat(descriptor).st_mode):
            os.close(descriptor)
            bad_stdio = True
    # A launcher or native parent library may leave non-CLOEXEC descriptors.
    # close_range requires Linux >= 5.9; absence or policy denial fails closed.
    if libc.syscall(436, ctypes.c_uint(3), ctypes.c_uint(0xFFFFFFFF), 0) != 0:
        raise OSError(ctypes.get_errno(), 'descriptor_isolation_unavailable')
    if bad_stdio:
        raise RuntimeError('socket_stdio_rejected')
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte),
                    ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]
    class Program(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
    deny = 0x00050000 | errno.EPERM
    # Verify syscall architecture; reject x32 and io_uring alternate paths.
    rules = [(0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000),
             (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, deny)]
    for number in (41, 42, 43, 44, 45, 46, 47, 49, 50, 53, 101, 288, 299, 307, 310, 311, 425, 426, 427, 434, 438, *range(512, 548)):
        rules.extend([(0x15, 0, 1, number), (0x06, 0, 0, deny)])
    rules.append((0x06, 0, 0, 0x7FFF0000))
    filters = (Filter * len(rules))(*(Filter(*rule) for rule in rules))
    program = Program(len(rules), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'network_sandbox_unavailable')


def verify_model(directory):
    path = Path(directory)
    for name, digest in FILES.items():
        file = path / name
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise ValueError('unavailable')
    return path


def passages(documents):
    """Round-robin bounded original-text windows, never fabricated summaries."""
    result = []
    remaining = False
    for start in range(0, max((len(d['text']) for d in documents), default=0), 224):
        for document in documents:
            if start >= len(document['text']):
                continue
            if len(result) == 400:
                return result, True
            result.append((document['id'], document['text'][start:start + 256]))
    return result, remaining


def validate(data):
    if not isinstance(data, dict) or not isinstance(data.get('query'), str) or not 1 <= len(data['query'].strip()) <= 200:
        raise ValueError('invalid_request')
    documents = data.get('documents')
    if not isinstance(documents, list) or len(documents) > 100:
        raise ValueError('invalid_request')
    seen = set()
    for document in documents:
        if not isinstance(document, dict) or not isinstance(document.get('id'), str) or not isinstance(document.get('text'), str):
            raise ValueError('invalid_request')
        if not document['id'] or len(document['id']) > 100 or document['id'] in seen:
            raise ValueError('invalid_request')
        seen.add(document['id'])
    return data['query'].strip(), documents


class Encoder:
    def __init__(self, directory):
        path = verify_model(directory)
        # Only local file constructors. Never from_pretrained / HF download helpers.
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.np = np
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(path / 'model_qint8_avx512_vnni.onnx'), options, providers=['CPUExecutionProvider'])
        self.tokenizer = Tokenizer.from_file(str(path / 'tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=1, pad_token='<pad>')

    def encode(self, texts):
        np = self.np
        vectors = []
        # Independent inputs make quantized embeddings reproducible across candidate
        # order/batch composition. This is slower than shared padded batches.
        for text in texts:
            encoded = self.tokenizer.encode_batch([text])
            inputs = {'input_ids': np.array([e.ids for e in encoded], dtype=np.int64),
                      'attention_mask': np.array([e.attention_mask for e in encoded], dtype=np.int64)}
            if any(i.name == 'token_type_ids' for i in self.session.get_inputs()):
                inputs['token_type_ids'] = np.zeros_like(inputs['input_ids'])
            hidden = self.session.run(None, inputs)[0]
            mask = inputs['attention_mask'][..., None]
            pooled = (hidden * mask).sum(1) / mask.sum(1)
            pooled /= np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
            vectors.extend(pooled)
        return np.array(vectors)

    def search(self, data):
        query, documents = validate(data)
        parts, truncated = passages(documents)
        hits = {}
        if parts:
            vectors = self.encode(['query: ' + query] + ['passage: ' + text for _, text in parts])
            scores = vectors[1:] @ vectors[0]
            for (identifier, text), score in zip(parts, scores):
                if identifier not in hits or score > hits[identifier]['score']:
                    hits[identifier] = {'id': identifier, 'score': float(score), 'excerpt': text}
        # Similarity is ranking, not a calibrated probability or no-answer detector.
        return {'hits': sorted(hits.values(), key=lambda h: (-h['score'], h['id']))[:5],
                'model': MODEL, 'revision': REVISION, 'truncated': truncated}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    args = parser.parse_args()
    os.environ.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'TOKENIZERS_PARALLELISM': 'false'})
    def no_network(*args, **kwargs):
        raise OSError('network_disabled')
    socket.socket = no_network
    socket.create_connection = no_network
    try:
        restrict_native_network()
        import resource
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (50, 50))
        resource.setrlimit(resource.RLIMIT_AS, (3 << 30, 3 << 30))
        raw = sys.stdin.buffer.read((1 << 20) + 1)
        if len(raw) > 1 << 20:
            raise ValueError('invalid_request')
        data = json.loads(raw)
        validate(data)
        result = Encoder(args.model_dir).search(data)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception:
        # No raw input, paths, model errors or original content in logs.
        try:
            print(json.dumps({'error': 'retrieval_unavailable'}))
        except OSError:
            pass
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
