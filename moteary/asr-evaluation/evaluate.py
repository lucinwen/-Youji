#!/usr/bin/env python3
"""Isolated local ASR evaluation. Only authored synthetic speech; no product API.

Weights and generated audio stay in /tmp. Reports preserve synthetic reference
text, full decoded segments, timing, dependency versions and original hashes.
"""
import argparse
import ctypes
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


def verify_vad():
    package = importlib.metadata.distribution('faster-whisper')
    path = Path(package.locate_file('faster_whisper/assets/silero_vad_v6.onnx'))
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != VAD_SHA256:
        raise ValueError('Missing or unverified bundled Silero VAD model; no download attempted')
    return {'filename': path.name, 'bytes': path.stat().st_size, 'sha256': VAD_SHA256,
            'source': 'bundled faster-whisper 1.2.1 asset', 'parameters': 'VadOptions defaults, no overrides'}


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for i, left in enumerate(a, 1):
        row = [i]
        for j, right in enumerate(b, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j - 1] + (left != right)))
        previous = row
    return previous[-1]


def units(text, language):
    text = ''.join(c.lower() for c in text if not unicodedata.category(c).startswith('P')).strip()
    return list(text.replace(' ', '')) if language == 'zh' else text.split()


def verify_model(directory, manifest):
    entries = {entry['file']: entry for entry in manifest['files']}
    for name in ('model.bin', 'tokenizer.json', 'config.json', 'vocabulary.txt'):
        path = directory / name
        if name not in entries or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != entries[name]['sha256']:
            raise ValueError('Missing or unverified local model file: ' + name)


def disable_python_network():
    attempts = []
    def no_network(*unused_args, **unused_kwargs):
        attempts.append('blocked')
        raise OSError('network_disabled')
    # Keep a class: ssl.SSLSocket subclasses socket.socket during import.
    class DisabledSocket(socket.socket):
        __init__ = no_network
        connect = no_network
        connect_ex = no_network
    socket.socket = DisabledSocket
    socket.create_connection = no_network
    return attempts


def synthesize(directory):
    import espeakng_loader
    lib = ctypes.CDLL(espeakng_loader.get_library_path())
    lib.espeak_Initialize.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    lib.espeak_Initialize.restype = ctypes.c_int
    rate = lib.espeak_Initialize(2, 0, espeakng_loader.get_data_path().encode(), 0)
    if rate <= 0:
        raise RuntimeError('eSpeak initialization failed')
    callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)
    chunks = []
    @callback_type
    def callback(samples, count, events):
        if samples and count:
            chunks.append(ctypes.string_at(samples, count * 2))
        return 0
    lib.espeak_SetSynthCallback.argtypes = [callback_type]
    lib.espeak_SetSynthCallback(callback)
    lib.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
    lib.espeak_Synth.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_int,
                                ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
    lib.espeak_SetParameter(1, 145, 0)
    cases = [
        {'id': 'synthetic-zh', 'language': 'zh', 'voice': 'cmn',
         'expected': '今天下午我在公园散步，然后回家整理读书笔记。明天上午十点检查项目计划。'},
        {'id': 'synthetic-en', 'language': 'en', 'voice': 'en-us',
         'expected': 'This is a synthetic recording. Tomorrow morning we will review the project plan and organize our reading notes.'},
    ]
    try:
        for case in cases:
            if lib.espeak_SetVoiceByName(case['voice'].encode()) != 0:
                raise RuntimeError('Unavailable synthetic voice: ' + case['voice'])
            chunks.clear()
            text = case['expected'].encode() + b'\0'
            if lib.espeak_Synth(text, len(text), 0, 1, 0, 1, None, None) != 0:
                raise RuntimeError('Synthetic speech generation failed')
            lib.espeak_Synchronize()
            case['path'] = directory / (case['id'] + '.wav')
            with wave.open(str(case['path']), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
                wav.writeframes(b''.join(chunks))
        silence = {'id': 'synthetic-silence', 'language': 'en', 'expected': '', 'path': directory / 'silence.wav'}
        with wave.open(str(silence['path']), 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
            wav.writeframes(b'\0\0' * 16000 * 4)
        cases.append(silence)
    finally:
        lib.espeak_Terminate()
    return cases


def reuse_audio(directory, reference):
    filenames = {'synthetic-zh': 'synthetic-zh.wav', 'synthetic-en': 'synthetic-en.wav',
                 'synthetic-silence': 'silence.wav'}
    records = json.loads(reference.read_text())['cases']
    if len(records) != 3 or {r['id'] for r in records} != set(filenames):
        raise ValueError('Reference must contain the original three synthetic cases')
    cases = []
    for record in records:
        path = directory / filenames[record['id']]
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
            raise ValueError('Existing synthetic audio hash mismatch; do not regenerate')
        cases.append({'id': record['id'], 'path': path, 'language': record['language_hint'],
                      'voice': record.get('voice'), 'expected': record['expected']})
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--audio-dir', type=Path, default=Path('/tmp/youji-asr-synthetic'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--vad', action='store_true', help='Use bundled Silero with unchanged upstream default parameters')
    parser.add_argument('--reuse-audio-from', type=Path, help='Verify and reuse existing WAVs using an earlier report; never synthesize replacements')
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    verify_model(args.model_dir, manifest)
    vad = verify_vad() if args.vad else None
    args.audio_dir.mkdir(parents=True, exist_ok=True)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
    attempts = disable_python_network()
    cases = reuse_audio(args.audio_dir, args.reuse_audio_from) if args.reuse_audio_from else synthesize(args.audio_dir)
    from faster_whisper import WhisperModel
    load_start = time.monotonic()
    model = WhisperModel(str(args.model_dir), device='cpu', compute_type='int8', cpu_threads=1,
                         num_workers=1, local_files_only=True)
    load_seconds = time.monotonic() - load_start
    rows = []
    for case in cases:
        with wave.open(str(case['path'])) as wav:
            duration = wav.getnframes() / wav.getframerate()
        start = time.monotonic()
        segments, info = model.transcribe(str(case['path']), language=case['language'], beam_size=5,
                                          temperature=0, condition_on_previous_text=False,
                                          vad_filter=args.vad, word_timestamps=True)
        # transcribe() returns a lazy generator; exhaust it to perform inference.
        segments = list(segments)
        elapsed = time.monotonic() - start
        text = ''.join(segment.text for segment in segments).strip()
        expected, actual = units(case['expected'], case['language']), units(text, case['language'])
        rows.append({'id': case['id'], 'voice': case.get('voice'), 'language_hint': case['language'],
                     'expected': case['expected'], 'transcript': text, 'duration_seconds': duration,
                     'duration_after_vad_seconds': info.duration_after_vad,
                     'inference_seconds': elapsed, 'real_time_factor': elapsed / duration,
                     'sha256': hashlib.sha256(case['path'].read_bytes()).hexdigest(),
                     'error_rate_kind': 'CER' if case['language'] == 'zh' else 'WER',
                     'error_rate': edit_distance(expected, actual) / len(expected) if expected else None,
                     'segments': [{'start': s.start, 'end': s.end, 'text': s.text,
                                   'words': [{'start': w.start, 'end': w.end, 'word': w.word} for w in (s.words or [])]} for s in segments]})
    corrupt = args.audio_dir / 'corrupt.wav'
    corrupt.write_bytes(b'not a valid synthetic wave file')
    try:
        segments, _ = model.transcribe(str(corrupt), language='en', vad_filter=args.vad)
        list(segments)
        corrupt_result = {'rejected': False}
    except Exception as error:
        corrupt_result = {'rejected': True, 'error_type': type(error).__name__}
    report = {'model': manifest['repo'], 'revision': manifest['revision'], 'model_files_verified': True,
              'device': 'cpu', 'compute_type': 'int8', 'cpu_threads': 1, 'num_workers': 1,
              'load_seconds': load_seconds, 'generator_fully_consumed': True,
              'vad_filter': args.vad, 'vad_model': vad,
              'evaluation_design': 'Seen-sample component comparison, not unseen accuracy' if args.reuse_audio_from else 'Initial fixed synthetic samples',
              'audio_reused_without_modification': bool(args.reuse_audio_from),
              'peak_rss_kib_linux': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              'blocked_python_network_attempts': len(attempts), 'cases': rows, 'corrupt_audio': corrupt_result,
              'packages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions()},
              'metric_normalization': 'Unicode punctuation removed; lowercase; Chinese spaces removed; no simplified/traditional conversion',
              'limits': ['Local eSpeak formant voices only, not human recordings or accuracy benchmark',
                         'Explicit language hints; automatic language detection untested',
                         'No product API, upload, browser, permissions, cancellation or restart test',
                         'Python socket guard is not OS-level network isolation',
                         'VAD uses unchanged upstream defaults when enabled; output is never manually suppressed']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
