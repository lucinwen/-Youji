"""Real SQLite/HTTP private-source picker acceptance, including old-binary migration.
MOTEARY_BINARY=build/youji YOUJI_BASELINE_BINARY=/trusted/pr23/youji python3 tests/moteary/run_source_picker_e2e.py
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
OUT = Path(os.environ.get('YOUJI_PICKER_QA_OUTPUT', '/tmp/youji-source-picker-validation'))
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
        env = {k: os.environ[k] for k in ('SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH') if k in os.environ}
        env['LANG'] = 'C.UTF-8'
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
            def create(text, visibility='PRIVATE', auth=None):
                return request('/api/memos',{'content':text,'visibility':visibility},auth or token)['name']
            def change(name,field,value):
                return request('/api/'+name+'?'+urlencode({'updateMask':field}),{'name':name,field:value},token,'PATCH')
            keyword='SyntheticPickerNeedle'
            review=create('# 虚构复盘\n'+keyword+' 预算未确认。')
            first=create('# 岗位简报\n'+keyword+' 第一份。HiddenBodyNeedleA')
            second=create('# 岗位简报\n'+keyword+' 第二份。HiddenBodyNeedleB')
            change(first,'create_time','2026-11-10T12:00:00Z')
            change(second,'create_time','2026-11-14T12:00:00Z')
            request('/api/youji/'+first+'/dates',{'eventDate':'2026-10-10'},token,'PATCH')
            request('/api/youji/'+second+'/dates',{'eventDate':'2026-10-14'},token,'PATCH')
            foreign=create('# 外账户\n'+keyword,auth=other_token)
            public=create('# 公开\n'+keyword,'PUBLIC')
            protected=create('# 受保护\n'+keyword,'PROTECTED')
            archived=create('# 归档\n'+keyword);change(archived,'state','ARCHIVED')
            long_note=create('# 长资料标题\n'+'x'*2200+' TailOnlyNeedle')
            more=[create('# 虚构干扰资料 '+str(i)+'\n'+keyword) for i in range(23)]
            change(first,'update_time','2026-11-15T12:00:00Z')
            change(second,'content','# 岗位简报\n'+keyword+' 错误版本，虽然最后编辑更晚。HiddenBodyNeedleB')
            expected=set([first,second]+more)
            stop();start(BINARY)
            token=login('synthetic-owner',password);other_token=login('synthetic-other',other_password)
            route='/api/youji/'+review+'/source/candidates'
            def page(q=keyword,next_='',size=2,auth=None):
                return request(route+'?'+urlencode({'q':q,'pageToken':next_,'pageSize':size}),token=auth or token)
            got=[];next_='';pages=0
            while True:
                value=page(next_=next_);pages+=1
                assert len(value['candidates'])<=2
                for row in value['candidates']:
                    assert set(row)=={'name','label','eventDate','createdAt'},row
                    assert len(row['label'])<=120
                    assert 'HiddenBodyNeedle' not in json.dumps(row)
                got.extend(value['candidates']);next_=value['nextPageToken']
                if not next_:break
                assert pages<30
            assert {row['name'] for row in got}==expected and len(got)==len(expected)
            byname={row['name']:row for row in got}
            assert byname[first]['label']==byname[second]['label']
            assert byname[first]['eventDate']=='2026-10-10' and byname[second]['eventDate']=='2026-10-14'
            assert byname[first]['createdAt']!=byname[second]['createdAt']
            passed('25 candidates across real pages: same-title dates distinguish, review/foreign/public/protected/archived excluded, minimal fields only')
            assert not page('missing-unique-term')['candidates']
            assert not page('x") || true || ("')['candidates']
            # Body search should find a unique term while returning only a label, never the matching body.
            bodymatch=page('HiddenBodyNeedleA')['candidates'];assert [r['name'] for r in bodymatch]==[first]
            assert 'HiddenBodyNeedleA' not in json.dumps(bodymatch)
            tailmatch=page('TailOnlyNeedle')['candidates']
            assert [r['name'] for r in tailmatch]==[long_note]
            assert 'TailOnlyNeedle' not in json.dumps(tailmatch)
            passed('literal keyword injection stays empty; body keyword beyond label prefix matches without returning body')
            for auth in [None,other_token,'synthetic-invalid-token']:
                denied({401,403,404},route+'?q='+keyword,token=auth)
            # User parameters cannot broaden server-owned scope.
            try:
                overridden=request(route+'?'+urlencode({'q':keyword,'creator':other,'filter':'true','pageSize':20}),token=token)
                assert all(r['name'] in expected for r in overridden['candidates'])
            except HTTPError as e:
                assert e.code == 400
            denied({400},route+'?'+urlencode({'q':'x'*201}),token=token)
            denied({400},route+'?pageToken=invalid',token=token)
            passed('candidate endpoint rejects foreign review and invalid login; extra client creator/filter cannot broaden visibility')
            assert request('/api/'+second,token=token)['updateTime'] > request('/api/'+first,token=token)['updateTime']
            association='/api/youji/'+review+'/source'
            request(association,{'sourceName':first},token,'PATCH')
            assert request(association,token=token)['sourceName']==first
            page('HiddenBodyNeedleB')
            change(second,'create_time','2030-01-01T12:00:00Z')
            assert page()['candidates'][0]['name']==second
            assert request(association,token=token)['sourceName']==first
            stop();start(BINARY);token=login('synthetic-owner',password)
            assert request(association,token=token)['sourceName']==first
            change(first,'content','# 岗位简报\n'+keyword+' 正确条目的当前纠正正文；不是历史快照。HiddenBodyNeedleA')
            assert '当前纠正正文' in request(association+'/open',token=token)['content']
            request(association,{'sourceName':None},token,'PATCH')
            passed('wrong same-title version edited latest: explicit correct event-date ID survives query/reorder/restart and opens current body, not snapshot')
            selected=first
            change(selected,'visibility','PUBLIC')
            assert selected not in {r['name'] for r in page('HiddenBodyNeedleA')['candidates']}
            denied({409},'/api/youji/'+review+'/source',{'sourceName':selected},token,'PATCH')
            assert request('/api/youji/'+review+'/source',token=token)=={'status':'none'}
            request('/api/youji/'+review+'/source',{'sourceName':second},token,'PATCH')
            assert request('/api/youji/'+review+'/source/open',token=token)['content'].endswith('HiddenBodyNeedleB')
            request('/api/'+second,token=token,method='DELETE')
            assert request('/api/youji/'+review+'/source',token=token)=={'status':'unavailable'}
            assert request('/api/youji/'+review+'/source/open',token=token)=={'status':'unavailable'}
            assert not page('HiddenBodyNeedleB')['candidates']
            passed('selection is not authorization: permission change before save rejected; live selection opens freshly then deletion neutral')
            change(review,'visibility','PUBLIC');denied({404},route,token=token);change(review,'visibility','PRIVATE')
            stop();start(BINARY);token=login('synthetic-owner',password)
            assert request('/api/youji/'+review+'/source',token=token)=={'status':'unavailable'}
            assert not page('HiddenBodyNeedleB')['candidates']
            passed('review privacy required; restart preserves unavailable association without old label/body')
            stop()
    result['status']='passed'
except Exception as e:
    result['status']='failed';result['error']=type(e).__name__+': '+str(e)
finally:
    stop()
    (OUT/'source-picker-http.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))
if result['status']!='passed':raise SystemExit(1)
