"""Real SQLite/HTTP date acceptance, including old-binary migration.
MOTEARY_BINARY=build/youji YOUJI_BASELINE_BINARY=/trusted/pr21/youji python3 tests/moteary/run_career_dates_e2e.py
Only synthetic fixtures; loopback, no model, no browser. Outputs outside repository by default.
"""
import base64
from datetime import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(os.environ.get('MOTEARY_BINARY', ROOT / 'build/youji')).resolve()
BASELINE = Path(os.environ['YOUJI_BASELINE_BINARY']).resolve()
OUT = Path(os.environ.get('YOUJI_CAREER_QA_OUTPUT', '/tmp/youji-career-date-validation'))
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
    with tempfile.TemporaryDirectory(prefix='youji-career-dates-') as directory:
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
                    data = r.read()
                    return data if raw else json.loads(data or b'{}')

            def denied(codes, *args, **kwargs):
                try:
                    request(*args, **kwargs)
                except HTTPError as e:
                    assert e.code in codes, e.code
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
            legacy = request('/api/memos', {'content': '#拾微 #work #source/text\nSYN-JOB-2026-017 旧需求简报', 'visibility': 'PRIVATE'}, token)
            request('/api/' + legacy['name'] + '?updateMask=create_time', {'name': legacy['name'], 'createTime': '2026-11-10T12:00:00Z'}, token, 'PATCH')
            stop()
            start(BINARY)
            token = login('synthetic-owner', password)
            other_token = login('synthetic-other', other_password)

            def dates(name, body=None, auth=None):
                return request('/api/youji/' + name + '/dates', body, auth or token, 'PATCH' if body is not None else 'GET')

            before = dates(legacy['name'])
            assert before['eventDate'] is None and before['captureTimeBasis'] == 'legacy-created', before
            assert before['capturedAt'] == '2026-11-10T12:00:00Z', before
            passed('real PR21 database migration preserves legacy record and labels historical created time honestly')
            raw = ('完全虚构复盘 SYN-JOB-2026-017 条件下一步：预算未确认，不发送邀请。\n' * 12).encode()
            body = {'owner': owner, 'filename': 'synthetic-review.txt', 'data': base64.b64encode(raw).decode(),
                    'content': '#拾微 #work #source/text\n' + raw.decode()}
            receipt = request('/api/youji/manual-text/import', body, token)
            name = receipt['memo']['name'] if isinstance(receipt['memo'], dict) else receipt['memo']
            original = request('/api/' + name, token=token)
            fresh = dates(name)
            assert fresh['eventDate'] is None and fresh['captureTimeBasis'] == 'captured', fresh
            captured = fresh['capturedAt']
            for date in ['2026-11-14', '2024-02-29', '2026-11-15', None]:
                updated = dates(name, {'eventDate': date})
                assert updated['eventDate'] == date and updated['capturedAt'] == captured
            dates(name, {'eventDate': '2026-11-14'})
            for invalid in ['2026-02-29', '2026-13-01', '2026-11-31', '2026-1-02', '2026-11-14T00:00:00Z', 'not-a-date', 123]:
                denied({400}, '/api/youji/' + name + '/dates', {'eventDate': invalid}, token, 'PATCH')
                assert dates(name)['eventDate'] == '2026-11-14' and dates(name)['capturedAt'] == captured
            passed('new capture timestamp; event calendar set/change/leap day/clear; invalid values never partially mutate')
            request('/api/' + name + '?updateMask=create_time', {'name': name, 'createTime': '2000-01-01T00:00:00Z'}, token, 'PATCH')
            assert dates(name)['capturedAt'] == captured
            assert request('/api/' + name, token=token)['content'] == original['content']
            a = original['attachments'][0]
            url = '/file/' + a['name'] + '/' + quote(a['filename'], safe='')
            def original_bytes():
                with zipfile.ZipFile(io.BytesIO(request(url, token=token, raw=True))) as z:
                    assert z.read('synthetic-review.txt') == raw
            original_bytes()
            passed('editing event or native create_time never alters captured timestamp, original content or ZIP bytes')
            def search(extra, auth=None):
                scope = f'creator == {json.dumps(owner)} && tag in ["拾微"] && tag in ["work"] && content.contains("SYN-JOB-2026-017")'
                names, page = [], ''
                while True:
                    value = request('/api/memos?' + urlencode({'filter': scope + extra, 'pageSize': 1, 'pageToken': page}), token=auth or token)
                    names.extend(m['name'] for m in value.get('memos', []))
                    page = value.get('nextPageToken', '')
                    if not page: return names
                    assert len(names) < 30
            assert set(search('')) == {legacy['name'], name}
            assert search(' && event_date == "2026-11-14"') == [name]
            assert search(' && event_date >= "2026-11-13" && event_date <= "2026-11-15"') == [name]
            assert search(' && event_date == ""') == [legacy['name']]
            dates(legacy['name'], {'eventDate': '2026-11-14'})
            assert set(search(' && event_date == "2026-11-14"')) == {legacy['name'], name}
            try:
                foreign_results = search(' && event_date == "2026-11-14"', other_token)
                assert not foreign_results
            except HTTPError as e:
                assert e.code in (401, 403)
            passed('native date filtering precedes pagination; default includes legacy unknown; combined owner/keyword/date isolation')
            for auth in [None, other_token]:
                denied({401,403,404}, '/api/youji/' + name + '/dates', token=auth)
                denied({401,403,404}, '/api/youji/' + name + '/dates', {'eventDate':'2020-01-01'}, auth, 'PATCH')
            assert dates(name)['eventDate'] == '2026-11-14'
            passed('anonymous and foreign-account metadata reads/writes denied without changing owner data')
            stop()
            start(BINARY)
            token = login('synthetic-owner', password)
            assert dates(name)['capturedAt'] == captured and dates(name)['eventDate'] == '2026-11-14'
            assert dates(legacy['name'])['captureTimeBasis'] == 'legacy-created'
            assert set(search(' && event_date == "2026-11-14"')) == {legacy['name'], name}
            original_bytes()
            passed('restart/relogin preserves dates, capture provenance, search and original bytes')
            request('/api/' + name, token=token, method='DELETE')
            denied({404}, '/api/youji/' + name + '/dates', token=token)
            assert search(' && event_date == "2026-11-14"') == [legacy['name']]
            passed('deleted memo has no date metadata or date-search hit')
            stop()
    result['status'] = 'passed'
except Exception as e:
    result['status'] = 'failed'
    result['error'] = type(e).__name__ + ': ' + str(e)
finally:
    stop()
    (OUT / 'career-dates-http.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
if result['status'] != 'passed':
    raise SystemExit(1)
