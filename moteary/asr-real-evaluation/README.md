# Public human Mandarin ASR evaluation — blocked

This independent evaluation did not complete. Automatic approval review rejected
the running inference because it reported an external Microsoft telemetry
connection, outside the authorized offline scope. Payload and destination URL
were not exposed, and successful transmission was not independently established.
The evaluation was not retried, relocated or altered to bypass the rejection.

`validation/asr-real-20261118/blocked-run.json` preserves the exact rejection,
completed boundary and read-only follow-up. No final `results.json` exists. A
subsequent exact-process check found no running evaluation process. No new
telemetry permission was found in user history.

## Prepared and verified

- Model: multilingual `Systran/faster-whisper-small`, fixed revision
  `536b0662742c02347bc0e980a01041f333bce120`; 483,546,902-byte model.bin, about
  486 MB including tokenizer/config/vocabulary. Every file has a recorded hash;
  model.bin was verified against upstream LFS SHA-256. The fixed model card declares
  MIT and identifies conversion from OpenAI Whisper small. OpenAI licenses Whisper
  code and weights under MIT.
- Runtime: existing isolated faster-whisper 1.2.1, CTranslate2 4.9.0, PyAV 16.0.1,
  ONNX Runtime 1.32.0; CPU int8, one thread/worker, explicit `zh`, default Silero
  VAD, beam 5, temperature 0, no transcript prompt. Silero's packaged asset hash was
  verified. No second ASR stack was installed.
- Corpus: Google FLEURS, fixed revision
  `70bb2e84b976b7e960aa89f1c648e09c59f894dd`, `cmn_hans_cn` dev/validation,
  CC-BY-4.0. Published **human read speech**, not synthesized or user-private audio.
  Official archive SHA-256 and transcript Git blob were verified. The original
  archive and unchanged WAVs stay in runtime-cache, not Git.
- Five samples, 42.46 seconds total: first five distinct sentence IDs in dev.tsv
  order with duration at most 20 seconds. Selection was fixed before inference;
  no outcome-based exclusions. Reference texts and attribution are preserved in
  `samples-manifest.json`. Speaker gender/identity were not used in evaluation.
- Five guard/metric tests passed. Those do not establish native network isolation
  and do not substitute for successful model evaluation.

Only the first sample produced a completed stdout measurement before rejection:
6 character edits / 18 reference characters = 33.33% CER, 5.49 seconds processing
for 4.92 seconds of audio. The full transcript was not printed, so the type of
errors cannot be diagnosed. The other four samples, aggregate CER, silence,
corrupt-audio result and peak RSS are **unverified**. Do not publish an overall
Chinese accuracy or product-readiness claim from this partial measurement.

## Sources and attribution

FLEURS by Alexis Conneau, Min Ma, Simran Khanuja, Yu Zhang, Vera Axelrod,
Siddharth Dalmia, Jason Riesa, Clara Rivera and Ankur Bapna (2022):
[paper](https://arxiv.org/abs/2205.12446),
[fixed dataset card](https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/README.md),
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
No original WAV/reference modifications; only a subset was selected. CER uses
Unicode NFKC, lowercase and removal of whitespace/punctuation; it does not convert
Chinese scripts or numerals. Pretraining overlap is unknown. Five read-speech
samples are not a test of spontaneous, noisy or long-form recording.

Model/license sources:
[fixed small model](https://huggingface.co/Systran/faster-whisper-small/tree/536b0662742c02347bc0e980a01041f333bce120),
[Whisper code and weights license](https://github.com/openai/whisper#license),
[faster-whisper 1.2.1 MIT](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/LICENSE).

The lighter sherpa-onnx Paraformer Chinese-small candidate was inspected but not
downloaded: its converted model repository did not contain a LICENSE file or
license metadata at the inspected revision, so this review did not treat model
redistribution permission as established. The parent prioritized the existing
faster-whisper worker interface. No sherpa integration is claimed.

## Worker handoff, not deployment approval

Prepared model directory:
`/workspace/scratch/10a41183bc23/youji-runtime-cache/asr-real-small`.
It includes `manifest.json` with `{repo, revision, files:[{file, bytes, sha256}]}`.
Prepared fixture directory:
`/workspace/scratch/10a41183bc23/youji-runtime-cache/asr-real-fleurs`.
The five filenames/hashes are in the samples manifest.

Use the mature `WhisperModel(local_directory, local_files_only=True, device="cpu",
compute_type="int8", cpu_threads=1, num_workers=1)` interface and exhaust the
`transcribe` generator; do not reimplement decoding. Return original transcript
and segment start/end times with model revision, original audio hash and explicit
processing status. No silent transcript substitution or quality guarantee.

**Do not rerun this blocked evaluation or enable this runtime on private inputs
until the review blocker is resolved through approved evidence.** Python socket
replacement and offline environment flags were insufficient. Native-level egress
prevention must be independently verified before dependency imports/inference;
simply changing telemetry settings or invocation paths is not a justified retry.
No production API, browser, authorization, recovery or mobile test was performed.

`fetch_samples.py` documents reproducible public-data acquisition and fixed
selection. `evaluate.py` preserves the attempted computation for review, not as
an instruction to resume a denied action. Guard tests remain independent:

```sh
PYTHONDONTWRITEBYTECODE=1 /tmp/youji-asr-venv/bin/python \
  -m unittest discover -s tests/moteary -p 'test_asr_real_evaluation.py' -v
```
