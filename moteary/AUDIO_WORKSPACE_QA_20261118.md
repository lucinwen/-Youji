# Audio review checkpoint — 2026-11-18

Base: PR #10, `39c9d9bf97e4e4115dd9556e7ec8e5661cbadddb`.
Branch: `feat/audio-review-20261118`. Draft development; no main merge or release.

## User-visible delivery

A separate workspace panel accepts one local audio original, explicit local Blob
listening, optional experimental server-local transcription, UTF-8/manual transcript
input, timestamp comparison, correction and explicit PRIVATE save. Machine output
never auto-saves or silently overwrites a human draft. Its original text, revision
and segment times remain separate from the user's corrected text in one Memo.
The original file is byte-preserved in one ZIP attached to that same Memo. Filename
and corrected text are keyword-searchable, and the existing verified-original
player returns to the audio. A saved correction can be edited in the original editor.

Stable owner/audio-hash/filename identity prevents same-workflow retries from making
new records. Existing edited records refuse overwrite. Bounded unlinked-attachment
lookup checks owner and exact original bytes before reuse. Upload/save outcome
receipts survive cancellation and retries in the current view and can be downloaded;
no upload is automatically deleted on a failed request. Concurrent or conflicting
same-name uploads may require manual review, not silent cleanup.

Related-passage results now have an explicit "these candidates did not answer my
question" dismissal. It clears local results without sending feedback or recording
an answer. Offline events clear excerpts and pending requests; reconnect never
resends automatically. No ranking algorithm, answerability threshold or retrieval
accuracy claim changed.

## Evidence categories

- **Real service, model disabled:** `validation/audio-workspace-20261118/audio-http.json`
  and `web-module-http.log` exercise the actual TypeScript importer against a fresh
  SQLite/HTTP service. Three groups pass: authenticated/unconfigured state; complete
  manual transcript lifecycle; restart and final deletion. Detailed assertions cover
  original WAV bytes, PRIVATE, repeat verification, edited-content conflict,
  keyword retrieval, anonymous/second-account read and delete rejection, actual
  upload commit followed by simulated client response loss, actual Memo commit
  followed by simulated response loss, archive reuse, and deletion of source,
  transcript and associated archive rows/URL. No model executes in this harness run.
  Response-loss injection is at the client boundary, not actual network loss.
- **Module/component:** audio tests use jsdom and controlled service responses,
  including local Blob cleanup, stale callback cancellation, time/size validation,
  model unavailable, manual confirmation and source compatibility. No actual browser
  media decoder or ASR accuracy is established by these tests.
- **Go controlled process:** new Audio tests run under race detection using an
  explicitly fake Python worker. They cover auth/no-store, health, hash/timestamp/text
  consistency, input/output bounds, busy/cancellation and error redaction. They do
  not represent a real model completing under the production worker.
- **Python, no inference:** 9 audio worker tests pass, including actual PyAV decoding
  of generated WAV, corruption/121-second rejection, manifest tampering, bounded
  decoder iteration and complete consumption of a controlled segment generator.
  WhisperModel and ORT are mocked for inference-call contract checks. Five separate
  public-corpus selection/metric guards pass.
- **Real ASR attempt, blocked:** five fixed, openly licensed FLEURS human Chinese
  samples and pinned small weights were prepared. Only the first sample produced a
  confirmed stdout measurement (6/18 character errors, 5.49 seconds). Automatic
  approval review rejected continuation for an unexpected Microsoft telemetry
  connection with unknown payload. Full transcript and remaining results are not
  available. No retry through another command, model, or native-guard path occurred.
  See `validation/asr-real-20261118/blocked-run.json` and
  `asr-real-evaluation/README.md` for exact scope, public attribution and hashes.
- **Browser, blocked:** normal `chromium_sandbox=True` launch failed before page
  interaction with `socket() Operation not permitted`. Evidence:
  `validation/audio-workspace-20261118/browser-launch.json`. Sandbox was not disabled.
  Real clicks, local audio decoding, mobile layout, soft keyboard and actual devices
  remain unverified.

## Regression result

The full frontend suite passed 1,768 tests with 3 environment-conditional skips
(201 passing files, 1 skipped file; 202 total). After the final large-code-marker
fix, 76 targeted audio/workspace/semantic tests passed, including the newly added
130,000-marker input case. The actual HTTP conditionally skipped test is run
separately against the real service. TypeScript and Biome pass.

Expanded `go test -p 1 -race ./server/... ./core/...` passed 16 packages but exits
1: the sole failing test is the existing `TestUserWebhookSigningSecretLifecycle`,
whose `example.com` DNS lookup cannot use UDP in this environment. This is retained
in `go-tests.log`, not described as a fully passing suite. The separate targeted
Audio/PDF/Retrieval/Gateway race result is in `go-targeted.log`.

Cross-review also identified an overly broad restart claim. The final HTTP harness
now redownloads the ZIP after restart and checks the raw original bytes, in addition
to the corrected Memo body. It does not claim external object-store physical erasure.

## Boundaries

The optional ASR adapter is implemented and default-disabled, not accepted for
production quality or privacy. A local directory/manifest and Python offline flags
alone do not certify no native-library traffic. The production launcher includes
native network restrictions and an explicit ORT telemetry-disable call, but these
were not used to resume the rejected evaluation. It still needs separately approved
real execution and an independent native-egress audit. No private recordings were used.

The worker is a bounded subprocess, not a complete filesystem sandbox, privilege
drop or per-user CPU quota. Only short audio up to 120 seconds/16 MiB is intended;
long podcasts, live microphones, diarization and durable background jobs are absent.
The model's Chinese quality is unproven. Published read speech is not everyday noisy
conversation; the first partial metric cannot be generalized to a corpus.

Only this new single-Memo workflow gets the stated transcript-deletion behavior.
Old long-document chunks, unrelated importers, orphan uploads, backups and external
object-storage physical erasure are not covered. Save cancellation does not roll
back commits. Account checks do not eliminate every cross-tab identity race. The
same-name orphan strategy is conservative and can stop for unrelated differing
bytes. Draft text/receipts are not persisted across a browser refresh.

## Reproduction without model inference

Build the frontend and server normally, then run:

```sh
python tests/moteary/run_audio_web_e2e.py
cd web
TZ=UTC pnpm exec vitest run tests/moteary-audio-import.test.ts \
  tests/moteary-audio-import-ui.test.tsx tests/moteary-audio-preview.test.tsx \
  tests/moteary-semantic-ui.test.tsx --maxWorkers=1
```

The HTTP harness removes audio-model environment configuration by default and
checks explicit 503. Its optional real-model mode is not authorization to resume
this blocked evaluation. No denied inference command is offered as a normal setup
step. Follow `LOCAL_AUDIO.md` for the implemented contract and outstanding gate.
