#!/usr/bin/env python3
"""Bounded local PDF worker. Receives bytes on stdin; never receives API credentials."""
import json
import logging
import sys

VERSION = '7.1.1'
MAX_INPUT = 16 * 1024 * 1024
MAX_TEXT = 256 * 1024


def run():
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    logging.disable(logging.CRITICAL)
    import io
    import pypdf
    if pypdf.__version__ != VERSION:
        return {'error': 'parser_unavailable'}
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT or not data.startswith(b'%PDF-'):
        return {'error': 'invalid_pdf'}
    reader = pypdf.PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        return {'error': 'encrypted_pdf'}
    if not 1 <= len(reader.pages) <= 64:
        return {'error': 'page_limit'}
    pages, size = [], 0
    for number, page in enumerate(reader.pages, 1):
        text = page.extract_text() or ''
        size += len(text.encode('utf-8'))
        if size > MAX_TEXT:
            return {'error': 'text_limit'}
        pages.append({'page': number, 'text': text})
    if not any(page['text'].strip() for page in pages):
        return {'error': 'no_text'}
    return {'parser': 'pypdf', 'version': VERSION, 'pages': pages}


if __name__ == '__main__':
    try:
        result = run()
    except ImportError:
        result = {'error': 'parser_unavailable'}
    except Exception:
        result = {'error': 'parse_failed'}
    # No exception, path, credentials or original document is printed on failure.
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
