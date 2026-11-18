#!/usr/bin/env python3
"""Real local ASR on a predetermined licensed human-speech subset, never TTS.

No product integration, remote inference, transcript prompts, or outcome filtering.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import socket
import time
import unicodedata
import wave

VAD_SHA256 = '4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2'


def characters(text):
    return [c.lower() for c in unicodedata.normalize('NFKC', text)
            if not c.isspace() and not unicodedata.category(c).startswith('P')]


def distance(a, b):
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        row = [i]
        for j, y in enumerate(b, 1):
            row.append(min(previous[j] + 1, row[-1] + 1, previous[j-1] + (x != y)))
        previous = row
    return previous[-1]


def verify_file(path, digest, size=None):
    if not path.is_file() or (size is not None and path.stat().st_size != size):
        raise ValueError('Missing or wrong-size local file: ' + path.name)
    hashed = hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(1024 * 1024): hashed.update(block)
    if hashed.hexdigest() != digest:
        raise ValueError('Local hash mismatch: ' + path.name)


def disable_network():
    attempts = []
    def reject(*args, **kwargs):
        attempts.append('blocked')
        raise OSError('network_disabled')
    class DisabledSocket(socket.socket):
        __init__ = reject
        connect = reject
        connect_ex = reject
    socket.socket = DisabledSocket
    socket.create_connection = reject
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
    return attempts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--model-manifest', type=Path, required=True)
    parser.add_argument('--audio-dir', type=Path, required=True)
    parser.add_argument('--samples-manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    model_manifest = json.loads(args.model_manifest.read_text())
    entries = {x['file']: x for x in model_manifest['files']}
    for name in ('model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'):
        entry = entries[name]
        verify_file(args.model_dir / name, entry['sha256'], entry['bytes'])
    samples = json.loads(args.samples_manifest.read_text())
    for sample in samples['samples']:
        if Path(sample['filename']).name != sample['filename']:
            raise ValueError('Unsafe sample filename')
        verify_file(args.audio_dir / sample['filename'], sample['sha256'], sample['bytes'])
    vad = Path(importlib.metadata.distribution('faster-whisper').locate_file('faster_whisper/assets/silero_vad_v6.onnx'))
    verify_file(vad, VAD_SHA256)
    attempts = disable_network()
    from faster_whisper import WhisperModel
    start = time.monotonic()
    model = WhisperModel(str(args.model_dir), device='cpu', compute_type='int8', cpu_threads=1,
                         num_workers=1, local_files_only=True)
    load_seconds = time.monotonic() - start
    rows = []
    for sample in samples['samples']:
        started = time.monotonic()
        row = {'filename': sample['filename'], 'sentence_id': sample['sentence_id'],
               'sha256': sample['sha256'], 'reference': sample['reference']}
        try:
            generator, info = model.transcribe(str(args.audio_dir / sample['filename']), language='zh',
                                               vad_filter=True, beam_size=5, temperature=0,
                                               condition_on_previous_text=False, word_timestamps=True)
            segments = list(generator)
            text = ''.join(s.text for s in segments).strip()
            ref, actual = characters(sample['reference']), characters(text)
            row.update(status='decoded', transcript=text, edit_distance=distance(ref, actual),
                       reference_characters=len(ref), cer=distance(ref, actual) / len(ref),
                       duration_seconds=info.duration, duration_after_vad_seconds=info.duration_after_vad,
                       segments=[{'start': s.start, 'end': s.end, 'text': s.text} for s in segments])
        except Exception as error:
            row.update(status='failed', error_type=type(error).__name__, error=str(error))
        row['elapsed_seconds'] = time.monotonic() - started
        rows.append(row)
        print(json.dumps({k: v for k, v in row.items() if k not in ('segments', 'reference', 'transcript')}, ensure_ascii=False), flush=True)
    silence = args.audio_dir / 'generated-silence.wav'
    with wave.open(str(silence), 'wb') as target:
        target.setnchannels(1); target.setsampwidth(2); target.setframerate(16000)
        target.writeframes(b'\0\0' * 16000 * 4)
    started = time.monotonic()
    generator, info = model.transcribe(str(silence), language='zh', vad_filter=True, beam_size=5,
                                       temperature=0, condition_on_previous_text=False)
    silent_segments = list(generator)
    silence_result = {'transcript': ''.join(s.text for s in silent_segments).strip(), 'segments': len(silent_segments),
                      'retained_seconds': info.duration_after_vad, 'elapsed_seconds': time.monotonic() - started,
                      'sha256': hashlib.sha256(silence.read_bytes()).hexdigest()}
    corrupt = args.audio_dir / 'generated-corrupt.wav'
    corrupt.write_bytes(b'not a wave file: deliberately invalid synthetic bytes')
    try:
        generator, _ = model.transcribe(str(corrupt), language='zh', vad_filter=True)
        list(generator)
        corrupt_result = {'rejected': False}
    except Exception as error:
        corrupt_result = {'rejected': True, 'error_type': type(error).__name__}
    failures = sum(r['status'] != 'decoded' for r in rows)
    report = {'model': model_manifest['repo'], 'model_revision': model_manifest['revision'],
              'dataset': samples['dataset'], 'dataset_revision': samples['revision'],
              'selection': samples['selection'], 'dataset_license': samples['license'],
              'samples_manifest_sha256': hashlib.sha256(args.samples_manifest.read_bytes()).hexdigest(),
              'cases': rows, 'failed_cases': failures,
              'aggregate_cer': None if failures else sum(r['edit_distance'] for r in rows) / sum(r['reference_characters'] for r in rows),
              'normalization': 'Unicode NFKC, lowercase, remove punctuation and whitespace; no numeral or simplified/traditional conversion',
              'load_seconds': load_seconds, 'peak_rss_kib_linux': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              'silence': silence_result, 'corrupt_audio': corrupt_result, 'generator_fully_consumed': True,
              'settings': {'device': 'cpu', 'compute_type': 'int8', 'cpu_threads': 1, 'num_workers': 1,
                           'language': 'zh', 'beam_size': 5, 'temperature': 0, 'vad_filter': True,
                           'vad_parameters': 'upstream defaults, no overrides', 'vad_sha256': VAD_SHA256,
                           'condition_on_previous_text': False, 'initial_prompt': None},
              'packages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions()},
              'blocked_python_network_attempts': len(attempts),
              'limits': ['Only five public read-speech samples, no broad quality claim',
                         'Unknown overlap with pretraining; not certified unseen data',
                         'No spontaneous speech, noisy recording, long audio, diarization or language autodetection test',
                         'No product, browser, account permission or recovery test',
                         'Python socket guard does not establish native OS-level network isolation']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('aggregate_cer', 'failed_cases', 'load_seconds', 'peak_rss_kib_linux', 'silence', 'corrupt_audio')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
