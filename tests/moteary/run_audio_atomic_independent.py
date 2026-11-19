"""Independent synthetic binary WAV + authored manual transcript real HTTP/SQLite atomic-import checks; no browser, build or model.

Run only against a trusted final binary via MOTEARY_BINARY (default build/youji).
Response loss deliberately discards a successful HTTP response after commit; it
does not simulate an interrupted network or prove every crash recovery case.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import struct
import threading
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import wave
import zipfile


def run():
    root = Path(__file__).resolve().parents[2]
    binary = Path(os.environ.get('MOTEARY_BINARY', root / 'build/youji')).resolve()
    output = Path(os.environ.get('YOUJI_AUDIO_ATOMIC_INDEPENDENT_OUTPUT', root / 'validation/audio-atomic-demo-20261119/independent'))
    output.mkdir(parents=True, exist_ok=True)
    checks, secrets_used = [], []
    stage, failure, server, binary_hash = 'setup', None, None, None

    def redact(value):
        for secret in secrets_used:
            value = value.replace(secret, '[REDACTED]')
        return re.sub(r'(?i)Bearer\s+[^\s\"\',;]+', 'Bearer [REDACTED]', value)

    def passed(name):
        checks.append({'check': name, 'status': 'passed'})

    def name(value):
        return value['name'] if isinstance(value, dict) else value

    try:
        with binary.open('rb') as source:
            digest = hashlib.sha256()
            while block := source.read(1024 * 1024):
                digest.update(block)
            binary_hash = digest.hexdigest()
        with tempfile.TemporaryDirectory(prefix='youji-audio-atomic-independent-') as directory:
            temp = Path(directory)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            env = {k: v for k, v in os.environ.items() if not k.startswith(('YOUJI_', 'MEMOS_'))}

            def request(path, body=None, token=None, method=None, raw=False, discard=False):
                headers = {'Content-Type': 'application/json'}
                if token:
                    headers['Authorization'] = 'Bearer ' + token
                data = json.dumps(body).encode() if body is not None else None
                with urlopen(Request(base + path, data, headers, method=method), timeout=30) as response:
                    payload = response.read()
                    if discard:
                        return None
                    return payload if raw else json.loads(payload or b'{}')

            def denied(code, *args, **kwargs):
                try:
                    request(*args, **kwargs)
                except HTTPError as error:
                    assert error.code in code, f'Expected {code}, got {error.code}'
                    return
                raise AssertionError('Request unexpectedly succeeded')

            def account(username):
                password = secrets.token_urlsafe(24)
                secrets_used.append(password)
                owner = request('/api/users', {'username': username, 'password': password})['name']
                return owner, signin(username, password), password

            def signin(username, password):
                token = request('/api/auth/signin', {'passwordCredentials': {'username': username, 'password': password}})['accessToken']
                secrets_used.append(token)
                return token

            def counts(expected):
                databases = list(temp.glob('*.db'))
                assert len(databases) == 1, 'Expected one isolated SQLite database'
                with sqlite3.connect(f'file:{databases[0]}?mode=ro', uri=True) as db:
                    actual = tuple(db.execute(sql).fetchone()[0] for sql in (
                        'SELECT count(*) FROM memo',
                        'SELECT count(*) FROM attachment',
                        'SELECT count(*) FROM attachment WHERE memo_id IS NULL OR memo_id NOT IN (SELECT id FROM memo)',
                        'SELECT count(*) FROM attachment WHERE blob IS NULL OR length(blob)=0',
                    ))
                assert actual == (expected, expected, 0, 0), f'Unexpected memo/attachment/orphan/empty-BLOB counts: {actual}'

            def payload(owner, raw):
                return {'owner': owner, 'filename': 'independent-audio.wav',
                        'content': '#拾微 #source/podcast\n合成人工稿（不是音频转写）：不同意立即发布；资料不足，不应声称已获批准。',
                        'data': base64.b64encode(raw).decode('ascii')}

            def verify(receipt, token, original):
                memo = request('/api/' + name(receipt['memo']), token=token)
                assert memo['visibility'] == 'PRIVATE'
                assert memo['content'] == '#拾微 #source/podcast\n合成人工稿（不是音频转写）：不同意立即发布；资料不足，不应声称已获批准。'
                assert len(memo['attachments']) == 1
                attachment = memo['attachments'][0]
                assert attachment['name'] == name(receipt['attachment'])
                assert receipt['sha256'] == hashlib.sha256(original).hexdigest()
                url = '/file/' + attachment['name'] + '/' + quote(attachment['filename'], safe='')
                archive_bytes = request(url, token=token, raw=True)
                with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                    assert archive.namelist() == ['independent-audio.wav']
                    assert archive.read('independent-audio.wav') == original
                return url

            with (temp / 'server.log').open('w') as log:
                def start():
                    nonlocal server
                    server = subprocess.Popen([str(binary), '--addr', '127.0.0.1', '--port', str(port),
                                               '--data', directory, '--driver', 'sqlite', '--dsn', '',
                                               '--unix-sock', '', '--config-apply', 'off'],
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
                    stage = 'account setup'
                    account('synthetic-admin')
                    owner, token, password = account('synthetic-owner')
                    other, other_token, other_password = account('synthetic-other')
                    endpoint = '/api/youji/audio-original/import'
                    def synthetic_wav(amplitude):
                        buffer = io.BytesIO()
                        with wave.open(buffer, 'wb') as wav:
                            wav.setnchannels(1)
                            wav.setsampwidth(2)
                            wav.setframerate(16000)
                            wav.writeframes(b''.join(struct.pack('<h', amplitude if (i // 32) % 2 else -amplitude)
                                                     for i in range(16000 * 4)))
                        return buffer.getvalue()

                    original = synthetic_wav(1000)
                    with wave.open(io.BytesIO(original), 'rb') as wav:
                        assert wav.getnframes() == 64000 and wav.getframerate() == 16000
                        assert wav.getnchannels() == 1 and wav.getsampwidth() == 2
                    try:
                        original.decode('utf-8')
                    except UnicodeDecodeError:
                        pass
                    else:
                        raise AssertionError('Synthetic WAV must contain non-UTF-8 binary bytes')
                    body = payload(owner, original)
                    stage = 'eight concurrent identical imports'
                    barrier = threading.Barrier(8)

                    def concurrent_import(_):
                        barrier.wait(timeout=15)
                        return request(endpoint, body, token)

                    with ThreadPoolExecutor(max_workers=8) as pool:
                        results = list(pool.map(concurrent_import, range(8)))
                    assert [r['status'] for r in results].count('imported') == 1
                    assert [r['status'] for r in results].count('verified') == 7
                    assert len({name(r['memo']) for r in results}) == 1
                    assert len({name(r['attachment']) for r in results}) == 1
                    counts(1)
                    first = results[0]
                    identity = json.dumps(['audio-v1', owner, hashlib.sha256(original).hexdigest(), 'independent-audio.wav'],
                                          ensure_ascii=False, separators=(',', ':')).encode()
                    assert name(first['memo']) == 'memos/mwa-' + hashlib.sha256(identity).hexdigest()[:30]
                    assert name(first['attachment']) == 'attachments/yma-' + hashlib.sha256(identity).hexdigest()[:30]
                    url = verify(first, token, original)
                    passed('8 concurrent POSTs: exactly 1 imported + 7 verified, 1 memo, 1 DB ZIP BLOB, zero unlinked attachments; PRIVATE and original bytes')
                    stage = 'owner isolation and immutable original conflict'
                    denied({401}, endpoint, body)
                    denied({403}, endpoint, {**body, 'owner': other}, token)
                    second = request(endpoint, payload(other, original), other_token)
                    assert second['status'] == 'imported'
                    assert name(second['memo']) != name(first['memo'])
                    verify(second, other_token, original)
                    counts(2)
                    denied({401, 403, 404}, url, raw=True)
                    denied({403, 404}, url, token=other_token, raw=True)
                    denied({403, 404}, '/api/' + name(first['memo']), token=other_token)
                    denied({403, 404}, '/api/' + name(first['memo']) + '?updateMask=content',
                           {'name': name(first['memo']), 'content': '不应成功的跨账户改写'}, other_token, method='PATCH')
                    denied({409}, endpoint, {**body, 'content': body['content'] + '\nChanged'}, token)
                    verify(first, token, original)
                    counts(2)
                    passed('same original separated by owner; forged owner and cross-account/anonymous access denied; changed content rejected without overwrite')
                    stage = 'committed response discarded then retried'
                    lost_raw = synthetic_wav(1200)
                    lost_body = payload(owner, lost_raw)
                    request(endpoint, lost_body, token, discard=True)
                    counts(3)
                    recovered = request(endpoint, lost_body, token)
                    assert recovered['status'] == 'verified'
                    verify(recovered, token, lost_raw)
                    counts(3)
                    passed('successful response deliberately discarded after commit; retry verified, no duplicate rows')
                    stage = 'edited record retry conflict'
                    memo_name = name(recovered['memo'])
                    edited = '人工修订：仍未批准发布，不得删除否定语义。'
                    request('/api/' + memo_name + '?updateMask=content', {'name': memo_name, 'content': edited}, token, method='PATCH')
                    denied({409}, endpoint, lost_body, token)
                    assert request('/api/' + memo_name, token=token)['content'] == edited
                    counts(3)
                    passed('owner edit preserved and subsequent identical-original retry returns 409')
                    stage = 'restart and deletion'
                    stop()
                    start()
                    token = signin('synthetic-owner', password)
                    other_token = signin('synthetic-other', other_password)
                    verify(first, token, original)
                    verify(second, other_token, original)
                    assert request(endpoint, body, token)['status'] == 'verified'
                    assert request('/api/' + memo_name, token=token)['content'] == edited
                    counts(3)
                    passed('restart preserves originals, owner edit, private access and idempotent receipt')
                    for receipt, auth in ((first, token), (recovered, token), (second, other_token)):
                        request('/api/' + name(receipt['memo']), token=auth, method='DELETE')
                    counts(0)
                    denied({404}, url, token=token, raw=True)
                    stop()
                    start()
                    token = signin('synthetic-owner', password)
                    counts(0)
                    denied({404}, url, token=token, raw=True)
                    passed('deletion removes live memo and BLOB attachment rows and remains deleted after restart')
                    stage = 'serial exact 16 MiB WAV original import under unchanged default quotas'
                    # Standard PCM WAV header is 44 bytes. Only generate and inspect
                    # container metadata; no decoding, playback or model execution.
                    target_bytes = 16 * 1024 * 1024
                    large_buffer = io.BytesIO()
                    with wave.open(large_buffer, 'wb') as wav:
                        wav.setnchannels(1)
                        wav.setsampwidth(2)
                        wav.setframerate(16000)
                        wav.writeframes(struct.pack('<h', -1000) * ((target_bytes - 44) // 2))
                    large_raw = large_buffer.getvalue()
                    assert len(large_raw) == target_bytes
                    with wave.open(io.BytesIO(large_raw), 'rb') as wav:
                        assert wav.getnframes() == (target_bytes - 44) // 2
                        assert wav.getframerate() == 16000 and wav.getsampwidth() == 2
                    large_receipt = request(endpoint, payload(owner, large_raw), token)
                    assert large_receipt['status'] == 'imported'
                    counts(1)
                    large_url = verify(large_receipt, token, large_raw)
                    request('/api/' + name(large_receipt['memo']), token=token, method='DELETE')
                    counts(0)
                    denied({404}, large_url, token=token, raw=True)
                    passed('serial exact 16 MiB binary WAV: HTTP save, private ZIP download bytes and SHA-256 match, then deletion; default quotas unchanged')
                    checks[-1].update(original_bytes=target_bytes,
                                      original_sha256=hashlib.sha256(large_raw).hexdigest(),
                                      pcm_frames=(target_bytes - 44) // 2, decoded=False, played=False)
                finally:
                    stop()
                    log.flush()
                    (output / 'server.log').write_text(redact((temp / 'server.log').read_text(errors='replace')))
    except Exception as error:
        failure = redact(f'{type(error).__name__}: {error}')
        checks.append({'check': stage, 'status': 'blocked' if stage in ('setup', 'temporary server startup') else 'failed', 'error': failure})
    report = {'status': checks[-1]['status'] if failure else 'passed', 'kind': 'real HTTP and isolated SQLite; no browser',
              'binary_sha256': binary_hash, 'model_executed': False, 'checks': checks,
              'limitations': ['Client discards one completed response; not an actual network interruption or crash during transaction',
                              'SQLite only; other database drivers not exercised',
                             'Synthetic PCM WAVs (four seconds and exact 16 MiB) plus authored negative statements; no decoding, ASR, speech accuracy, playback or browser validation',
                              'Deletion checks live rows, not physical erasure or backups']}
    (output / 'audio-atomic-independent.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if failure else 0


if __name__ == '__main__':
    raise SystemExit(run())
