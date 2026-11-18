"""Frozen 66-query synthetic follow-up; no fitted score threshold."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import statistics
import time
import argparse

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model-dir', required=True)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
fixture = root / 'tests/moteary/fixtures/retrieval-independent-v1.json'
raw = fixture.read_bytes()
registration = json.loads((root / 'validation/retrieval-coverage-20261118/challenge-preregistration.json').read_text())
assert hashlib.sha256(raw).hexdigest() == registration['sha256'], 'Frozen challenge changed'
data = json.loads(raw)
path = root / 'moteary/retrieval_worker.py'
spec = importlib.util.spec_from_file_location('retrieval_worker', path)
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
attempts = []
def no_network(*args, **kwargs):
    attempts.append('blocked')
    raise OSError('network_disabled')
socket.socket = no_network
socket.create_connection = no_network
start = time.monotonic()
encoder = worker.Encoder(args.model_dir)
load_seconds = time.monotonic() - start
rows = []
for query in data['queries']:
    start = time.monotonic()
    result = encoder.search({'query': query['query'], 'documents': data['documents']})
    names = [h['id'] for h in result['hits']]
    for hit in result['hits']:
        assert hit['excerpt'] in next(d['text'] for d in data['documents'] if d['id'] == hit['id'])
    rank = next((i+1 for i,n in enumerate(names) if n in query['expected']), None)
    rows.append({**query, 'expected_rank':rank, 'hits':result['hits'], 'seconds':time.monotonic()-start})
groups = {}
for kind in ['literal','paraphrase','cross_language']:
    subset = [r for r in rows if r['type']==kind]
    groups[kind] = {'total':len(subset),'top1':sum(r['expected_rank']==1 for r in subset),'top5':sum(r['expected_rank'] is not None for r in subset)}
negative = [r for r in rows if not r['expected']]
worker_hash = hashlib.sha256(path.read_bytes()).hexdigest()
report = {'model':worker.MODEL,'revision':worker.REVISION,'fixture_sha256':registration['sha256'],
          'worker_sha256':worker_hash,'worker_unchanged_since_preregistration':worker_hash==registration['worker_sha256'],
          'groups':groups,'negative_queries':len(negative),'negative_queries_returning_candidates':sum(bool(r['hits']) for r in negative),
          'negative_top_score_range':[min(r['hits'][0]['score'] for r in negative),max(r['hits'][0]['score'] for r in negative)],
          'load_seconds':load_seconds,'warm_query_median_seconds':statistics.median(r['seconds'] for r in rows),
          'blocked_network_attempts':len(attempts),'threshold_fitted':False,
          'limitations':['Synthetic challenge, not real-user accuracy','Local warm encoder timing, not server SLA','Python network guard is not OS isolation','Negative queries are ranked, not classified as unanswerable'], 'queries':rows}
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='queries'},ensure_ascii=False,indent=2))
