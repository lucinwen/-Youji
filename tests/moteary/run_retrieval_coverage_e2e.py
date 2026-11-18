"""Real HTTP/SQLite + local ONNX challenge. Not a browser or general recall study."""
import hashlib
import concurrent.futures
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
output = Path(os.environ.get('YOUJI_RETRIEVAL_COVERAGE_OUTPUT', root / 'validation/retrieval-coverage-20261118'))
output.mkdir(parents=True, exist_ok=True)
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
            endpoint = 'youji/retrieval/search'
            denied('youji/retrieval/processor',None,None,401)
            denied(endpoint,{'query':'synthetic anonymous request'},None,401)
            assert call('youji/retrieval/processor',token=token)['available']
            checks.append({'check':'anonymous health/search rejected; complete hashes pass for configured read-only model','passed':True})
            query = 'Cobalt seed archive returned to the harbor office'
            def search(offset=0, snapshot=None, who=None, q=query, filter=''):
                body = {'query':q,'filter':filter,'offset':offset}
                if snapshot is not None: body['snapshot']=snapshot
                start=time.monotonic()
                result=call(endpoint,body,who or token)
                results.append({'offset':offset,'scanned':result['scanned'],'total':result['total'],'seconds':round(time.monotonic()-start,3)})
                for hit in result['hits']:
                    assert hit['excerpt'] in call(hit['name'],token=who or token)['content']
                return result
            target=call('memos',{'content':'#拾微 #work #source/text\n\n'+query,'visibility':'PRIVATE'},token)
            call(target['name']+'?updateMask=create_time',{'name':target['name'],'createTime':'2000-01-01T00:00:00Z'},token,method='PATCH')
            distractors=[]
            for i in range(125):
                # Respect the real 120 writes/minute account budget.
                time.sleep(.52)
                memo=call('memos',{'content':f'#拾微 #work #source/text\n\nSynthetic coverage distractor {i}: ordinary paper inventory and storage boxes.','visibility':'PRIVATE'},token)
                assert f'distractor {i}:' in memo['content']
                distractors.append(memo['name'])
            call('memos',{'content':query,'visibility':'PUBLIC'},other)
            first=search()
            assert first['total']==126 and first['offset']==0 and first['scanned']==100 and first['nextOffset']==100
            assert first['candidateTruncated'] and not first['metadataTruncated']
            assert target['name'] not in [h['name'] for h in first['hits']]
            second=search(first['nextOffset'],first['snapshot'])
            assert second['offset']==100 and second['scanned']==126 and 'nextOffset' not in second
            assert target['name'] in [h['name'] for h in second['hits']]
            assert not second['candidateTruncated'] and second['skipped']==0
            checks.append({'check':'126 real records: target older than first100 reachable in second batch with exact coverage','passed':True})
            denied(endpoint,{'query':query,'offset':100,'snapshot':first['snapshot']},other,409)
            denied(endpoint,{'query':'different query','offset':100,'snapshot':first['snapshot']},token,409)
            assert not search(filter=f'creator == "{other_owner}"')['hits']
            checks.append({'check':'continuation cannot cross account or query; forged creator remains empty','passed':True})
            inserted=call('memos',{'content':'New synthetic record changes the candidate list.','visibility':'PRIVATE'},token)
            denied(endpoint,{'query':query,'offset':100,'snapshot':first['snapshot']},token,409)
            restarted=search()
            assert restarted['total']==127
            call(distractors[-1],token=token,method='DELETE')
            denied(endpoint,{'query':query,'offset':100,'snapshot':restarted['snapshot']},token,409)
            checks.append({'check':'insert and delete invalidate old continuation; fresh start sees current count','passed':True})
            # Controlled pause after genuine server candidate capture; then real
            # ONNX inference runs. This is deterministic boundary fault injection.
            marker=Path(directory)/'candidate-ready'
            release=Path(directory)/'candidate-release'
            wrapper=Path(directory)/'controlled-worker.py'
            wrapper.write_text('import io,runpy,sys,time\nfrom pathlib import Path\nraw=sys.stdin.buffer.read()\n'+
                f'Path({str(marker)!r}).write_text("ready")\ndeadline=time.monotonic()+10\n'+
                f'while not Path({str(release)!r}).exists():\n if time.monotonic()>deadline: sys.exit(7)\n time.sleep(.01)\n'+
                f'sys.stdin=io.TextIOWrapper(io.BytesIO(raw))\nrunpy.run_path({str(root / "moteary/retrieval_worker.py")!r},run_name="__main__")\n')
            def restart(next_env):
                global server, token
                server.terminate();server.wait(timeout=10)
                server=subprocess.Popen([str(binary),'--addr','127.0.0.1','--port',str(port),'--data',directory,'--config-apply','off'],env=next_env,stdout=log,stderr=log)
                for _ in range(100):
                    try: urlopen(base,timeout=1).close();break
                    except OSError: time.sleep(.1)
                token=call('auth/signin',{'passwordCredentials':{'username':'synthetic-owner','password':secrets_used[2]}})['accessToken']
                secrets_used.append(token)
            restart({**env,'YOUJI_RETRIEVAL_WORKER':str(wrapper)})
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                pending=pool.submit(call,endpoint,{'query':query},token)
                for _ in range(300):
                    if marker.exists():break
                    time.sleep(.01)
                assert marker.exists(), 'worker did not capture candidate input'
                call(inserted['name']+'?updateMask=content',{'name':inserted['name'],'content':'Changed synthetic body after candidate capture.'},token,method='PATCH')
                release.write_text('continue')
                try:
                    pending.result(timeout=65)
                    raise AssertionError('stale in-flight response accepted')
                except HTTPError as error: assert error.code==409
            checks.append({'check':'real ONNX after controlled candidate-capture pause rejects concurrent edit even outside top hits','passed':True})
            restart(env)
            page=search()
            final=search(page['nextOffset'],page['snapshot'])
            assert target['name'] in [h['name'] for h in final['hits']]
            call(target['name'],token=token,method='DELETE')
            denied(endpoint,{'query':query,'offset':100,'snapshot':page['snapshot']},token,409)
            page=search()
            last=search(page['nextOffset'],page['snapshot'])
            assert target['name'] not in [h['name'] for h in last['hits']]
            checks.append({'check':'restart retains continuation behavior; deleted old target cannot reappear on later batch','passed':True})
            corrupt=Path(directory)/'corrupt-model';corrupt.mkdir()
            for name in ['model_qint8_avx512_vnni.onnx','tokenizer.json']:
                (corrupt/name).symlink_to(model/name)
            (corrupt/'config.json').write_text('{"synthetic":"corruption"}')
            restart({**env,'YOUJI_RETRIEVAL_MODEL':str(corrupt)})
            denied('youji/retrieval/processor',None,token,503)
            denied(endpoint,{'query':query},token,503)
            assert call(inserted['name'],token=token)['content']=='Changed synthetic body after candidate capture.'
            checks.append({'check':'complete model hash check rejects tampered config in GET and POST; stored records remain readable','passed':True})
            report={'kind':'real SQLite/HTTP and ONNX, controlled pause explicitly labeled; no browser','checks':checks,'requests':results,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'limit_note':'126 real records;5000 metadata cap exercised by unit tests, not a 5000-record load benchmark'}
            (output/'coverage-http.json').write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report,indent=2))
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
