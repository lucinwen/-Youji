#!/usr/bin/env python3
"""Import explicitly supplied local material into the unchanged Memos API.
No crawling, cloud inference or background directory scanning. Stdlib only.
"""
import argparse, base64, hashlib, json, mimetypes, os, io, zipfile
from pathlib import Path
from urllib.parse import urlparse, urlencode, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

KINDS = {'diary', 'idea', 'work', 'lecture', 'conversation', 'reference'}

def prepare(path, kind, note='', source_url=''):
    if kind not in KINDS:
        raise ValueError('Unsupported source kind')
    p = Path(path)
    if not p.is_file() or p.is_symlink():
        raise ValueError('Provide one regular file, not a symlink or directory')
    data = p.read_bytes()
    if len(data) > 16 * 1024 * 1024:
        raise ValueError('Demo importer limit is 16 MiB; use the upstream chunked uploader for larger files')
    if source_url and urlparse(source_url).scheme not in ('http', 'https'):
        raise ValueError('Source URL must be HTTP(S)')
    digest = hashlib.sha256(data).hexdigest()
    identity = hashlib.sha256(json.dumps([digest, kind, note, source_url], ensure_ascii=False).encode()).hexdigest()
    mime = mimetypes.guess_type(p.name)[0] or 'application/octet-stream'
    text = data.decode('utf-8') if p.suffix.lower() in ('.txt', '.md', '.csv', '.json') else ''
    category = {'lecture': 'reference', 'conversation': 'diary'}.get(kind, kind)
    source = 'conversation' if kind == 'conversation' else ('image' if mime.startswith('image/') else ('text' if text else 'file'))
    content = f'# 拾微原始资料 · {p.name}\n\n#拾微 #{category} #kind/{kind} #source/{source}\n\n'
    if source_url: content += f'来源：{source_url}\n\n'
    if note: content += f'## 我的批注\n{note}\n\n'
    content += '## 原始内容\n' + (text if text else '原件已作为附件保存；未进行转写、OCR 或 AI 总结。')
    content += '\n\n原始文件在 .original.zip 归档内；可视预览可能经隐私去元数据处理，不能作为原字节副本。'
    content += f'\n\n---\n原件 SHA-256：`{digest}`\n'
    return {'id': 'mw-' + identity[:30], 'content': content, 'data': data,
            'sha256': digest, 'filename': p.name, 'type': mime, 'kind': kind}

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('API redirect refused; credentials must never leave the configured origin')

class Client:
    def __init__(self, base, token):
        u = urlparse(base)
        if u.scheme not in ('http', 'https') or u.username or u.password or u.query or u.fragment:
            raise ValueError('Invalid API URL')
        if u.scheme == 'http' and u.hostname not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError('Remote API requires HTTPS')
        self.base, self.token = base.rstrip('/'), token
        self.opener = build_opener(NoRedirect)
    def call(self, method, route, body=None):
        headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.token}
        req = Request(self.base + '/api/' + route, None if body is None else json.dumps(body).encode(), headers, method=method)
        with self.opener.open(req, timeout=60) as r: return json.load(r)
    def ingest(self, item):
        name = 'memos/' + item['id']
        try:
            existing = self.call('GET', name)
        except HTTPError as e:
            if e.code != 404: raise
            existing = None
        if existing is not None:
            if existing.get('visibility') != 'PRIVATE':
                raise ValueError('Existing source is no longer private; refusing to treat it as a private import')
            if existing['content'] != item['content']:
                raise ValueError('Existing source changed; refusing overwrite')
            if not existing.get('attachments'):
                raise ValueError('Existing memo lacks its original attachment; repair explicitly before retry')
            matched = False
            for attachment in existing['attachments']:
                archived = True
                expected_name = item['filename'] + '.original.zip' if archived else item['filename']
                if attachment.get('externalLink') or attachment.get('filename') != expected_name:
                    continue
                route = '/file/' + quote(attachment['name'], safe='/') + '/' + quote(attachment['filename'], safe='')
                req = Request(self.base + route, headers={'Authorization': 'Bearer ' + self.token})
                with self.opener.open(req, timeout=60) as response:
                    data = response.read(17 * 1024 * 1024 + 1)
                if archived:
                    with zipfile.ZipFile(io.BytesIO(data)) as z:
                        entries = z.infolist()
                        if len(entries) != 1 or entries[0].filename != item['filename'] or entries[0].file_size > 16 * 1024 * 1024:
                            raise ValueError('Invalid original image archive')
                        data = z.read(entries[0])
                if hashlib.sha256(data).hexdigest() == item['sha256']:
                    matched = True
                    break
            if not matched:
                raise ValueError('Original attachment integrity mismatch; refusing to claim a completed import')
            return {'status': 'already-imported', 'name': name, 'sha256': item['sha256']}
        # All originals are archived: upstream may sniff/re-encode even an image named .bin.
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as z:
            z.writestr(item['filename'], item['data'])
        upload_data, upload_name, upload_type = buffer.getvalue(), item['filename'] + '.original.zip', 'application/zip'
        preview = None
        if item['type'].startswith('image/'):
            preview = self.call('POST', 'attachments', {'filename': item['filename'], 'type': item['type'],
                                'content': base64.b64encode(item['data']).decode()})
        a = self.call('POST', 'attachments', {'filename': upload_name, 'type': upload_type,
                     'content': base64.b64encode(upload_data).decode()})
        attachments = [{'name': a['name']}] + ([{'name': preview['name']}] if preview else [])
        try:
            memo = self.call('POST', 'memos?' + urlencode({'memoId': item['id']}),
                             {'content': item['content'], 'visibility': 'PRIVATE', 'attachments': attachments})
        except Exception:
            # Never delete possibly attached data after an uncertain write.
            raise RuntimeError('Memo write uncertain; inspect unlinked uploads and retry after checking the source ID ' + item['id'])
        return {'status': 'imported', 'name': memo['name'], 'sha256': item['sha256'], 'attachment': a['name'],
                'processing': {'original': 'saved', 'ocr': 'not-run', 'transcription': 'not-run', 'ai': 'not-run'}}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('file'); p.add_argument('--kind', choices=sorted(KINDS), default='reference')
    p.add_argument('--note', default=''); p.add_argument('--source-url', default='')
    p.add_argument('--base-url', default='http://127.0.0.1:5231')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args()
    item = prepare(args.file, args.kind, args.note, args.source_url)
    if args.dry_run:
        print(json.dumps({k:v for k,v in item.items() if k != 'data'}, ensure_ascii=False, indent=2)); return
    token = os.environ.get('MOTEARY_API_TOKEN')
    if not token: p.error('Set MOTEARY_API_TOKEN locally; never put it in command-line arguments or receipts')
    print(json.dumps(Client(args.base_url, token).ingest(item), ensure_ascii=False, indent=2))
if __name__ == '__main__': main()
