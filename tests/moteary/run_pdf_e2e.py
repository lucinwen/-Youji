"""Real PDF extraction, SQLite/HTTP import and recovery checks; no browser.
MOTEARY_BINARY=./build/youji python tests/moteary/run_pdf_e2e.py
"""
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import secrets
import re
import sys
import hashlib
import io
import zipfile
from urllib.error import HTTPError
from urllib.parse import quote
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("source_importer", root / "moteary/import_sources.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
binary = Path(os.environ.get("MOTEARY_BINARY", root / "build/youji")).resolve()
sys.path.insert(0, str(root / 'moteary'))
import import_pdf as pdf
checks = []

with tempfile.TemporaryDirectory(prefix="youji-pdf-") as directory:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    process = None
    with open(Path(directory) / "server.log", "w") as log:
        def start():
            global process
            process = subprocess.Popen([str(binary), "--addr", "127.0.0.1", "--port", str(port), "--data", directory, "--config-apply", "off"], stdout=log, stderr=log)
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError("Isolated server exited before readiness")
                try:
                    with urlopen(base, timeout=1):
                        return
                except OSError:
                    time.sleep(0.1)
            raise RuntimeError("Isolated server did not become ready")

        def stop():
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

        def public(route, body):
            request = Request(base + "/api/" + route, json.dumps(body).encode(), {"Content-Type": "application/json"})
            with urlopen(request, timeout=10) as response:
                return json.load(response)

        def login(username, password):
            token = public("auth/signin", {"passwordCredentials": {"username": username, "password": password}})["accessToken"]
            return module.Client(base, token)

        def account(username):
            password = secrets.token_urlsafe(24)
            user = public("users", {"username": username, "password": password})
            return user["name"], password, login(username, password)

        try:
            start()
            account("synthetic-admin")
            owner, password, client = account("synthetic-owner")
            _, _, other = account("synthetic-other")
            item = module.prepare(root / 'tests/moteary/fixtures/synthetic-chinese.pdf', 'work')
            pages = pdf.extract(item['data'])
            assert '中文检索水杉' in pages[0]['text']
            checks.append({'check': 'real pinned parser extracts Chinese and English with page numbers', 'passed': True})
            receipt = pdf.ingest_pdf(client, item, pages)
            assert receipt['status'] == 'complete' and receipt['textParts'] == 2
            names = [r['name'] for r in receipt['records']]
            for name in names:
                assert client.call('GET', name)['visibility'] == 'PRIVATE'
            checks.append({'check': 'three PRIVATE records saved to real SQLite', 'passed': True})
            query = 'creator == ' + json.dumps(owner) + ' && tag in ["source/file"] && tag in ["work"] && content.contains("中文检索水杉")'
            route = 'memos?' + urlencode({'filter': query})
            found = client.call('GET', route).get('memos', [])
            assert len(found) == 1 and found[0]['name'] == names[1]
            assert names[0] in found[0]['content'] and '第 1 页' in found[0]['content']
            checks.append({'check': 'Chinese keyword/category/source retrieves page text linked to original', 'passed': True})
            original = client.call('GET', names[0])
            attachment = original['attachments'][0]
            url = base + '/file/' + quote(attachment['name'], safe='/') + '/' + quote(attachment['filename'], safe='')
            with client.opener.open(Request(url, headers={'Authorization': 'Bearer ' + client.token})) as response:
                archived = response.read()
            with zipfile.ZipFile(io.BytesIO(archived)) as archive:
                assert archive.namelist() == [item['filename']]
                assert archive.read(item['filename']) == item['data']
            checks.append({'check': 'downloaded original PDF bytes identical', 'passed': True})
            for token in ('', other.token):
                headers = {'Authorization': 'Bearer ' + token} if token else {}
                try:
                    with client.opener.open(Request(url, headers=headers)) as response:
                        raise AssertionError('private original readable')
                except HTTPError as error:
                    assert error.code in (401, 403, 404)
            assert other.call('GET', route).get('memos', []) == []
            for name in names:
                try:
                    other.call('GET', name)
                    raise AssertionError('private record readable')
                except HTTPError as error:
                    assert error.code in (401, 403, 404)
            checks.append({'check': 'second ordinary account and anonymous cannot read original; second account cannot search/read derivatives', 'passed': True})
            retry = pdf.ingest_pdf(client, item, pages)
            assert all(r['status'] == 'already-imported' for r in retry['records'])
            checks.append({'check': 'repeat validates bodies and original archives without duplicate records', 'passed': True})
            # Real successful writes, followed by a simulated client interruption at a record boundary.
            second_item = module.prepare(root / 'tests/moteary/fixtures/synthetic-chinese.pdf', 'diary')
            try:
                pdf.ingest_pdf(client, second_item, pages)
                raise AssertionError('cross-entry duplicate accepted')
            except ValueError as error:
                assert 'existing original' in str(error)
            checks.append({'check': 'same PDF with changed category refused before upload', 'passed': True})
            recovery_data = item['data'] + b'\n% synthetic recovery variant\n'
            recovery_item = {**item, 'data': recovery_data, 'sha256': hashlib.sha256(recovery_data).hexdigest(), 'id': 'mw-synthetic-recovery'}
            recovery_pages = pdf.extract(recovery_data)
            class InterruptAtBoundary:
                def __init__(self):
                    self.count = 0
                def call(self, *args, **kwargs):
                    return client.call(*args, **kwargs)
                def ingest(self, record):
                    self.count += 1
                    if self.count == 3:
                        raise RuntimeError('synthetic client interruption before third record')
                    return client.ingest(record)
            try:
                pdf.ingest_pdf(InterruptAtBoundary(), recovery_item, recovery_pages)
                raise AssertionError('interruption missing')
            except RuntimeError as error:
                assert '2/3 verified' in str(error)
            recovered = pdf.ingest_pdf(client, recovery_item, recovery_pages)
            assert [r['status'] for r in recovered['records']] == ['already-imported', 'already-imported', 'imported']
            checks.append({'check': 'real partial writes recover without duplicates after simulated client record-boundary interruption', 'passed': True})
            stop()
            start()
            client = login('synthetic-owner', password)
            assert len(client.call('GET', route).get('memos', [])) == 2
            assert all(r['status'] == 'already-imported' for r in pdf.ingest_pdf(client, item, pages)['records'])
            checks.append({'check': 'restart/relogin preserves keyword retrieval and verified retry', 'passed': True})
            client.call('PATCH', names[1] + '?' + urlencode({'updateMask': 'content'}), {'name': names[1], 'content': 'User edited synthetic text'})
            try:
                pdf.ingest_pdf(client, item, pages)
                raise AssertionError('edited text overwritten')
            except RuntimeError as error:
                assert 'Partial PDF import' in str(error)
            assert client.call('GET', names[1])['content'] == 'User edited synthetic text'
            checks.append({'check': 'edited derived text causes retry conflict and remains unchanged', 'passed': True})
            # Restore the synthetic edit so exact-content cleanup is eligible.
            planned = pdf.plan(item, pages, 0, owner)
            client.call('PATCH', names[1] + '?' + urlencode({'updateMask': 'content'}), {'name': names[1], 'content': planned[1]['content']})
            all_names = names + [r['name'] for r in recovered['records']]
            all_attachment_urls = []
            for name in all_names:
                memo = client.call('GET', name)
                for a in memo['attachments']:
                    all_attachment_urls.append(base + '/file/' + quote(a['name'], safe='/') + '/' + quote(a['filename'], safe=''))
            unrelated = client.call('POST', 'memos', {'content': 'Unrelated synthetic record', 'visibility': 'PRIVATE'})
            try:
                pdf.delete_pdf(other, item, pages, names[0], include_comments=True)
                raise AssertionError('other account accepted root confirmation')
            except ValueError as error:
                assert 'authenticated account' in str(error)
            checks.append({'check': 'other account cannot confirm or delete owner PDF group', 'passed': True})
            client.call('PATCH', names[0] + '?' + urlencode({'updateMask': 'content'}), {'name': names[0], 'content': planned[0]['content'] + '\n[extra](/' + unrelated['name'] + ')'})
            try:
                pdf.delete_pdf(client, item, pages, names[0], include_comments=True)
                raise AssertionError('tampered root accepted')
            except ValueError as error:
                assert 'changed' in str(error)
            assert client.call('GET', unrelated['name'])['content'] == 'Unrelated synthetic record'
            client.call('PATCH', names[0] + '?' + urlencode({'updateMask': 'content'}), {'name': names[0], 'content': planned[0]['content']})
            preview = pdf.delete_pdf(client, item, pages)
            assert preview['writes'] == 0 and preview['presentRecords'] == 3
            checks.append({'check': 'cleanup preview does not write; injected body links cannot select deletion targets', 'passed': True})
            try:
                pdf.delete_pdf(client, item, pages, names[0])
                raise AssertionError('missing comment-cascade acknowledgement accepted')
            except ValueError as error:
                assert '--include-comments' in str(error)
            comment = client.call('POST', names[0] + '/comments', {'comment': {'content': 'Synthetic archived comment', 'visibility': 'PRIVATE'}})
            client.call('PATCH', comment['name'] + '?' + urlencode({'updateMask': 'state'}), {'name': comment['name'], 'state': 'ARCHIVED'})
            all_names.append(comment['name'])
            checks.append({'check': 'cleanup requires explicit acknowledgement of upstream archived/nested comment cascade', 'passed': True})
            class InterruptDelete:
                base, token, opener = client.base, client.token, client.opener
                def __init__(self):
                    self.count = 0
                def call(self, method, *args, **kwargs):
                    if method == 'DELETE':
                        self.count += 1
                        if self.count == 2:
                            raise RuntimeError('synthetic interruption before second delete')
                    return client.call(method, *args, **kwargs)
            try:
                pdf.delete_pdf(InterruptDelete(), item, pages, names[0], include_comments=True)
                raise AssertionError('delete interruption missing')
            except RuntimeError as error:
                assert 'Partial cleanup: 1' in str(error)
            assert pdf.delete_pdf(client, item, pages, names[0], include_comments=True)['deletedRecords'] == 2
            assert pdf.delete_pdf(client, item, pages, names[0], include_comments=True)['deletedRecords'] == 0
            pdf.delete_pdf(client, recovery_item, recovery_pages, recovered['index'], include_comments=True)
            for name in all_names:
                try:
                    client.call('GET', name)
                    raise AssertionError('deleted record readable')
                except HTTPError as error:
                    assert error.code == 404
            for url_ in all_attachment_urls:
                try:
                    with client.opener.open(Request(url_, headers={'Authorization': 'Bearer ' + client.token})):
                        raise AssertionError('deleted original readable')
                except HTTPError as error:
                    assert error.code in (403, 404)
            assert client.call('GET', route).get('memos', []) == []
            assert client.call('GET', unrelated['name'])['content'] == 'Unrelated synthetic record'
            checks.append({'check': 'resumable explicit cleanup removes all planned records/archives/search hits and acknowledged archived comment and preserves unrelated memo', 'passed': True})
            for committed in (False, True):
                fault_data = item['data'] + ('\n% synthetic fault ' + str(committed) + '\n').encode()
                fault_item = {**item, 'id': 'mw-fault-' + str(committed), 'data': fault_data, 'sha256': hashlib.sha256(fault_data).hexdigest()}
                fault_pages = pdf.extract(fault_data)
                original_call = client.call
                triggered = [False]
                def fault_call(method, endpoint, body=None):
                    if method == 'POST' and endpoint.startswith('memos?') and not triggered[0]:
                        triggered[0] = True
                        if committed:
                            original_call(method, endpoint, body)
                            raise TimeoutError('synthetic lost response after successful memo commit')
                        raise HTTPError(base, 500, 'synthetic pre-commit failure', {}, None)
                    return original_call(method, endpoint, body)
                client.call = fault_call
                try:
                    pdf.ingest_pdf(client, fault_item, fault_pages)
                    raise AssertionError('fault not injected')
                except RuntimeError as error:
                    match = re.search(r'uploaded attachment=(attachments/[^;]+);', str(error))
                    assert match, 'uncertain upload must identify exact attachment'
                    pending = match.group(1)
                finally:
                    client.call = original_call
                pending_attachment = client.call('GET', pending)
                assert bool(pending_attachment.get('memo')) == committed
                resumed = pdf.ingest_pdf(client, fault_item, fault_pages)
                assert resumed['records'][0]['status'] == ('already-imported' if committed else 'imported')
                listed_attachments = client.call('GET', 'attachments').get('attachments', [])
                assert len(listed_attachments) == (3 if committed else 4)
                pdf.delete_pdf(client, fault_item, fault_pages, resumed['index'], include_comments=True)
                if not committed:
                    # Explicit synthetic fixture cleanup, not automatic importer rollback.
                    assert not client.call('GET', pending).get('memo')
                    client.call('DELETE', pending)
                checks.append({'check': ('lost response after real memo commit: retry verifies without new attachments' if committed else 'injected memo 500 after real attachment upload: exact orphan ID reported; retry leaves one explicitly identified orphan requiring manual cleanup'), 'passed': True})
            print(json.dumps({'kind': 'real pypdf, SQLite and HTTP; not browser E2E', 'checks': checks}, ensure_ascii=False, indent=2))
        finally:
            stop()
