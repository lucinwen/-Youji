"""Synthetic offline HTML, real HTTP/SQLite and frontend module. No model execution."""
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
import zipfile

root = Path(__file__).resolve().parents[2]
binary = Path(os.environ.get('MOTEARY_BINARY', root / 'build/youji')).resolve()
output = Path(os.environ.get('YOUJI_HTML_QA_OUTPUT', root / 'validation/html-workspace-20261118'))
output.mkdir(parents=True, exist_ok=True)
checks, secrets_used = [], []
worker_evidence = None
with tempfile.TemporaryDirectory(prefix='youji-html-qa-') as directory:
    temp = Path(directory)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = {key:value for key,value in os.environ.items() if not key.startswith('YOUJI_')}
    fixture = temp / 'synthetic-page.html'
    fixture.write_text('<!doctype html><html><head><title>合成网页标题</title><meta name="author" content="合成作者"><link rel="canonical" href="https://example.invalid/synthetic-source"></head><body><nav>导航不应成为正文</nav><article><h1>本地网页</h1><p>HTMLSourceNeedle 中英 original content &lt;literal&gt;。</p><table><tr><td>10</td><td>20</td></tr></table></article><script>SCRIPT_EXECUTED</script></body></html>',encoding='utf-8')
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
            for name in ['parse5-LICENSE','entities-LICENSE']:
                with urlopen(base+'/licenses/'+name+'.txt',timeout=10) as response:
                    assert response.read()==(root/'moteary/licenses'/name).read_bytes()
            checks.append({'check':'embedded parser license texts served byte-for-byte from the built binary','passed':True})
            account('synthetic-admin');owner,token,password=account('synthetic-owner');_,other,_=account('synthetic-other')
            reject('memos',status=401)
            checks.append({'check':'anonymous memo access denied; local HTML preview requires no processor','passed':True})
            assets = list((root/'server/frontend/dist/assets').glob('html.worker-*.js'))
            assert len(assets)==1, 'build the production frontend first; expected one HTML worker asset'
            config={'base':base,'token':token,'owner':owner,'otherToken':other,'fixture':str(fixture),'workerAsset':str(assets[0]),'workerEvidence':str(temp/'worker-evidence.json')}
            result=subprocess.run(['pnpm','exec','vitest','run','tests/moteary-html-http.test.ts','--maxWorkers=1'],cwd=root/'web',env={**os.environ,'YOUJI_HTML_WEB_QA':json.dumps(config)},capture_output=True,text=True,timeout=280)
            text=result.stdout+result.stderr
            for value in secrets_used: text=text.replace(value,'[REDACTED]')
            (output/'web-module-http.log').write_text(text)
            checks.append({'check':'actual HTML TypeScript module uses real API: save/retry/response-loss recovery/search/account isolation/delete','passed':result.returncode==0,'returncode':result.returncode})
            if result.returncode: raise RuntimeError('HTML module harness failed; see sanitized log')
            worker_evidence=json.loads((temp/'worker-evidence.json').read_text())
            assert worker_evidence['trap_requests']==0 and worker_evidence['cancelled_after_start'] and worker_evidence['workers']==3
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
                assert archive.namelist()==['合成网页.html']
                assert archive.read('合成网页.html')==fixture.read_bytes()
            call(name,token=token,method='DELETE')
            assert not call('memos',token=token).get('memos') and not call('attachments',token=token).get('attachments')
            checks.append({'check':'restart preserves HTML memo and original; final deletion removes memo and attachment rows','passed':True})
        finally:
            if server is not None and server.poll() is None: server.terminate();server.wait(timeout=10)
            log.flush();text=(temp/'server.log').read_text()
            for value in secrets_used:text=text.replace(value,'[REDACTED]')
            (output/'server.log').write_text(text)
            report={'kind':'real HTTP/SQLite and actual frontend module; not browser','model_executed':False,'worker_evidence':worker_evidence,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'checks':checks}
            (output/'html-http.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            print(json.dumps(report,ensure_ascii=False,indent=2))
