#!/usr/bin/env python3
"""Explicit, resumable PRIVATE long UTF-8 text import. No AI or silent truncation."""
import argparse, hashlib, json, os
from import_sources import Client, prepare


def plan(item, limit, owner=""):
    if not item['filename'].lower().endswith(('.txt', '.md')):
        raise ValueError('Long-text mode accepts UTF-8 .txt/.md only')
    text = item['data'].decode('utf-8')
    if len(item['data']) > 256 * 1024:
        raise ValueError('Long-text pilot is limited to 256 KiB')
    # Versioned policy is stable across quota changes. Smaller quotas reject, not re-chunk.
    budget = 4096
    parts, current, size = [], [], 0
    for char in text:
        width = len(char.encode('utf-8'))
        if size + width > budget:
            parts.append(''.join(current)); current, size = [], 0
        current.append(char); size += width
    if current: parts.append(''.join(current))
    if not parts: raise ValueError('Empty text')
    identity = hashlib.sha256(('long-v1:' + owner + ':' + item['id']).encode()).hexdigest()
    root_id = 'ml-' + identity[:30]
    chunks = []
    for i, body in enumerate(parts):
        id_ = 'mc-' + hashlib.sha256(f'{identity}:{i}'.encode()).hexdigest()[:30]
        raw = body.encode('utf-8')
        content = (f'# 拾微长文分段 {i+1}/{len(parts)}\n\n#拾微 #reference #source/text\n\n'
                   f'原件：{item["filename"]}\n索引：[完整原件](/memos/{root_id})\n'
                   f'原件 SHA-256：`{item["sha256"]}`\n\n## 分段原文\n{body}')
        chunks.append(dict(id=id_, filename=f'part-{i+1:03}.txt', data=raw,
                           sha256=hashlib.sha256(raw).hexdigest(), content=content,
                           type='text/plain', kind='reference'))
    links = '\n'.join(f'- [{i+1}/{len(parts)}](/memos/{x["id"]})' for i,x in enumerate(chunks))
    content = (f'# 拾微长文索引 · {item["filename"]}\n\n#拾微 #reference #source/text\n\n'
               f'原件 SHA-256：`{item["sha256"]}`\n完整原始字节保存在附件ZIP。\n'
               '以下为计划分段链接；中断时部分链接可能尚未创建，重新运行同一命令核验并恢复。\n'
               '删除索引不会删除分段；显式重新导入会恢复缺失段，如要永久删除请勿重新导入原文件。\n'
               '未做摘要或语义理解；关键词按单段匹配，跨段短语可能检索不到。\n\n' + links)
    index = {**item, 'id':root_id, 'content':content, 'type':'text/plain'}
    records = [index] + chunks
    if limit > 0 and any(len(x['content'].encode('utf-8')) > limit for x in records):
        raise ValueError('Current quota cannot fit the versioned index/chunks; no file uploaded')
    return records


def ingest_long(client, item):
    user = client.call('GET', 'auth/me').get('user', {}).get('name', '')
    if not user.startswith('users/') or len(user.split('/')) != 2:
        raise ValueError('Cannot verify account')
    usage = client.call('GET', user + '/usage')
    if not isinstance(usage.get('limits'), dict): raise ValueError('Cannot verify quota')
    records = plan(item, int(usage['limits'].get('memoContentBytes', 0)), user)
    completed = []
    for record in records:
        # Existing Client checks PRIVATE, exact body and archive hash on every retry.
        try:
            result = client.ingest(record)
        except Exception as error:
            raise RuntimeError(f'Partial import: {len(completed)}/{len(records)} records verified; '
                               f'index=memos/{records[0]["id"]}; stopped=memos/{record["id"]}. '
                               'No rollback or deletion performed. Retry the same file after review; '
                               'manual changes are never overwritten.') from error
        completed.append(result)
    return {'status':'complete', 'index':completed[0]['name'], 'parts':len(records)-1,
            'originalSha256':item['sha256'], 'records':completed}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file'); parser.add_argument('--base-url',default='http://127.0.0.1:5231')
    args=parser.parse_args()
    token=os.environ.get('MOTEARY_API_TOKEN')
    if not token: parser.error('Set MOTEARY_API_TOKEN in your environment')
    result=ingest_long(Client(args.base_url,token),prepare(args.file,'reference'))
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__ == '__main__': main()
