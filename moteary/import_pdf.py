#!/usr/bin/env python3
"""Explicit local PDF text import: original archive, page provenance, PRIVATE records.
No OCR, model, web fetch, cloud inference or directory scanning. POSIX worker only.
"""
import argparse
import hashlib
import io
import zipfile
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.error import HTTPError
from urllib.request import Request
from urllib.parse import quote, urlencode

from import_sources import Client, KINDS, prepare

VERSION = '7.1.1'
ERRORS = {
    'parser_unavailable': 'Install the pinned optional PDF requirements in a dedicated venv; POSIX resource limits are required.',
    'invalid_pdf': 'Expected a PDF of at most 16 MiB.',
    'encrypted_pdf': 'Encrypted PDFs are not supported. No records were written.',
    'page_limit': 'PDF pilot accepts 1–64 pages. No records were written.',
    'text_limit': 'Extracted text exceeds 256 KiB. No records were written.',
    'no_text': 'No embedded text found. Scanned PDFs need OCR, which is not enabled. No records were written.',
    'parse_failed': 'PDF parsing failed or exceeded resource limits. No records were written.',
}


def extract(data):
    if os.name != 'posix':
        raise ValueError(ERRORS['parser_unavailable'])
    # Same immutable bytes are parsed and archived. No file path or API token reaches worker.
    with tempfile.TemporaryFile() as output:
        try:
            result = subprocess.run(
                [sys.executable, '-I', str(Path(__file__).with_name('pdf_worker.py'))],
                input=data, stdout=output, stderr=subprocess.DEVNULL,
                env={'LANG': 'C.UTF-8'}, timeout=15, check=False,
            )
        except subprocess.TimeoutExpired:
            raise ValueError(ERRORS['parse_failed']) from None
        output.seek(0)
        raw = output.read(2 * 1024 * 1024 + 1)
    if result.returncode or len(raw) > 2 * 1024 * 1024:
        raise ValueError(ERRORS['parse_failed'])
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError(ERRORS['parse_failed']) from None
    if payload.get('error'):
        raise ValueError(ERRORS.get(payload['error'], ERRORS['parse_failed']))
    if payload.get('parser') != 'pypdf' or payload.get('version') != VERSION:
        raise ValueError(ERRORS['parser_unavailable'])
    pages = payload.get('pages')
    if not isinstance(pages, list) or not 1 <= len(pages) <= 64:
        raise ValueError(ERRORS['parse_failed'])
    for number, page in enumerate(pages, 1):
        if page.get('page') != number or not isinstance(page.get('text'), str):
            raise ValueError(ERRORS['parse_failed'])
    if sum(len(p['text'].encode('utf-8')) for p in pages) > 256 * 1024:
        raise ValueError(ERRORS['text_limit'])
    return pages


def fence(text):
    # Extracted text is inert Markdown, including image links, HTML and fence markers.
    marker = '`' * max(3, 1 + max((len(x) for x in re.findall(r'`+', text)), default=0))
    return marker + '\n' + text + '\n' + marker


def split(text):
    chunks, chars, size = [], [], 0
    for char in text:
        width = len(char.encode('utf-8'))
        if size + width > 4096:
            chunks.append(''.join(chars))
            chars, size = [], 0
        chars.append(char)
        size += width
    if chars:
        chunks.append(''.join(chars))
    return chunks


def plan(item, pages, limit, owner):
    if not item['filename'].lower().endswith('.pdf') or any(ord(c) < 32 for c in item['filename']):
        raise ValueError('Provide a PDF filename without control characters')
    identity = hashlib.sha256(json.dumps(['pdf-text-v1', VERSION, owner, item['id'], item['filename']], ensure_ascii=False).encode()).hexdigest()
    root_id = 'mp-' + identity[:30]
    category = {'lecture': 'reference', 'conversation': 'diary'}.get(item['kind'], item['kind'])
    tags = f'#拾微 #{category} #source/file #derived/pdftext'
    provenance = f'原件 SHA-256：`{item["sha256"]}`\n本地解析：pypdf {VERSION} · pdf-text-v1（非 OCR / 非 AI）\n'
    chunks, links = [], []
    for page in pages:
        number = page['page']
        if not page['text'].strip():
            links.append(f'- 第 {number} 页：无可提取正文（保留原页，不作 OCR）')
            continue
        for part, body in enumerate(split(page['text']), 1):
            id_ = 'mpc-' + hashlib.sha256(f'{identity}:{number}:{part}'.encode()).hexdigest()[:30]
            raw = body.encode('utf-8')
            content = (f'# 有记 PDF 正文 · 第 {number} 页 / 段 {part}\n\n{tags}\n\n'
                       f'[返回完整 PDF 原件](/memos/{root_id})\n{provenance}\n原文件名：\n{fence(item["filename"])}\n\n'
                       '以下是机器提取文本；顺序与字形可能有误，请对照原件核实。编辑此记录后重试将报告冲突，不会覆盖。\n\n' + fence(body))
            chunks.append(dict(id=id_, filename=f'page-{number:03}-part-{part:03}.txt', data=raw,
                               sha256=hashlib.sha256(raw).hexdigest(), content=content, type='text/plain', kind=item['kind']))
            links.append(f'- [第 {number} 页 / 段 {part}](/memos/{id_})')
    if not chunks:
        raise ValueError(ERRORS['no_text'])
    if len(chunks) > 64:
        raise ValueError('PDF pilot is limited to 64 text chunks. No records were written.')
    content = (f'# 有记 PDF 原件与正文索引\n\n{tags}\n\n原文件名：\n{fence(item["filename"])}\n\n{provenance}\n'
               '完整 PDF 原始字节保存在 .original.zip 附件。正文独立保存，页码可用于人工核对原件。\n'
               '以下是计划记录链接，不代表全部已写入。以命令最终 complete 回执为准；中断可重跑原命令核验并恢复。\n'
               '删除索引不会删除正文记录及其附件。永久删除请逐项删除所有记录，且勿重跑导入。\n'
               '本地仅提取已有文字，不做 OCR、转写或摘要。关键词在单段内匹配；跨段短语可能找不到。\n\n' + '\n'.join(links))
    records = [{**item, 'id': root_id, 'content': content, 'type': 'application/pdf'}] + chunks
    if limit > 0 and any(len(r['content'].encode('utf-8')) > limit for r in records):
        raise ValueError('Current quota cannot fit PDF index/chunks. No records were written.')
    return records


def ingest_pdf(client, item, pages):
    user = client.call('GET', 'auth/me').get('user', {}).get('name', '')
    if not user.startswith('users/') or len(user.split('/')) != 2:
        raise ValueError('Cannot verify account')
    usage = client.call('GET', user + '/usage')
    if not isinstance(usage.get('limits'), dict):
        raise ValueError('Cannot verify quota')
    records = plan(item, pages, int(usage['limits'].get('memoContentBytes', 0)), user)
    # Do not archive the same original through another importer. This is a preflight,
    # not a transactional uniqueness guarantee across concurrent clients.
    filter_ = 'creator == ' + json.dumps(user) + ' && content.contains(' + json.dumps(item['sha256']) + ')'
    page_token = ''
    for _ in range(10):
        found = client.call('GET', 'memos?' + urlencode({'filter': filter_, 'pageSize': 100, 'pageToken': page_token}))
        for memo in found.get('memos', []):
            uid = memo.get('name', '').removeprefix('memos/')
            if uid != records[0]['id'] and uid.startswith(('mw-', 'ml-', 'mui-', 'mul-', 'mp-')):
                raise ValueError('Possible existing original at memos/' + uid + '; no new PDF records written. Review the original entry first.')
        page_token = found.get('nextPageToken', '')
        if not page_token:
            break
    else:
        raise ValueError('Original lookup exceeded safe bound. No records were written.')
    completed = []
    for record in records:
        try:
            completed.append(client.ingest(record))
        except Exception as error:
            raise RuntimeError(f'Partial PDF import: {len(completed)}/{len(records)} verified; '
                               f'index=memos/{records[0]["id"]}; stopped=memos/{record["id"]}. '
                               'No rollback/deletion. Inspect unlinked uploads if a write was uncertain. '
                               'Rerun the same file to verify and resume; edited records are never overwritten. ' +
                               (str(error) if isinstance(error, RuntimeError) else 'Underlying request failed; inspect the stopped record.')) from error
    return {'status': 'complete', 'index': completed[0]['name'], 'pages': len(pages),
            'textParts': len(records)-1, 'parser': 'pypdf', 'version': VERSION,
            'originalSha256': item['sha256'], 'records': completed}


def delete_pdf(client, item, pages, confirmed_root=None, include_comments=False):
    """Explicit bounded cleanup; authority comes from account-derived IDs, never links.

    Only records passing owner, PRIVATE, body and archive checks qualify.
    Server authorizes every DELETE. This
    is resumable, not an atomic group transaction or orphan-attachment collector.
    """
    user = client.call('GET', 'auth/me').get('user', {}).get('name', '')
    if not user.startswith('users/') or len(user.split('/')) != 2:
        raise ValueError('Cannot verify account')
    if confirmed_root is not None and not include_comments:
        raise ValueError('Cleanup uses upstream permanent deletion including archived/nested comments. Explicit --include-comments acknowledgement required.')
    records = plan(item, pages, 0, user)
    root = 'memos/' + records[0]['id']
    if confirmed_root is not None and confirmed_root != root:
        raise ValueError('Confirmation does not match this file and authenticated account; nothing deleted')

    def verify(record):
        name = 'memos/' + record['id']
        try:
            memo = client.call('GET', name)
        except HTTPError as error:
            if error.code == 404:
                return False
            raise
        if memo.get('creator') != user or memo.get('visibility') != 'PRIVATE' or memo.get('content') != record['content']:
            raise ValueError('Import record changed or ownership mismatch at ' + name + '; cleanup stopped')
        attachments = memo.get('attachments', [])
        if len(attachments) != 1:
            raise ValueError('Attachment set changed at ' + name + '; cleanup stopped')
        attachment = attachments[0]
        if attachment.get('externalLink') or attachment.get('filename') != record['filename'] + '.original.zip':
            raise ValueError('Original attachment changed; cleanup stopped')
        url = client.base + '/file/' + quote(attachment['name'], safe='/') + '/' + quote(attachment['filename'], safe='')
        with client.opener.open(Request(url, headers={'Authorization': 'Bearer ' + client.token}), timeout=60) as response:
            raw = response.read(17 * 1024 * 1024 + 1)
        if len(raw) > 17 * 1024 * 1024:
            raise ValueError('Original archive exceeds cleanup bound')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) != 1 or entries[0].filename != record['filename'] or entries[0].file_size > 16 * 1024 * 1024:
                raise ValueError('Invalid original archive; cleanup stopped')
            if hashlib.sha256(archive.read(entries[0])).hexdigest() != record['sha256']:
                raise ValueError('Original archive differs; cleanup stopped')
        return True

    present = [record for record in records if verify(record)]
    if confirmed_root is None:
        return {'status': 'delete-preview', 'index': root, 'presentRecords': len(present),
                'plannedRecords': ['memos/' + record['id'] for record in records], 'writes': 0,
                'warning': 'Permanent upstream deletion includes all nested/archived comments. Stop concurrent editing; no atomic group/CAS guarantee. Storage cleanup errors require administrator review.'}
    deleted = 0
    # Delete children first and index last, allowing retry even if index is gone.
    for record in list(reversed(records[1:])) + records[:1]:
        try:
            if verify(record):
                client.call('DELETE', 'memos/' + record['id'])
                deleted += 1
        except Exception as error:
            raise RuntimeError(f'Partial cleanup: {deleted} deletes acknowledged; index={root}. '
                               'Retry the same delete command; missing records are skipped. Do not rerun import.') from error
    return {'status': 'deleted', 'index': root, 'deletedRecords': deleted, 'plannedRecords': len(records),
            'storage': 'API records removed; physical erasure and previously unlinked uploads are not certified'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file')
    parser.add_argument('--kind', choices=sorted(KINDS), default='reference')
    parser.add_argument('--base-url', default='http://127.0.0.1:5231')
    parser.add_argument('--dry-run', action='store_true', help='Local parse and count only; no API calls or extracted text output')
    parser.add_argument('--delete-import', action='store_true', help='Preview cleanup; requires the original PDF and same kind/account')
    parser.add_argument('--confirm-root', help='With --delete-import, execute permanent cleanup for exactly this memos/mp-... ID')
    parser.add_argument('--include-comments', action='store_true', help='Acknowledge deletion includes all comments, including archived/nested replies')
    args = parser.parse_args()
    if args.include_comments and not args.delete_import:
        parser.error('--include-comments requires --delete-import')
    if args.confirm_root and not args.delete_import:
        parser.error('--confirm-root requires --delete-import')
    if args.delete_import and args.dry_run:
        parser.error('--delete-import previews automatically; do not combine with --dry-run')
    try:
        item = prepare(args.file, args.kind)
        if not item['filename'].lower().endswith('.pdf'):
            raise ValueError('Provide a .pdf file')
        pages = extract(item['data'])
        if args.dry_run:
            records = plan(item, pages, 0, 'dry-run')
            result = {'status': 'preview', 'parser': 'pypdf', 'version': VERSION, 'pages': len(pages),
                      'textParts': len(records)-1, 'textBytes': sum(len(p['text'].encode('utf-8')) for p in pages),
                      'originalSha256': item['sha256'], 'writes': 0}
        else:
            token = os.environ.get('MOTEARY_API_TOKEN')
            if not token:
                raise ValueError('Set MOTEARY_API_TOKEN locally; never put it in command-line arguments')
            client = Client(args.base_url, token)
            result = delete_pdf(client, item, pages, args.confirm_root, args.include_comments) if args.delete_import else ingest_pdf(client, item, pages)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, RuntimeError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
