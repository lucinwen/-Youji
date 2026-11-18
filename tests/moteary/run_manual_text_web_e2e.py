"""Synthetic manual text; real HTTP/SQLite + frontend module, not browser/ASR.

The companion TypeScript test adapts Connect calls to the real REST gateway and
injects selected response losses after real commits. No production build occurs.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import zipfile


def run():
    root = Path(__file__).resolve().parents[2]
    binary = Path(os.environ.get('MOTEARY_BINARY', root / 'build/youji')).resolve()
    output = Path(os.environ.get('YOUJI_MANUAL_TEXT_QA_OUTPUT', root / 'validation/manual-text-workspace-20261118'))
    output.mkdir(parents=True, exist_ok=True)
    checks, secret_values = [], []
    server = None
    stage = 'setup'
    failure = None
    binary_hash = None

    def redact(value):
        for secret in secret_values:
            value = value.replace(secret, '[REDACTED]')
        return re.sub(r'(?i)Bearer\s+[^\s\"\',;]+', 'Bearer [REDACTED]', value)

    def passed(check):
        checks.append({'check': check, 'status': 'passed'})

    try:
        digest = hashlib.sha256()
        with binary.open('rb') as source:
            while block := source.read(1024 * 1024): digest.update(block)
        binary_hash = digest.hexdigest()
        with tempfile.TemporaryDirectory(prefix='youji-manual-text-http-') as directory:
            temp = Path(directory)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            env = {key: value for key, value in os.environ.items() if not key.startswith(('YOUJI_', 'MEMOS_'))}
            fixture = temp / 'synthetic-manual.txt'
            fixture.write_bytes('2026-11-18 合成甲：ManualTextNeedle 松涛计划。\r\n合成乙：保留原始文本。\n````\n#source/not-a-real-tag\n<script>literalOnly()</script>\n````\n'.encode('utf-8'))

            def call(path, body=None, token=None, method=None):
                headers = {'Content-Type': 'application/json'}
                if token: headers['Authorization'] = 'Bearer ' + token
                data = json.dumps(body).encode() if body is not None else None
                with urlopen(Request(base + '/api/' + path, data, headers, method=method), timeout=30) as response:
                    assert 'no-store' in response.headers.get('Cache-Control', '')
                    return json.load(response)

            def account(name):
                password = secrets.token_urlsafe(24)
                secret_values.append(password)
                owner = call('users', {'username': name, 'password': password})['name']
                token = call('auth/signin', {'passwordCredentials': {'username': name, 'password': password}})['accessToken']
                secret_values.append(token)
                return owner, token, password

            with (temp / 'server.log').open('w') as log:
                def start():
                    nonlocal server
                    server = subprocess.Popen([str(binary), '--addr', '127.0.0.1', '--port', str(port),
                                               '--data', directory, '--config-apply', 'off'],
                                              env=env, stdout=log, stderr=log)
                    for _ in range(100):
                        try:
                            urlopen(base, timeout=1).close()
                            return
                        except OSError:
                            if server.poll() is not None: raise RuntimeError('Temporary server exited')
                            time.sleep(.1)
                    raise RuntimeError('Temporary server readiness timed out')

                try:
                    stage = 'temporary server startup'
                    start()
                    stage = 'real HTTP account setup'
                    account('synthetic-admin')
                    owner, token, password = account('synthetic-owner')
                    _, other_token, _ = account('synthetic-other')
                    try:
                        call('memos')
                        raise AssertionError('Anonymous memos unexpectedly accessible')
                    except HTTPError as error:
                        assert error.code == 401
                    passed('anonymous memo API denied')
                    config = {'base': base, 'token': token, 'owner': owner, 'otherToken': other_token, 'fixture': str(fixture)}
                    stage = 'actual TypeScript module and real HTTP'
                    result = subprocess.run(['pnpm', 'exec', 'vitest', 'run', 'tests/moteary-manual-text-http.test.ts', '--maxWorkers=1'],
                                            cwd=root / 'web', env={**env, 'YOUJI_MANUAL_TEXT_WEB_QA': json.dumps(config)},
                                            capture_output=True, text=True, timeout=300)
                    (output / 'web-module-http.log').write_text(redact(result.stdout + result.stderr))
                    if result.returncode:
                        raise RuntimeError('Manual text module HTTP test failed; see sanitized log')
                    passed('actual frontend manual file/paste module: PRIVATE, bytes, literal content, retry, injected response loss, conflict, isolation and deletion')
                    stage = 'restart persistence and final deletion'
                    memos = call('memos', token=token).get('memos', [])
                    assert len(memos) == 1
                    memo = memos[0]
                    server.terminate()
                    server.wait(timeout=10)
                    start()
                    token = call('auth/signin', {'passwordCredentials': {'username': 'synthetic-owner', 'password': password}})['accessToken']
                    secret_values.append(token)
                    restored = call(memo['name'], token=token)
                    assert restored['content'] == memo['content'] and restored['visibility'] == 'PRIVATE'
                    attachment = restored['attachments'][0]
                    original_url = base + '/file/' + attachment['name'] + '/' + quote(attachment['filename'], safe='')
                    with urlopen(Request(original_url, headers={'Authorization': 'Bearer ' + token}), timeout=15) as response:
                        raw = response.read()
                    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                        assert archive.namelist() == ['合成微信聊天.txt']
                        assert archive.read('合成微信聊天.txt') == fixture.read_bytes()
                    passed('restart preserves private manual record and byte-identical UTF-8 original')
                    call(memo['name'], token=token, method='DELETE')
                    assert not call('memos', token=token).get('memos')
                    assert not call('attachments', token=token).get('attachments')
                    try:
                        urlopen(Request(original_url, headers={'Authorization': 'Bearer ' + token}), timeout=10)
                        raise AssertionError('Deleted original still downloadable')
                    except HTTPError as error:
                        assert error.code == 404
                    passed('final deletion removes memo and attachment rows; original download becomes 404')
                finally:
                    if server is not None and server.poll() is None:
                        server.terminate()
                        try: server.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            server.kill(); server.wait()
                    log.flush()
                    (output / 'server.log').write_text(redact((temp / 'server.log').read_text(errors='replace')))
    except Exception as error:
        failure = redact(str(error))
        checks.append({'check': stage, 'status': 'blocked' if stage in ('setup', 'temporary server startup') else 'failed', 'error': failure})
    report = {'status': checks[-1]['status'] if failure else 'passed', 'kind': 'real HTTP/SQLite with actual frontend module; not browser',
              'model_executed': False, 'binary_sha256': binary_hash, 'checks': checks,
              'limitations': ['Connect-to-REST test adapter; browser interactions untested',
                             'Response loss injected at client boundary after real commits, not actual network outage',
                             'Deletion checks live rows/files, not physical erasure or backup removal']}
    (output / 'manual-text-http.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if failure else 0


if __name__ == '__main__':
    raise SystemExit(run())
