# Offline ASR evaluation — 2026-11-18

This is an isolated evaluation, not an integrated product transcription feature.
It uses authored synthetic text, local eSpeak NG formant voices and the multilingual
`Systran/faster-whisper-tiny` model. No private recordings were used. The generated
WAVs, virtual environment and weights stay under `/tmp`; none are added to Git.

## Observed result

Real CPU `int8` inference used one thread and one worker. The lazy `transcribe`
generator was fully consumed. Language was supplied explicitly, VAD disabled,
beam size 5, temperature 0; word timestamps were requested.

The original `results.json` is the preserved **VAD-disabled baseline**. The script
now accepts `--vad` for a separate comparison using bundled Silero VAD v6 with
unchanged upstream `VadOptions` defaults. It verifies the local asset hash before
loading and rejects missing/corrupt assets without attempting a download.

| Input | Audio duration | Inference | Observation |
| --- | ---: | ---: | --- |
| English eSpeak `en-us` | 7.19 s | 0.75 s | WER 0 after punctuation/case normalization |
| Chinese eSpeak `cmn` | 11.26 s | 1.88 s | CER 103.125%; repeated and incorrect text |
| Zero PCM silence | 4 s | 0.61 s | Hallucinated `You` |
| Corrupt WAV | — | — | Rejected with `InvalidDataError` |

With `--vad`, the same audio hashes and model revision produced these results:
English WER remained 0 (0.70 s), Chinese CER remained 103.125% (1.99 s) with
exactly the same incorrect text, and the four-second silence was fully removed,
yielding an empty transcript and no segments (0.03 s). Corrupt WAV remained
rejected. `results-vad.json` and `vad-comparison.json` preserve the full comparison.
The bundled model and default options are recorded in `vad-provenance.json`;
no VAD weights were downloaded and no thresholds were changed. This establishes
only the English/silence behavior of these samples, not general silence detection
or Chinese transcription reliability.

These are two synthetic speech samples, not a representative accuracy benchmark.
Chinese formant synthesis quality and tiny-model capability are confounded; this
test does not establish human Chinese recording accuracy. CER can exceed 100%
because insertions count. No simplified/traditional normalization was applied.
Timestamps are emitted model alignments, not independently validated timing labels.
The observed Chinese and silence outputs are unsuitable for unreviewed automatic
indexing. Neither was filtered or replaced to improve the report.

Evidence is in `validation/asr-20261118/results.json`, including the complete
transcripts, word/segment timestamps, source hashes, package versions and timing.
`initial-attempt.json` and `decoder-incompatibility.json` preserve failed attempts.
Five independent guard/metric tests passed; those tests do not substitute for ASR.

## Reproduce

Use Python 3.12 on Linux x86-64. Installation/download requires network access;
the subsequent evaluation verifies local files and disables Python socket creation.
Do not run alongside another heavy model task. The lock records this evaluation's
versions; it does not change the application's dependency files.

```sh
python -m venv /tmp/youji-asr-venv
/tmp/youji-asr-venv/bin/pip install -r moteary/asr-evaluation/requirements.lock
python - <<'PY'
import hashlib, json, urllib.request
from pathlib import Path
manifest = json.loads(Path('validation/asr-20261118/model-manifest.json').read_text())
root = Path('/tmp/youji-asr-model')
root.mkdir(exist_ok=True)
for entry in manifest['files']:
    with urllib.request.urlopen(entry['url'], timeout=120) as response:
        data = response.read()
    assert len(data) == entry['bytes']
    assert hashlib.sha256(data).hexdigest() == entry['sha256']
    (root / entry['file']).write_bytes(data)
PY
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  /tmp/youji-asr-venv/bin/python moteary/asr-evaluation/evaluate.py \
  --model-dir /tmp/youji-asr-model \
  --manifest validation/asr-20261118/model-manifest.json \
  --output /tmp/youji-asr-repeat.json
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  /tmp/youji-asr-venv/bin/python moteary/asr-evaluation/evaluate.py \
  --model-dir /tmp/youji-asr-model \
  --manifest validation/asr-20261118/model-manifest.json \
  --vad --output /tmp/youji-asr-repeat-vad.json
PYTHONDONTWRITEBYTECODE=1 /tmp/youji-asr-venv/bin/python \
  -m unittest discover -s tests/moteary -p 'test_asr_*.py' -v
```

PyAV **16.0.1 is pinned** because the initially installed PyAV 19.0.2 rejected
faster-whisper 1.2.1's `metadata_errors` argument before decoding. The network guard
uses a socket subclass so subsequent SSL module imports remain valid. It recorded
zero Python connection attempts. This is **not OS-level network isolation**:
CTranslate2's native UCX library separately attempted a diagnostic VFS Unix socket,
which the host denied; that restriction was not bypassed and inference completed.

## Provenance and licenses

- faster-whisper 1.2.1: MIT; installed package metadata and upstream license checked.
- Model: multilingual tiny, fixed revision
  `d90ca5fe260221311c53c58e660288d3deb8d356`, not `tiny.en`. The pinned model card
  declares MIT and identifies conversion from OpenAI Whisper tiny; upstream Whisper
  explicitly licenses code and weights under MIT. Downloaded blobs were checked
  against upstream Git blob IDs, and model.bin against upstream LFS SHA-256.
- CTranslate2: installed package declares MIT. Full dependency version inventory
  is retained; this evaluation does not certify redistribution of every binary.
- eSpeak NG 1.52.0 is GPL-3.0-or-later, separately from the espeakng-loader wrapper's
  MIT license. Its library/data are isolated evaluation tools, not product assets.
- PyAV's own license does not replace the licenses of bundled FFmpeg libraries.
  Product binary redistribution would need a full bundled-dependency inventory.

See `validation/asr-20261118/licenses.json`, model manifest/card and accompanying
license texts for sources and hashes. No weights, wheels, shared libraries or
voice data are included in the repository.

Remaining untested: human speech, microphones, automatic language detection,
large/long audio, streaming, product permissions and original-file linkage,
cancellation, recovery, browser/mobile interactions and multi-account isolation.

The original larger-model check was read-only: `larger-model-feasibility.json`
records base and small revisions, MIT declarations, sizes and resource constraints
at that stage. Base was subsequently authorized for an isolated comparison and
prepared at revision `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66`; its complete manifest
and pinned card are in `model-base-manifest.json` and `model-base-card.md`. Small
has not been downloaded or tested. `/tmp` is tmpfs, so weights consume memory
alongside inference; do not infer peak memory from file size.

For the base comparison, use the same hash-checked existing WAV files, without
regenerating them. This is a component comparison on samples already inspected,
not an unseen accuracy evaluation:

The base run finished with worse results on these samples: Chinese CER 346.875%
(8.97 s, long incorrect repetition), English WER 5.56% (1.64 s; `organize` became
`order`), and empty silence output (0.04 s). Corrupt WAV was again rejected. Peak
Linux RSS was 434256 KiB (about 424 MiB); load time was 1.38 s. Native UCX's diagnostic
socket remained denied, and there were zero Python socket attempts. See complete
`results-base-vad.json` and `base-comparison.json`; none of the output was replaced.
This bounded evaluation ends here: no small-model download or parameter tuning.
The result does not establish that base is generally worse than tiny: both were
tested on the same two already-inspected synthetic formant speech samples.

```sh
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  /tmp/youji-asr-venv/bin/python moteary/asr-evaluation/evaluate.py \
  --model-dir /tmp/youji-asr-base \
  --manifest validation/asr-20261118/model-base-manifest.json \
  --reuse-audio-from validation/asr-20261118/results.json \
  --vad --output /tmp/youji-asr-repeat-base-vad.json
```
