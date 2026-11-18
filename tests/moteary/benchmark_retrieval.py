"""Fixed synthetic 20-case real ONNX benchmark; ranking, not answer detection."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--cases', type=Path, default=Path(__file__).parent / 'fixtures/retrieval-cases.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    raw = args.cases.read_bytes()
    cases = json.loads(raw)
    assert len(cases) == 20 and len({case['id'] for case in cases}) == 20
    documents = [{'id': case['id'], 'text': case['text']} for case in cases]
    path = Path(__file__).resolve().parents[2] / 'moteary/retrieval_worker.py'
    spec = importlib.util.spec_from_file_location('retrieval_worker', path)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
    blocked_attempts = []
    def no_network(*unused_args, **unused_kwargs):
        blocked_attempts.append('socket attempt blocked')
        raise OSError('network_disabled')
    socket.socket = no_network
    socket.create_connection = no_network
    start = time.monotonic()
    encoder = worker.Encoder(args.model_dir)
    loaded = time.monotonic()
    rows = []
    for case in cases:
        result = encoder.search({'query': case['query'], 'documents': documents})
        expected = set(case['expected'])
        identifiers = [hit['id'] for hit in result['hits']]
        for hit in result['hits']:
            assert hit['excerpt'] in next(d['text'] for d in documents if d['id'] == hit['id'])
        rows.append({'id': case['id'], 'type': case['type'], 'query': case['query'],
                     'expected': case['expected'], 'hits': result['hits'],
                     'recall_at_1': len(expected.intersection(identifiers[:1])) / len(expected) if expected else None,
                     'recall_at_5': len(expected.intersection(identifiers[:5])) / len(expected) if expected else None,
                     'truncated': result['truncated']})
    groups = {}
    for kind in ('literal', 'paraphrase', 'cross_language'):
        selected = [r for r in rows if r['type'] == kind]
        groups[kind] = {'count': len(selected), **{
            metric: sum(r[metric] for r in selected) / len(selected) for metric in ('recall_at_1', 'recall_at_5')}}
    report = {'model': worker.MODEL, 'revision': worker.REVISION,
              'cases_sha256': hashlib.sha256(raw).hexdigest(), 'model_hashes_verified': True,
              'inference': 'real local CPU ONNX, quantized E5; one Encoder instance',
              'network_guard': 'Python socket constructors disabled; no OS-level network isolation claimed',
              'blocked_network_attempts': len(blocked_attempts), 'groups': groups,
              'no_answer': [{'id': row['id'], 'returned_candidates': len(row['hits'])} for row in rows if not row['expected']],
              'limitations': ['20 synthetic cases only', 'No calibrated no-answer detection',
                              'No browser, account permissions, or physical mobile validation'],
              'load_seconds': loaded - start, 'search_seconds': time.monotonic() - loaded, 'cases': rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ('groups', 'no_answer', 'blocked_network_attempts', 'load_seconds', 'search_seconds')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
