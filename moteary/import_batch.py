#!/usr/bin/env python3
"""Import an explicit list of sources with preflight and resumable verification.
No directory scanning, cloud processing, or background retries.
"""
import argparse
import json
import os
import tempfile
from pathlib import Path

from import_sources import Client, prepare

MAX_FILES = 100
MAX_BATCH_BYTES = 64 * 1024 * 1024


def load_batch(manifest):
    path = Path(manifest)
    if path.is_symlink() or not path.is_file():
        raise ValueError('Manifest must be a regular file')
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('Manifest exceeds 1 MiB')
    entries = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_FILES:
        raise ValueError('Manifest must list 1–100 explicit files')
    prepared, seen, size = [], set(), 0
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or set(entry) - {'file', 'kind', 'note', 'source_url'}:
            raise ValueError(f'Entry {index + 1}: unsupported fields')
        if not isinstance(entry.get('file'), str) or not entry['file']:
            raise ValueError(f'Entry {index + 1}: file is required')
        for key in ('kind', 'note', 'source_url'):
            if key in entry and not isinstance(entry[key], str):
                raise ValueError(f'Entry {index + 1}: {key} must be text')
        source = Path(entry['file'])
        if not source.is_absolute():
            source = path.parent / source
        item = prepare(source, entry.get('kind', 'reference'), entry.get('note', ''), entry.get('source_url', ''))
        size += len(item['data'])
        if size > MAX_BATCH_BYTES:
            raise ValueError('Batch exceeds 64 MiB; split the explicit manifest')
        if item['id'] in seen:
            raise ValueError(f'Entry {index + 1}: duplicate source identity in this batch')
        seen.add(item['id'])
        prepared.append(item)
    return prepared


def summary(items):
    return [{'source_id': i['id'], 'filename': i['filename'], 'kind': i['kind'],
             'bytes': len(i['data']), 'sha256': i['sha256']} for i in items]


def write_receipt(path, records):
    # Atomic replacement prevents a process interruption truncating the receipt.
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.moteary-receipt-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            json.dump({'version': 1, 'records': records}, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def run_batch(items, client, receipt):
    records = summary(items)
    for record in records:
        record['status'] = 'not-started'
    write_receipt(receipt, records)  # Fail before remote writes if output is not writable.
    for item, record in zip(items, records):
        record['status'] = 'in-progress'
        write_receipt(receipt, records)
        try:
            result = client.ingest(item)
        except Exception as exc:
            # Do not persist exception messages: provider errors may contain private content.
            record['status'] = 'needs-review'
            record['error_type'] = type(exc).__name__
            write_receipt(receipt, records)
            return records, False
        record['status'] = result['status']
        record['name'] = result['name']
        write_receipt(receipt, records)
    return records, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', help='JSON array of explicit file/kind/note/source_url objects')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--receipt', help='New receipt JSON path, distinct from all source files')
    parser.add_argument('--base-url', default='http://127.0.0.1:5231')
    args = parser.parse_args()
    items = load_batch(args.manifest)
    if args.dry_run:
        print(json.dumps({'files': summary(items), 'total_bytes': sum(len(i['data']) for i in items)}, ensure_ascii=False, indent=2))
        return 0
    if not args.receipt:
        parser.error('--receipt is required for an actual import')
    # A fresh receipt per run prevents accidental source or previous receipt overwrite.
    if Path(args.receipt).exists() or Path(args.receipt).is_symlink():
        parser.error('--receipt must be a new file')
    token = os.environ.get('MOTEARY_API_TOKEN')
    if not token:
        parser.error('Set MOTEARY_API_TOKEN locally; never put it in the manifest')
    records, complete = run_batch(items, Client(args.base_url, token), args.receipt)
    print(json.dumps({'complete': complete, 'processed': sum(r['status'] in ('imported', 'already-imported') for r in records),
                      'total': len(records), 'receipt': args.receipt}, ensure_ascii=False))
    return 0 if complete else 1


if __name__ == '__main__':
    raise SystemExit(main())
