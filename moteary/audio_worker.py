#!/usr/bin/env python3
"""Explicit local ASR preview. No downloads, audio files, memo writes or index.

Requires a deployment-owned manifest.json inside a read-only local model folder.
Linux network syscall restrictions are not a filesystem or full process sandbox.
"""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import logging
import math
import os
from pathlib import Path
import re
import sys

MAX_INPUT = 16 * 1024 * 1024
MAX_DURATION = 120
RATE = 16000
MODELS = {'Systran/faster-whisper-' + size for size in ('tiny', 'base', 'small')}
REQUIRED = {'config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'}
VAD_SHA256 = '4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2'


class AudioError(Exception):
    pass


def restrict_network():
    # -I excludes the script directory from imports. Load only the trusted sibling.
    path = Path(__file__).resolve().with_name('retrieval_worker.py')
    spec = importlib.util.spec_from_file_location('_youji_network_guard', path)
    if spec is None or spec.loader is None:
        raise AudioError('unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.restrict_native_network()


def file_digest(path, expected_size=None):
    digest = hashlib.sha256()
    size = 0
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            if expected_size is not None and size > expected_size:
                raise AudioError('unavailable')
            digest.update(chunk)
    if expected_size is not None and size != expected_size:
        raise AudioError('unavailable')
    return digest.hexdigest()


def verify_model(directory):
    root = Path(directory)
    if not root.is_absolute() or not root.is_dir():
        raise AudioError('unavailable')
    with (root / 'manifest.json').open('rb') as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise AudioError('unavailable')
    manifest = json.loads(raw)
    if not isinstance(manifest, dict) or manifest.get('repo') not in MODELS or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('revision', '')):
        raise AudioError('unavailable')
    entries = manifest.get('files')
    if not isinstance(entries, list) or not 4 <= len(entries) <= 20:
        raise AudioError('unavailable')
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise AudioError('unavailable')
        name, size, expected = entry.get('file'), entry.get('bytes'), entry.get('sha256')
        if (not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9_.-]+', name) or name in ('.', '..', 'manifest.json')
                or name in seen or type(size) is not int or not 0 < size <= 2 * 1024**3
                or not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected)):
            raise AudioError('unavailable')
        path = root / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size != size or file_digest(path, size) != expected:
            raise AudioError('unavailable')
        seen.add(name)
    if not REQUIRED <= seen:
        raise AudioError('unavailable')
    # faster-whisper consumes this optional file when present; never leave it unverified.
    if (root / 'preprocessor_config.json').exists() and 'preprocessor_config.json' not in seen:
        raise AudioError('unavailable')
    return {'engine': 'faster-whisper', 'model': manifest['repo'], 'revision': manifest['revision'], 'language': 'zh'}


def verify_runtime():
    for name, version in (('faster-whisper', '1.2.1'), ('av', '16.0.1')):
        if importlib.metadata.version(name) != version:
            raise AudioError('unavailable')
    package = importlib.metadata.distribution('faster-whisper')
    vad = Path(package.locate_file('faster_whisper/assets/silero_vad_v6.onnx'))
    if not vad.is_file() or file_digest(vad) != VAD_SHA256:
        raise AudioError('unavailable')


def decode_bounded(data):
    """Decode incrementally; never call faster-whisper's unbounded decode_audio."""
    import av
    import numpy as np
    if not data or len(data) > MAX_INPUT:
        raise AudioError('invalid_audio')
    pcm = bytearray()
    decoded_duration = 0.0
    resampler = av.AudioResampler(format='s16', layout='mono', rate=RATE)

    def append(frame):
        if len(pcm) // 2 + frame.samples > MAX_DURATION * RATE:
            raise AudioError('too_long')
        pcm.extend(frame.to_ndarray().reshape(-1).tobytes())

    try:
        # Custom in-memory I/O; secondary file/network protocols are not permitted.
        with av.open(io.BytesIO(data), mode='r', options={'protocol_whitelist': 'pipe', 'probesize': '1048576', 'analyzeduration': '2000000'}) as container:
            allowed = {'wav', 'mp3', 'ogg', 'flac', 'aac', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm'}
            if not set(container.format.name.split(',')) & allowed or len(container.streams.audio) != 1:
                raise AudioError('invalid_audio')
            stream = container.streams.audio[0]
            stream.codec_context.thread_count = 1
            if container.duration is not None and container.duration / av.time_base > MAX_DURATION:
                raise AudioError('too_long')
            if stream.duration is not None and float(stream.duration * stream.time_base) > MAX_DURATION:
                raise AudioError('too_long')
            for frame in container.decode(stream):
                if not frame.sample_rate or frame.sample_rate > 192000 or len(frame.layout.channels) > 8:
                    raise AudioError('invalid_audio')
                decoded_duration += frame.samples / frame.sample_rate
                if decoded_duration > MAX_DURATION + 1 / RATE:
                    raise AudioError('too_long')
                frame.pts = None
                for output in resampler.resample(frame):
                    append(output)
            for output in resampler.resample(None):
                append(output)
    except AudioError:
        raise
    except Exception:
        raise AudioError('invalid_audio') from None
    if not pcm:
        raise AudioError('invalid_audio')
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return audio, len(audio) / RATE


def collect_segments(iterator, duration):
    segments = []
    size, previous = 0, 0.0
    for segment in iterator:  # Consume the entire lazy inference generator.
        start, end, text = float(segment.start), float(segment.end), segment.text
        if (not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start
                or start < previous or end > duration + 1 or not isinstance(text, str)):
            raise AudioError('invalid_audio')
        previous = start
        if not text.strip():
            continue
        size += len(text.encode('utf-8'))
        if size > 65536 or len(segments) >= 1000:
            raise AudioError('invalid_audio')
        segments.append({'start': start, 'end': end, 'text': text})
    if not segments:
        raise AudioError('no_speech')
    return segments, ''.join(segment['text'] for segment in segments).strip()


def transcribe(data, directory, metadata):
    audio, duration = decode_bounded(data)
    import onnxruntime
    # Defense in depth before bundled VAD session creation; this is not a
    # substitute for the native network guard or independent offline validation.
    onnxruntime.disable_telemetry_events()
    from faster_whisper import WhisperModel
    model = WhisperModel(str(directory), device='cpu', compute_type='int8', cpu_threads=1, num_workers=1, local_files_only=True)
    iterator, _ = model.transcribe(audio, language='zh', task='transcribe', vad_filter=True, beam_size=5, temperature=0)
    segments, text = collect_segments(iterator, duration)
    return {**metadata, 'sha256': hashlib.sha256(data).hexdigest(), 'duration': duration, 'segments': segments, 'text': text}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        # Native libraries can log raw decoder details; stderr is deliberately discarded.
        with open(os.devnull, 'wb') as sink:
            os.dup2(sink.fileno(), 2)
        logging.disable(logging.CRITICAL)
        import resource
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (150, 150))
        resource.setrlimit(resource.RLIMIT_AS, (4 << 30, 4 << 30))
        resource.setrlimit(resource.RLIMIT_FSIZE, (2 << 20, 2 << 20))
        restrict_network()
        os.environ.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'TOKENIZERS_PARALLELISM': 'false',
                           'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'})
        metadata = verify_model(args.model_dir)
        verify_runtime()
        if args.check:
            result = {**metadata, 'available': True}
        else:
            data = sys.stdin.buffer.read(MAX_INPUT + 1)
            if len(data) > MAX_INPUT:
                raise AudioError('invalid_audio')
            result = transcribe(data, args.model_dir, metadata)
    except AudioError as error:
        code = str(error)
        result = {'error': code if code in ('invalid_audio', 'no_speech', 'too_long') else 'unavailable'}
    except Exception:
        result = {'error': 'unavailable'}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
