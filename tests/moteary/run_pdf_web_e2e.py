"""Real web-module -> protected local parser -> SQLite/HTTP checks (not a browser).
Run after building: python tests/moteary/run_pdf_web_e2e.py
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
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[2]
binary = Path(os.environ.get('MOTEARY_BINARY', root / 'build/youji')).resolve()
python = Path(os.environ.get('YOUJI_PDF_PYTHON', '/tmp/youji-pdf-venv/bin/python')).absolute()
output = Path(os.environ.get('YOUJI_PDF_QA_OUTPUT', root / 'validation/pdf-workspace-20261118'))
output.mkdir(parents=True, exist_ok=True)
checks = []
with tempfile.TemporaryDirectory(prefix='youji-web-pdf-') as directory:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = {**os.environ, 'YOUJI_PDF_PYTHON': str(python), 'YOUJI_PDF_WORKER': str(root / 'moteary/pdf_worker.py')}
    with open(Path(directory) / 'server.log', 'w') as log:
        server = subprocess.Popen([str(binary), '--addr', '127.0.0.1', '--port', str(port), '--data', directory, '--config-apply', 'off'], env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    with urlopen(base, timeout=1):
                        break
                except OSError:
                    if server.poll() is not None:
                        raise RuntimeError('Synthetic test server exited')
                    time.sleep(.1)
            else:
                raise RuntimeError('Synthetic test server not ready')
            def call(path, body=None, token=None, raw=False):
                headers = {'Content-Type': 'application/pdf' if raw else 'application/json'}
                if token:
                    headers['Authorization'] = 'Bearer ' + token
                data = body if raw else (json.dumps(body).encode() if body is not None else None)
                with urlopen(Request(base + '/api/' + path, data, headers), timeout=25) as response:
                    assert 'no-store' in response.headers.get('Cache-Control', '')
                    return json.load(response)
            passwords, tokens = [], []
            def account(name):
                password = secrets.token_urlsafe(24)
                passwords.append(password)
                user = call('users', {'username': name, 'password': password})
                token = call('auth/signin', {'passwordCredentials': {'username': name, 'password': password}})['accessToken']
                tokens.append(token)
                return user['name'], token
            account('synthetic-admin')
            owner, token = account('synthetic-owner')
            _, other = account('synthetic-other')
            fixture = root / 'tests/moteary/fixtures/synthetic-chinese.pdf'
            data = fixture.read_bytes()
            for path, body, raw in [('youji/pdf/processor', None, False), ('youji/pdf/parse', data, True)]:
                try:
                    call(path, body, raw=raw)
                    raise AssertionError('anonymous parser access accepted')
                except HTTPError as error:
                    assert error.code == 401
            checks.append({'check': 'anonymous status/parse requests denied with existing gateway authentication', 'passed': True})
            assert call('youji/pdf/processor', token=token)['available'] is True
            parsed = call('youji/pdf/parse', data, token, raw=True)
            assert parsed['sha256'] == hashlib.sha256(data).hexdigest()
            assert '中文检索水杉' in parsed['pages'][0]['text']
            assert len(parsed['pages']) == 2
            checks.append({'check': 'authenticated real pypdf 7.1.1 parses Chinese/English pages and server computes original hash', 'passed': True})
            for malformed in (b'not-pdf', b'%PDF-broken'):
                try:
                    call('youji/pdf/parse', malformed, token, raw=True)
                    raise AssertionError('malformed PDF accepted')
                except HTTPError as error:
                    assert error.code == 422
            assert not call('memos', token=token).get('memos')
            assert not call('attachments', token=token).get('attachments')
            checks.append({'check': 'parse/preview and malformed rejection write no memo or attachment', 'passed': True})
            qa = {'base': base, 'token': token, 'owner': owner, 'otherToken': other, 'fixture': str(fixture)}
            result = subprocess.run(['pnpm', 'exec', 'vitest', 'run', 'tests/moteary-pdf-import.test.ts', '--maxWorkers=1', '-t', 'runs the actual web PDF module'], cwd=root / 'web', env={**os.environ, 'YOUJI_PDF_WEB_QA': json.dumps(qa)}, capture_output=True, text=True, timeout=120)
            text = result.stdout + result.stderr
            for secret in passwords + tokens:
                text = text.replace(secret, '[REDACTED]')
            (output / 'web-module-http.log').write_text(text)
            checks.append({'check': 'actual frontend PDF module against real parser/API: save, orphan reuse, repeat verification, keyword retrieval, cleanup', 'passed': result.returncode == 0, 'returncode': result.returncode})
            report = {'kind': 'real protected parser/SQLite/HTTP plus actual TypeScript module; not browser E2E', 'checks': checks}
            (output / 'pdf-web-http.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(report, ensure_ascii=False, indent=2))
            if result.returncode:
                raise SystemExit(result.returncode)
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
