"""Real local ASR/HTTP/SQLite and TypeScript module; not browser acceptance.
Optional YOUJI_AUDIO_REAL_FIXTURE must point to a licensed/nonpersonal WAV.
"""
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
from urllib.request import Request, urlopen
import wave
import zipfile

root = Path(__file__).resolve().parents[2]
binary = Path(os.environ.get('MOTEARY_BINARY', root / 'build/youji')).resolve()
python = Path(os.environ.get('YOUJI_AUDIO_PYTHON', '/tmp/youji-asr-venv/bin/python')).absolute()
model = Path(os.environ.get('YOUJI_AUDIO_MODEL', '/tmp/youji-asr-base')).resolve()
output = Path(os.environ.get('YOUJI_AUDIO_QA_OUTPUT', root / 'validation/audio-workspace-20261118'))
output.mkdir(parents=True, exist_ok=True)
run_model = os.environ.get('YOUJI_AUDIO_RUN_MODEL') == '1'
real = os.environ.get('YOUJI_AUDIO_REAL_FIXTURE') if run_model else None
checks, secrets_used = [], []
with tempfile.TemporaryDirectory(prefix='youji-audio-qa-') as directory:
    temp = Path(directory)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = {key:value for key,value in os.environ.items() if not key.startswith('YOUJI_AUDIO_')}
    if run_model:
        env.update({'YOUJI_AUDIO_PYTHON': str(python), 'YOUJI_AUDIO_WORKER': str(root / 'moteary/audio_worker.py'), 'YOUJI_AUDIO_MODEL': str(model)})
    def wav(seconds):
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\0\0' * 16000 * seconds)
        return buffer.getvalue()
    fixture = temp / 'synthetic-silence.wav'; fixture.write_bytes(wav(4))
    with (temp / 'server.log').open('w') as log:
        server = None
        def start():
            global server
            server = subprocess.Popen([str(binary), '--addr','127.0.0.1','--port',str(port),'--data',directory,'--config-apply','off'],env=env,stdout=log,stderr=log)
            for _ in range(100):
                try: urlopen(base,timeout=1).close();return
                except OSError:
                    if server.poll() is not None: raise RuntimeError('test server exited')
                    time.sleep(.1)
            raise RuntimeError('test server not ready')
        def call(path, body=None, token=None, raw=False, method=None):
            headers={'Content-Type':'application/octet-stream' if raw else 'application/json'}
            if token: headers['Authorization']='Bearer '+token
            data=body if raw else (json.dumps(body).encode() if body is not None else None)
            with urlopen(Request(base+'/api/'+path,data,headers,method=method),timeout=200) as response:
                assert 'no-store' in response.headers.get('Cache-Control','')
                return json.load(response)
        def reject(path, body=None, token=None, raw=False, status=422):
            try: call(path,body,token,raw); raise AssertionError('unexpected success')
            except HTTPError as error:
                assert error.code==status,(path,error.code,error.read())
                return json.load(error)
        def account(name):
            password=secrets.token_urlsafe(24);secrets_used.append(password)
            owner=call('users',{'username':name,'password':password})['name']
            token=call('auth/signin',{'passwordCredentials':{'username':name,'password':password}})['accessToken'];secrets_used.append(token)
            return owner,token,password
        try:
            start()
            account('synthetic-admin');owner,token,password=account('synthetic-owner');_,other,_=account('synthetic-other')
            reject('youji/audio/processor',status=401)
            reject('youji/audio/transcribe',fixture.read_bytes(),raw=True,status=401)
            if run_model:
                health=call('youji/audio/processor',token=token)
                assert health['available']
                checks.append({'check':'anonymous routes denied; real model/dependency verification available','passed':True})
                assert reject('youji/audio/transcribe',fixture.read_bytes(),token,True)['error']=='no_speech'
                assert reject('youji/audio/transcribe',b'broken synthetic audio',token,True)['error']=='invalid_audio'
                assert reject('youji/audio/transcribe',wav(121),token,True)['error']=='too_long'
                assert not call('memos',token=token).get('memos') and not call('attachments',token=token).get('attachments')
                checks.append({'check':'actual worker rejects silence, corruption, overlong WAV and preview persists nothing','passed':True})
                # Real TCP disconnect while a partial request owns the single slot.
                conn=socket.create_connection(('127.0.0.1',port),timeout=5)
                try:
                    conn.sendall((f'POST /api/youji/audio/transcribe HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/octet-stream\r\nContent-Length: 100000\r\n\r\n').encode()+b'RIFF')
                    time.sleep(.4)
                    reject('youji/audio/processor',token=token,status=429)
                finally: conn.close()
                for _ in range(30):
                    try:
                        if call('youji/audio/processor',token=token)['available']: break
                    except HTTPError as error:
                        if error.code!=429: raise
                        time.sleep(.1)
                else: raise AssertionError('slot not released')
                checks.append({'check':'actual incomplete TCP upload occupies slot; disconnect releases it','passed':True})
            else:
                reject('youji/audio/processor',token=token,status=503)
                reject('youji/audio/transcribe',fixture.read_bytes(),token,True,status=503)
                checks.append({'check':'anonymous audio routes denied; unconfigured model returns explicit 503 without persisting data','passed':True})
            config={'base':base,'token':token,'owner':owner,'otherToken':other,'fixture':str(fixture)}
            if real: config['realFixture']=str(Path(real).resolve())
            result=subprocess.run(['pnpm','exec','vitest','run','tests/moteary-audio-http.test.ts','--maxWorkers=1'],cwd=root/'web',env={**os.environ,'YOUJI_AUDIO_WEB_QA':json.dumps(config)},capture_output=True,text=True,timeout=280)
            text=result.stdout+result.stderr
            for value in secrets_used: text=text.replace(value,'[REDACTED]')
            (output/'web-module-http.log').write_text(text)
            checks.append({'check':'actual audio TypeScript module uses real API: save/retry/response-loss recovery/search/account isolation/delete'+('; licensed real ASR preview/correction/save' if real else '; manual transcript only'),'passed':result.returncode==0,'returncode':result.returncode})
            if result.returncode: raise RuntimeError('audio module harness failed; see sanitized log')
            before=call('memos',token=token)['memos'];assert len(before)==1
            name=before[0]['name'];content=before[0]['content']
            server.terminate();server.wait(timeout=10);start()
            token=call('auth/signin',{'passwordCredentials':{'username':'synthetic-owner','password':password}})['accessToken'];secrets_used.append(token)
            restored=call(name,token=token)
            assert restored['content']==content
            original=restored['attachments'][0]
            from urllib.parse import quote
            with urlopen(Request(base+'/file/'+original['name']+'/'+quote(original['filename']),headers={'Authorization':'Bearer '+token}),timeout=10) as response:
                zipped=response.read()
            with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
                assert archive.namelist()==['合成音频.wav']
                assert archive.read('合成音频.wav')==fixture.read_bytes()
            call(name,token=token,method='DELETE')
            assert not call('memos',token=token).get('memos') and not call('attachments',token=token).get('attachments')
            checks.append({'check':'restart preserves corrected memo and original; final deletion removes memo and attachment rows','passed':True})
        finally:
            if server is not None and server.poll() is None: server.terminate();server.wait(timeout=10)
            log.flush();text=(temp/'server.log').read_text()
            for value in secrets_used:text=text.replace(value,'[REDACTED]')
            (output/'server.log').write_text(text)
            report={'kind':'real HTTP/SQLite and actual frontend module; not browser','model_executed':run_model,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'checks':checks}
            (output/'audio-http.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            print(json.dumps(report,ensure_ascii=False,indent=2))
