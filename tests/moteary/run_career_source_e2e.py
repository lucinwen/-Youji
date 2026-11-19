"""Real SQLite/HTTP private-source acceptance, including old-binary migration.
MOTEARY_BINARY=build/youji YOUJI_BASELINE_BINARY=/trusted/pr22/youji python3 tests/moteary/run_career_source_e2e.py
Only synthetic fixtures; loopback, no model, no browser. Outputs outside repository by default.
"""
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
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(os.environ.get('MOTEARY_BINARY', ROOT / 'build/youji')).resolve()
BASELINE = Path(os.environ['YOUJI_BASELINE_BINARY']).resolve()
OUT = Path(os.environ.get('YOUJI_SOURCE_QA_OUTPUT', '/tmp/youji-career-source-validation'))
OUT.mkdir(parents=True, exist_ok=True)
checks = []
result = {'kind': 'real SQLite/HTTP, synthetic only; no browser/model', 'checks': checks,
          'binary_sha256': hashlib.sha256(BINARY.read_bytes()).hexdigest(),
          'baseline_sha256': hashlib.sha256(BASELINE.read_bytes()).hexdigest()}
process = None

def passed(label):
    checks.append({'check': label, 'passed': True})

def stop():
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

try:
    with tempfile.TemporaryDirectory(prefix='youji-career-source-') as directory:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        # Controlled clean environment: no inherited processor or database configuration.
        env = {'LANG': 'C.UTF-8', 'PATH': os.environ.get('PATH', '')}
        with (OUT / 'server.log').open('w') as log:
            def start(binary):
                global process
                process = subprocess.Popen([str(binary), '--addr', '127.0.0.1', '--port', str(port),
                    '--data', directory, '--driver', 'sqlite', '--dsn', '', '--unix-sock', '', '--config-apply', 'off'],
                    env=env, stdout=log, stderr=log)
                for _ in range(120):
                    try:
                        urlopen(base, timeout=1).close()
                        return
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError('server startup failed; see server.log')
                        time.sleep(.1)
                raise RuntimeError('server startup timeout')

            def request(path, body=None, token=None, method=None, raw=False):
                headers = {'Content-Type': 'application/json'}
                if token:
                    headers['Authorization'] = 'Bearer ' + token
                with urlopen(Request(base + path, None if body is None else json.dumps(body).encode(), headers, method=method), timeout=30) as r:
                    if path.startswith("/api/youji/") and "/source" in path:
                        assert r.headers.get("Cache-Control") == "no-store"
                    data = r.read()
                    return data if raw else json.loads(data or b'{}')

            def denied(codes, *args, **kwargs):
                try:
                    request(*args, **kwargs)
                except HTTPError as e:
                    assert e.code in codes, f'Expected {codes}, got {e.code}: {args[0]}'
                    return
                raise AssertionError('unexpected authorized response')

            def login(username, password):
                return request('/api/auth/signin', {'passwordCredentials': {'username': username, 'password': password}})['accessToken']

            def account(username):
                password = secrets.token_urlsafe(24)
                owner = request('/api/users', {'username': username, 'password': password})['name']
                return owner, login(username, password), password

            start(BASELINE)
            account('synthetic-admin')
            owner, token, password = account('synthetic-owner')
            other, other_token, other_password = account('synthetic-other')
            def memo(content, auth=None, uid=None, visibility='PRIVATE'):
                path = '/api/memos' + ('?' + urlencode({'memoId': uid}) if uid else '')
                return request(path, {'content': content, 'visibility': visibility}, auth or token)['name']
            review_text = '#拾微 #work #source/text\nSYN-JOB-2026-017 虚构复盘：预算未确认，不发送邀请。'
            review = memo(review_text)
            first_text = '# 同名资料\n虚构需求A SYN-JOB-2026-017，不是第二份。'
            second_text = '# 同名资料\n虚构需求B SYN-JOB-2026-017，否定句不能删。'
            first = memo(first_text, uid='career-source-a')
            second = memo(second_text)
            foreign = memo('另一合成账户的私密正文', other_token)
            stop()
            start(BINARY)
            token = login('synthetic-owner', password)
            other_token = login('synthetic-other', other_password)
            route = '/api/youji/' + review + '/source'
            def source(value=None, method='GET', auth=None, open_=False):
                return request(route + ('/open' if open_ else ''), value, auth or token, method)
            def set_source(value):
                return source({'sourceName': value}, 'PATCH')
            assert source() == {'status': 'none'}
            captured = request('/api/youji/' + review + '/dates', token=token)
            passed('real PR22 database upgrade preserves legacy private review with no automatic reference')
            assert set_source(first)['status'] == 'available'
            assert source() == {'status': 'available', 'sourceName': first}
            opened = source(open_=True)
            assert opened == {'status': 'available', 'sourceName': first, 'content': first_text}
            assert set_source(second)['status'] == 'available'
            assert source(open_=True)['content'] == second_text
            passed('set and overwrite resolve exact IDs despite identical titles; metadata contains no title/body/snippet')
            for invalid in [foreign, 'memos/missing-source', review]:
                denied({400,409}, route, {'sourceName': invalid}, token, 'PATCH')
                assert source()['sourceName'] == second
            denied({409}, route, {'sourceName': 'https://example.invalid/source'}, token, 'PATCH')
            for body in [{}, {'sourceName': 123}, {'sourceName': first, 'owner': other}]:
                denied({400}, route, body, token, 'PATCH')
                assert source()['sourceName'] == second
            for auth in [None, other_token, 'synthetic-invalid-token']:
                denied({401,403,404}, route, token=auth)
                denied({401,403,404}, route+'/open', token=auth)
                denied({401,403,404}, route, {'sourceName': None}, auth, 'PATCH')
            passed('foreign/missing/self source, invalid body/login and foreign review access rejected; failed overwrite preserves link')
            def change(name, field, value):
                request('/api/'+name+'?'+urlencode({'updateMask':field}), {'name':name, field:value}, token, 'PATCH')
            def unavailable():
                assert source() == {'status':'unavailable'}
                assert source(open_=True) == {'status':'unavailable'}
            for visibility in ['PUBLIC', 'PROTECTED']:
                change(second, 'visibility', visibility)
                unavailable()
                denied({409}, route, {'sourceName':second}, token, 'PATCH')
                change(second, 'visibility', 'PRIVATE')
                assert source(open_=True)['content'] == second_text
            change(second, 'state', 'ARCHIVED')
            unavailable()
            change(second, 'state', 'NORMAL')
            assert source(open_=True)['content'] == second_text
            passed('source public/protected/archive changes yield neutral unavailable, without cached identity or body')
            change(review,'visibility','PUBLIC')
            denied({404},route,token=token)
            denied({404},route+'/open',token=token)
            denied({404},route,{'sourceName':None},token,'PATCH')
            change(review,'visibility','PRIVATE')
            assert source()['sourceName'] == second
            passed('review must also remain private for reads, opens, and edits')
            set_source(first)
            request('/api/'+first,token=token,method='DELETE')
            unavailable()
            recreated = memo('# 同名资料\n替代品不能自动成为旧来源',uid=first.split('/')[1])
            assert recreated == first
            unavailable()
            assert set_source(None) == {'status':'none'}
            assert source() == {'status':'none'}
            assert set_source(second)['status'] == 'available'
            change(second,'content',second_text+'\n新纠正句：没有确认预算。')
            assert source(open_=True)['content'].endswith('没有确认预算。')
            passed('deleted source and same-UID replacement stay unavailable; clear works; open reads current corrected content')
            current = request('/api/'+review, token=token)
            assert current['content'] == review_text
            assert request('/api/youji/'+review+'/dates',token=token) == captured
            assert not any('source' in key.lower() for key in current)
            ordinary = request('/api/memos?'+urlencode({'filter':f'creator == {json.dumps(owner)}','pageSize':100}),token=token)
            assert 'source_memo_id' not in json.dumps(ordinary) and 'sourceName' not in json.dumps(ordinary)
            relations = request('/api/'+review+'/relations', token=token)
            assert not relations.get('relations')
            passed('source metadata does not enter ordinary memo/list/native relations; review text and dates unchanged')
            stop()
            start(BINARY)
            token = login('synthetic-owner',password)
            assert source()['sourceName'] == second
            assert source(open_=True)['content'].endswith('没有确认预算。')
            set_source(None)
            stop()
            start(BINARY)
            token = login('synthetic-owner',password)
            assert source() == {'status':'none'}
            passed('restart preserves selected source and later explicit clearing')
            stop()
    result['status'] = 'passed'
except Exception as e:
    result['status'] = 'failed'
    result['error'] = type(e).__name__ + ': ' + str(e)
finally:
    stop()
    (OUT / 'career-source-http.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
if result['status'] != 'passed':
    raise SystemExit(1)
