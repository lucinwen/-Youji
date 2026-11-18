"""Synthetic bounded-decoder/manifest tests; no ASR accuracy claim."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import wave

WORKER = Path(__file__).resolve().parents[2] / 'moteary/audio_worker.py'
SPEC = importlib.util.spec_from_file_location('audio_worker', WORKER)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


def wav(seconds, rate=8000):
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(bytes(rate * seconds * 2))
    return output.getvalue()


class AudioWorkerTests(unittest.TestCase):
    def make_model(self, root):
        files = []
        for name in sorted(worker.REQUIRED):
            content = ('synthetic fixture ' + name).encode()
            (root / name).write_bytes(content)
            files.append({'file': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
        manifest = {'repo': 'Systran/faster-whisper-tiny', 'revision': 'a' * 40, 'files': files}
        (root / 'manifest.json').write_text(json.dumps(manifest))
        return manifest

    def test_manifest_full_hash_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.make_model(root)
            self.assertEqual(worker.verify_model(root)['revision'], manifest['revision'])
            original = (root / 'model.bin').read_bytes()
            (root / 'model.bin').write_bytes(b'x' * len(original))
            with self.assertRaises(worker.AudioError):
                worker.verify_model(root)

    def test_manifest_rejects_paths_duplicates_and_unverified_config(self):
        for change in ('path', 'duplicate', 'missing', 'preprocessor', 'model'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest = self.make_model(root)
                if change == 'path':
                    manifest['files'][0]['file'] = '../outside'
                elif change == 'duplicate':
                    manifest['files'].append(manifest['files'][0])
                elif change == 'missing':
                    manifest['files'].pop()
                elif change == 'preprocessor':
                    (root / 'preprocessor_config.json').write_text('{}')
                else:
                    manifest['repo'] = 'unapproved/remote-model'
                (root / 'manifest.json').write_text(json.dumps(manifest))
                with self.assertRaises(worker.AudioError):
                    worker.verify_model(root)

    def test_real_pyav_decodes_short_synthetic_wav(self):
        audio, duration = worker.decode_bounded(wav(1))
        self.assertEqual(len(audio), 16000)
        self.assertEqual(duration, 1)
        self.assertEqual(str(audio.dtype), 'float32')
        self.assertTrue((audio == 0).all())

    def test_real_pyav_rejects_corruption_and_long_wav(self):
        with self.assertRaisesRegex(worker.AudioError, 'invalid_audio'):
            worker.decode_bounded(b'not an audio file')
        with self.assertRaisesRegex(worker.AudioError, 'too_long'):
            worker.decode_bounded(wav(121))

    def test_unknown_duration_decoder_stops_at_first_over_limit_frame(self):
        # Controlled decoder with no trusted duration: proves no full generator drain.
        import numpy as np
        count = []
        stream = types.SimpleNamespace(duration=None, time_base=None, codec_context=types.SimpleNamespace(thread_count=0))
        class Container:
            duration = None
            format = types.SimpleNamespace(name='wav')
            streams = types.SimpleNamespace(audio=[stream])
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def decode(self, unused_stream):
                for i in range(10000):
                    count.append(i)
                    yield types.SimpleNamespace(samples=16000, sample_rate=16000, layout=types.SimpleNamespace(channels=[1]),
                                                pts=None, to_ndarray=lambda: np.zeros((1, 16000), dtype=np.int16))
        fake = types.SimpleNamespace(open=lambda *a, **k: Container(), time_base=1000000,
                                     AudioResampler=lambda **k: types.SimpleNamespace(resample=lambda frame: [frame] if frame else []))
        with patch.dict(sys.modules, {'av': fake}), self.assertRaisesRegex(worker.AudioError, 'too_long'):
            worker.decode_bounded(b'synthetic')
        self.assertEqual(len(count), 121)

    def test_collect_consumes_every_segment_and_rejects_late_failure(self):
        consumed = []
        def segments():
            for i in range(3):
                consumed.append(i)
                yield types.SimpleNamespace(start=float(i), end=float(i + 1), text=f' 段{i}')
        result, text = worker.collect_segments(segments(), 3)
        self.assertEqual(consumed, [0, 1, 2])
        self.assertEqual(len(result), 3)
        self.assertEqual(text, '段0 段1 段2')
        def late_error():
            yield types.SimpleNamespace(start=0, end=1, text='first')
            raise RuntimeError('synthetic late inference failure')
        with self.assertRaises(RuntimeError):
            worker.collect_segments(late_error(), 3)

    def test_collect_empty_and_invalid_timestamp(self):
        with self.assertRaisesRegex(worker.AudioError, 'no_speech'):
            worker.collect_segments(iter([]), 1)
        for start, end in ((float('nan'), 1), (0, 1000), (-1, 1), (2, 1)):
            with self.assertRaisesRegex(worker.AudioError, 'invalid_audio'):
                worker.collect_segments(iter([types.SimpleNamespace(start=start, end=end, text='x')]), 3)

    def test_transcribe_uses_cpu_fixed_zh_vad_and_array(self):
        calls = []
        telemetry = []
        class FakeModel:
            def __init__(self, path, **kwargs): calls.append(('model', kwargs))
            def transcribe(self, audio, **kwargs):
                calls.append(('transcribe', kwargs))
                self_outer.assertEqual(len(audio), 16000)
                return iter([types.SimpleNamespace(start=0, end=1, text=' 合成')]), None
        self_outer = self
        metadata = {'engine': 'faster-whisper', 'model': 'synthetic', 'revision': 'a' * 40, 'language': 'zh'}
        with patch.dict(sys.modules, {'faster_whisper': types.SimpleNamespace(WhisperModel=FakeModel),
                                     'onnxruntime': types.SimpleNamespace(disable_telemetry_events=lambda: telemetry.append('disabled'))}):
            result = worker.transcribe(wav(1), '/synthetic-model', metadata)
        self.assertEqual(telemetry, ['disabled'])
        self.assertEqual(result['text'], '合成')
        self.assertEqual(calls[0][1], {'device': 'cpu', 'compute_type': 'int8', 'cpu_threads': 1, 'num_workers': 1, 'local_files_only': True})
        self.assertEqual(calls[1][1]['language'], 'zh')
        self.assertTrue(calls[1][1]['vad_filter'])
        self.assertEqual(calls[1][1]['task'], 'transcribe')

    def test_cli_missing_model_fails_closed_without_details(self):
        result = subprocess.run([sys.executable, '-I', str(WORKER), '--model-dir', '/synthetic-missing-model', '--check'],
                                input=b'', capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {'error': 'unavailable'})
        self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
