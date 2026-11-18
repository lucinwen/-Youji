"""Real HTTP/SQLite + local ONNX challenge. Not a browser or general recall study."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[2]
binary = Path(os.environ.get('MOTEARY_BINARY', root / 'build/youji')).resolve()
python = Path(os.environ.get('YOUJI_RETRIEVAL_PYTHON', '/tmp/youji-retrieval-venv/bin/python')).absolute()
model = Path(os.environ.get('YOUJI_RETRIEVAL_MODEL', '/tmp/youji-e5-small')).resolve()
output = Path(os.environ.get('YOUJI_RETRIEVAL_QA_OUTPUT', root / 'validation/retrieval-20261118'))
output.mkdir(parents=True, exist_ok=True)
cases = json.loads((root / 'tests/moteary/fixtures/retrieval-cases.json').read_text())
checks, results = [], []
with tempfile.TemporaryDirectory(prefix='youji-semantic-qa-') as directory:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = {**os.environ, 'YOUJI_RETRIEVAL_PYTHON': str(python), 'YOUJI_RETRIEVAL_WORKER': str(root / 'moteary/retrieval_worker.py'), 'YOUJI_RETRIEVAL_MODEL': str(model)}
    secrets_used = []
    with open(Path(directory) / 'server.log', 'w') as log:
        server = subprocess.Popen([str(binary), '--addr', '127.0.0.1', '--port', str(port), '--data', directory, '--config-apply', 'off'], env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    urlopen(base, timeout=1).close()
                    break
                except OSError:
                    time.sleep(.1)
            def call(path, body=None, token=None, method=None):
                headers = {'Content-Type': 'application/json'}
                if token:
                    headers['Authorization'] = 'Bearer ' + token
                data = json.dumps(body).encode() if body is not None else None
                with urlopen(Request(base + '/api/' + path, data, headers, method=method), timeout=65) as response:
                    assert 'no-store' in response.headers.get('Cache-Control', '')
                    payload = response.read()
                    return json.loads(payload) if payload else {}
            def account(name):
                password = secrets.token_urlsafe(24)
                user = call('users', {'username': name, 'password': password})
                token = call('auth/signin', {'passwordCredentials': {'username': name, 'password': password}})['accessToken']
                secrets_used.extend([password, token])
                return user['name'], token
            def denied(path, body, token, expected):
                try:
                    call(path, body, token)
                    raise AssertionError('request unexpectedly accepted')
                except HTTPError as error:
                    assert error.code == expected, error.code
            account('synthetic-admin')
            owner, token = account('synthetic-owner')
            other_owner, other = account('synthetic-other')
            denied('youji/retrieval/processor', None, None, 401)
            denied('youji/retrieval/search', {'query': 'synthetic'}, None, 401)
            assert call('youji/retrieval/processor', token=token)['available']
            checks.append({'check': 'anonymous denied; configured local processor status', 'passed': True})
            mapping = {}
            for item in cases:
                memo = call('memos', {'content': item['text'], 'visibility': 'PRIVATE'}, token)
                assert memo['content'] == item['text'] and memo['visibility'] == 'PRIVATE'
                mapping[item['id']] = memo['name']
            for visibility in ['PRIVATE', 'PUBLIC', 'PROTECTED']:
                call('memos', {'content': 'timestamped audio transcript synthetic other account', 'visibility': visibility}, other)
            def search(query, filter='', who=token):
                return call('youji/retrieval/search', {'query': query, 'filter': filter}, who)
            all_names = set(mapping.values())
            started = time.monotonic()
            for case in cases:
                before = time.monotonic()
                found = search(case['query'])
                names = [h['name'] for h in found['hits']]
                assert names, 'Nonempty synthetic corpus must produce ranking candidates'
                assert set(names) <= all_names
                assert not found['truncated']
                for hit in found['hits']:
                    source = call(hit['name'], token=token)
                    assert hit['excerpt'] in source['content']
                expected = [mapping[i] for i in case['expected']]
                results.append({'id': case['id'], 'type': case['type'], 'expected_rank': next((i+1 for i,n in enumerate(names) if n in expected), None), 'returned': len(names), 'seconds': round(time.monotonic()-before,3)})
            checks.append({'check': '20 real ONNX HTTP queries; only owner records and exact current source excerpts', 'passed': True})
            assert not search('timestamped audio transcript', f'creator == "{other_owner}"')['hits']
            assert all(h['name'] not in all_names for h in search('timestamped audio transcript', who=other)['hits'])
            assert not search('synthetic', 'tag in ["nonexistent-synthetic-tag"]')['hits']
            assert not search('synthetic', 'created_ts < timestamp(1)')['hits']
            checks.append({'check': 'forged other creator, empty source/date filters, and second account remain isolated', 'passed': True})
            pending = socket.create_connection(('127.0.0.1', port), timeout=5)
            pending_body = json.dumps({'query': 'synthetic cancellation'}).encode()
            pending.sendall((f'POST /api/youji/retrieval/search HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {len(pending_body)}\r\n\r\n').encode() + pending_body)
            try:
                time.sleep(.15)
                denied('youji/retrieval/search', {'query': 'synthetic busy'}, token, 429)
            finally:
                pending.close()
            for attempt in range(30):
                try:
                    assert search('water')['hits']
                    break
                except HTTPError as error:
                    assert error.code == 429
                    time.sleep(.1)
            else:
                raise AssertionError('Cancelled request did not release inference slot')
            checks.append({'check': 'real TCP close cancels active model request and releases busy slot', 'passed': True})
            scoped = call('memos', {'content': '#拾微 #work #source/text\n\nSynthetic scoped source needle.', 'visibility': 'PRIVATE'}, token)
            scope_filter = f'creator == "{owner}" && tag in ["拾微"] && tag in ["work"] && tag in ["source/text"] && created_ts >= timestamp(1)'
            scoped_hits = search('source needle', scope_filter)['hits']
            assert [hit['name'] for hit in scoped_hits] == [scoped['name']]
            assert not search('source needle', scope_filter + ' && tag in ["diary"]')['hits']
            checks.append({'check': 'positive workbench owner/category/source/date filter and excluded category', 'passed': True})
            deleted = mapping['s17']
            call(deleted, token=token, method='DELETE')
            assert deleted not in [h['name'] for h in search('timestamped audio transcript')['hits']]
            call(mapping['s18'] + '?updateMask=content', {'name': mapping['s18'], 'content': 'Changed synthetic source, previous paragraph removed.'}, token, method='PATCH')
            fresh = search('从提取段落返回原始页面')
            assert all('Users can retrieve the original PDF page' not in h['excerpt'] for h in fresh['hits'])
            checks.append({'check': 'deletion and edits reflected in next query without stale persistent index', 'passed': True})
            denied('youji/retrieval/search', {'query': 'x'*201}, token, 422)
            server.terminate(); server.wait(timeout=10)
            fallback_env = {k:v for k,v in env.items() if not k.startswith('YOUJI_RETRIEVAL_')}
            server = subprocess.Popen([str(binary), '--addr', '127.0.0.1', '--port', str(port), '--data', directory, '--config-apply', 'off'], env=fallback_env, stdout=log, stderr=log)
            for _ in range(100):
                try:
                    urlopen(base, timeout=1).close(); break
                except OSError:
                    time.sleep(.1)
            token = call('auth/signin', {'passwordCredentials': {'username': 'synthetic-owner', 'password': secrets_used[2]}})['accessToken']
            secrets_used.append(token)
            denied('youji/retrieval/processor', None, token, 503)
            denied('youji/retrieval/search', {'query': 'water'}, token, 503)
            literal_filter = quote('content.contains("水杉散步")', safe='')
            assert call('memos?filter=' + literal_filter, token=token)['memos'][0]['name'] == mapping['s01']
            checks.append({'check': 'restart without model gives explicit503 while original keyword retrieval still works', 'passed': True})
            report = {'kind': 'real HTTP SQLite and local model, no browser', 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'checks': checks, 'cases': results, 'elapsed_seconds': round(time.monotonic()-started,3), 'negative_queries': 'Similarity returns candidates even for absent queries; not an answerability detector.'}
            for kind in ['literal','paraphrase','cross_language']:
                subset = [r for r in results if r['type']==kind]
                report[kind] = {'total':len(subset),'recall_at_1':sum(r['expected_rank']==1 for r in subset),'recall_at_5':sum(r['expected_rank'] is not None for r in subset)}
            (output / 'http-model.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps({k:v for k,v in report.items() if k!='cases'}, ensure_ascii=False, indent=2))
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait()
            log.flush()
            contents = (Path(directory) / 'server.log').read_text()
            for secret in secrets_used:
                contents = contents.replace(secret, '[REDACTED]')
            (output / 'server.log').write_text(contents)
