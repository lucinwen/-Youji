"""Four synthetic sources, real frontend modules/HTTP/SQLite; not browser or ASR."""
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
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
import wave
import zipfile


def run():
    root = Path(__file__).resolve().parents[2]
    binary = Path(os.environ.get('MOTEARY_BINARY', root / 'build/youji')).resolve()
    output = Path(os.environ.get('YOUJI_MULTISOURCE_QA_OUTPUT', root / 'validation/multisource-demo-20261118'))
    output.mkdir(parents=True, exist_ok=True)
    checks, credentials = [], []
    server = None
    stage, failure, binary_hash, worker_hash, evidence = 'setup', None, None, None, None

    def redact(text):
        for credential in credentials:
            text = text.replace(credential, '[REDACTED]')
        return re.sub(r'(?i)Bearer\s+[^\s\"\',;]+', 'Bearer [REDACTED]', text)

    def passed(check):
        checks.append({'check': check, 'status': 'passed'})

    try:
        with binary.open('rb') as source:
            digest = hashlib.sha256()
            while block := source.read(1024 * 1024):
                digest.update(block)
            binary_hash = digest.hexdigest()
        assets = list((root / 'server/frontend/dist/assets').glob('html.worker-*.js'))
        assert len(assets) == 1, 'Expected one existing production HTML worker asset; no build is performed'
        worker_hash = hashlib.sha256(assets[0].read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory(prefix='youji-multisource-http-') as directory:
            temp = Path(directory)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            env = {k: v for k, v in os.environ.items() if not k.startswith(('YOUJI_', 'MEMOS_'))}
            html = temp / 'synthetic.html'
            html.write_text('<!doctype html><title>合成参考网页</title><article><h1>合成共同主题</h1><p>SyntheticSharedTopic HTMLNeedle 合成参考材料。</p></article>', encoding='utf-8')
            chat = temp / 'synthetic-chat.json'
            chat.write_text(json.dumps({'name': '合成共同主题讨论', 'type': 'personal_chat', 'id': 123,
                'messages': [{'id': 1, 'type': 'message', 'date': '2026-11-18T12:00:00',
                              'from': '合成甲', 'text': 'SyntheticSharedTopic ChatNeedle 合成讨论。'}]}, ensure_ascii=False), encoding='utf-8')
            audio = temp / 'synthetic.wav'
            with wave.open(str(audio), 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b'\x00\x00' * 16000 * 4)
            originals = {'paste': 'SyntheticSharedTopic PasteNeedle 合成生活日记。'.encode(),
                         'html': html.read_bytes(), 'chat': chat.read_bytes(), 'audio-manual': audio.read_bytes()}

            def call(path, body=None, token=None, method=None, raw=False):
                headers = {'Content-Type': 'application/json'}
                if token:
                    headers['Authorization'] = 'Bearer ' + token
                data = json.dumps(body).encode() if body is not None else None
                with urlopen(Request(base + path, data, headers, method=method), timeout=30) as response:
                    return response.read() if raw else json.load(response)

            def signin(username, password):
                token = call('/api/auth/signin', {'passwordCredentials': {'username': username, 'password': password}})['accessToken']
                credentials.append(token)
                return token

            def account(username):
                password = secrets.token_urlsafe(24)
                credentials.append(password)
                owner = call('/api/users', {'username': username, 'password': password})['name']
                return owner, signin(username, password), password

            with (temp / 'server.log').open('w') as log:
                def start():
                    nonlocal server
                    server = subprocess.Popen([str(binary), '--addr', '127.0.0.1', '--port', str(port), '--data', directory,
                                               '--driver', 'sqlite', '--dsn', '', '--unix-sock', '', '--config-apply', 'off'],
                                              env=env, stdout=log, stderr=log)
                    for _ in range(100):
                        try:
                            urlopen(base, timeout=1).close()
                            return
                        except OSError:
                            if server.poll() is not None:
                                raise RuntimeError('Temporary server exited')
                            time.sleep(.1)
                    raise RuntimeError('Temporary server readiness timed out')

                def stop():
                    if server is not None and server.poll() is None:
                        server.terminate()
                        try:
                            server.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            server.kill()
                            server.wait()

                try:
                    stage = 'temporary server startup'
                    start()
                    stage = 'production worker matches embedded binary'
                    assert call('/assets/' + assets[0].name, raw=True) == assets[0].read_bytes()
                    passed('executed worker asset exactly matches worker served by the fixed binary')
                    stage = 'synthetic account setup'
                    account('synthetic-admin')
                    owner, token, password = account('synthetic-owner')
                    _, other_token, _ = account('synthetic-other')
                    config = {'base': base, 'token': token, 'owner': owner, 'otherToken': other_token,
                              'html': str(html), 'chat': str(chat), 'audio': str(audio),
                              'workerAsset': str(assets[0]), 'evidence': str(temp / 'sources.json')}
                    stage = 'four source frontend modules with real HTTP'
                    result = subprocess.run(['node', str(root / 'web/node_modules/vitest/vitest.mjs'), 'run', 'tests/moteary-multisource-http.test.ts', '--maxWorkers=1'],
                                            cwd=root / 'web', env={**env, 'YOUJI_MULTISOURCE_WEB_QA': json.dumps(config)},
                                            capture_output=True, encoding='utf-8', errors='replace', timeout=280)
                    (output / 'web-module-http.log').write_text(redact(result.stdout + result.stderr), encoding='utf-8')
                    if result.returncode:
                        raise RuntimeError('Multisource frontend HTTP check failed; see sanitized log')
                    evidence = json.loads((temp / 'sources.json').read_text(encoding='utf-8'))
                    passed('same account: paste, production-worker HTML, chat JSON and audio manual text; PRIVATE, exact ZIP originals, verified duplicates, keyword/source and common-topic retrieval')
                    stage = 'restart and retrieve originals'
                    before = call('/api/memos', token=token)['memos']
                    assert len(before) == 4
                    content = {memo['name']: memo['content'] for memo in before}
                    stop()
                    start()
                    token = signin('synthetic-owner', password)
                    for item in evidence['sources']:
                        memo = call('/api/' + item['memo'], token=token)
                        assert memo['visibility'] == 'PRIVATE' and memo['content'] == content[item['memo']]
                        attachment = memo['attachments'][0]
                        archive_bytes = call('/file/' + attachment['name'] + '/' + quote(attachment['filename'], safe=''), token=token, raw=True)
                        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                            assert archive.namelist() == [item['filename']]
                            original = archive.read(item['filename'])
                            assert original == originals[item['source']]
                            assert hashlib.sha256(original).hexdigest() == item['sha256']
                        query = urlencode({'filter': f'tag in ["source/{item["tag"]}"] && content.contains("{item["needle"]}")'})
                        matches = call('/api/memos?' + query, token=token).get('memos', [])
                        assert [match['name'] for match in matches] == [item['memo']]
                    shared = urlencode({'filter': 'content.contains("SyntheticSharedTopic")'})
                    assert len(call('/api/memos?' + shared, token=token)['memos']) == 4
                    assert len(call('/api/attachments', token=token)['attachments']) == 4
                    passed('restart preserves all four exact originals and bodies; unique source/keyword and shared topic still find correct records')
                finally:
                    stop()
                    log.flush()
                    (output / 'server.log').write_text(redact((temp / 'server.log').read_text(encoding='utf-8', errors='replace')), encoding='utf-8')
    except Exception as error:
        failure = redact(f'{type(error).__name__}: {error}')
        checks.append({'check': stage, 'status': 'blocked' if stage in ('setup', 'temporary server startup') else 'failed', 'error': failure})
    report = {'status': checks[-1]['status'] if failure else 'passed', 'kind': 'actual frontend modules and HTTP/SQLite; no browser',
              'binary_sha256': binary_hash, 'html_worker_sha256': worker_hash, 'model_executed': False,
              'checks': checks, 'sources': evidence,
              'limitations': ['Connect-to-REST adapter and Node worker scheduler; no browser, responsive UI or real device acceptance',
                              'Audio is four-second zero PCM with authored synthetic manual text, not speech transcription',
                              'This sequential walkthrough does not prove concurrency safety; dedicated transaction tests cover supported SQLite entries only',
                              'All input synthetic; no external website or chat account access']}
    (output / 'multisource-http.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if failure else 0


if __name__ == '__main__':
    raise SystemExit(run())
