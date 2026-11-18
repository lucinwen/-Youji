#!/usr/bin/env python3
"""Fetch a fixed, public CC-BY-4.0 FLEURS subset before ASR evaluation.

Writes only selected unchanged WAVs to a caller-owned cache and provenance JSON.
Never extract archive paths, select on model output, or use private recordings.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

REVISION = '70bb2e84b976b7e960aa89f1c648e09c59f894dd'
BASE = 'https://huggingface.co/datasets/google/fleurs/resolve/' + REVISION
ARCHIVE_SHA256 = '3bc33212d5974eef7feb04bc4792458d6cd7e14ff10a1a24772f3c45ea87a822'
TSV_GIT_BLOB = 'bd100387f1cc9861653500cbfeda3270d0e8dddf'


def select(rows):
    selected, seen = [], set()
    for row in rows:
        sentence, filename, raw_text, normalized, _, samples, _ = row
        if sentence in seen or not 0 < int(samples) <= 20 * 16000:
            continue
        if Path(filename).name != filename or not filename.endswith('.wav'):
            raise ValueError('Unsafe dataset filename')
        seen.add(sentence)
        selected.append({'sentence_id': sentence, 'filename': filename, 'reference': raw_text,
                         'dataset_normalized_reference': normalized, 'num_samples': int(samples),
                         'expected_duration_seconds': int(samples) / 16000})
        if len(selected) == 5:
            break
    if len(selected) != 5:
        raise ValueError('Insufficient qualifying fixed samples')
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    tsv_url = BASE + '/data/cmn_hans_cn/dev.tsv'
    with urllib.request.urlopen(tsv_url, timeout=90) as response:
        data = response.read()
    assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == TSV_GIT_BLOB
    selected = select(csv.reader(io.StringIO(data.decode('utf-8')), delimiter='\t'))
    print(json.dumps({'selected_before_inference': selected}, ensure_ascii=False), flush=True)
    archive = args.cache / 'fleurs-cmn-dev.tar.gz'
    archive_url = BASE + '/data/cmn_hans_cn/audio/dev.tar.gz'
    digest = hashlib.sha256()
    with urllib.request.urlopen(archive_url, timeout=180) as response, archive.open('wb') as target:
        while block := response.read(1024 * 1024):
            target.write(block)
            digest.update(block)
    assert digest.hexdigest() == ARCHIVE_SHA256
    by_name = {r['filename']: r for r in selected}
    found = set()
    with tarfile.open(archive, mode='r:gz') as source:
        for entry in source:
            filename = Path(entry.name).name
            if filename not in by_name:
                continue
            if filename in found or not entry.isfile() or entry.size > 5 * 1024 * 1024:
                raise ValueError('Duplicate, non-regular or oversized selected archive member')
            content = source.extractfile(entry).read()
            (args.cache / filename).write_bytes(content)
            by_name[filename].update(sha256=hashlib.sha256(content).hexdigest(), bytes=len(content), archive_member=entry.name)
            found.add(filename)
    assert found == set(by_name)
    report = {'dataset': 'google/fleurs', 'revision': REVISION, 'config': 'cmn_hans_cn', 'split': 'validation/dev',
              'license': 'CC-BY-4.0', 'license_url': 'https://creativecommons.org/licenses/by/4.0/',
              'attribution': 'FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech; Conneau et al., 2022, Google',
              'paper': 'https://arxiv.org/abs/2205.12446',
              'dataset_card': 'https://huggingface.co/datasets/google/fleurs/blob/' + REVISION + '/README.md',
              'archive_url': archive_url, 'archive_sha256': ARCHIVE_SHA256,
              'reference_url': tsv_url, 'reference_sha256': hashlib.sha256(data).hexdigest(),
              'reference_git_blob': TSV_GIT_BLOB,
              'selection': 'First five distinct sentence IDs in dev.tsv order with 0 < num_samples <= 320000; fixed before decoding; no outcome-based exclusion',
              'audio_type': 'Published human read speech, not synthesized; corpus is not user/private material',
              'modifications': 'None to WAV bytes or reference text. Selecting a subset only; CER normalization is reported separately.',
              'samples': selected}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print('Verified five unchanged public audio samples', flush=True)


if __name__ == '__main__':
    main()
