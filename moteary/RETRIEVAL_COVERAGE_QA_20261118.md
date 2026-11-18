# Retrieval coverage and offline audio assessment — 2026-11-18

Based on PR #9, fixed `922b5a787ce488025dd9f13b282f47fa416a21d5`; independent branch `feat/retrieval-coverage-20261118`. No merge or model upgrade in the retrieval implementation.

## User-visible retrieval changes

The panel now calls results **related passage candidates**, prominently warns that the records may not contain an answer, identifies model similarity versus an actual literal substring, and uses safe React text/highlighting. Scores remain secondary and explicitly are not probabilities or confidence. Cross-language omissions are stated.

Users can continue beyond the newest 100 records. Each request reads a bounded metadata list (up to 5001 to detect the 5000 limit), then processes only its current 100-record page. The UI displays the current range, list count, skipped records and truncation. Continuing replaces the old batch; it is not a global best-five ranking. Snapshot fingerprints bind owner/query/filter/metadata; list changes return 409 and require a fresh query. Oversize records are counted and cannot permanently block progress to later pages.

Metadata projections omit both body and payload. SQLite, MySQL and PostgreSQL return a constant empty payload while database filters still evaluate real stored tags. This avoids transferring/deserializing large metadata payloads into Go; it does not eliminate database scanning cost. Current-page body loading still reads up to100 full records before the worker-input budget is applied, so exceptionally large bodies can produce higher transient memory; that extreme has not been load-tested. No schema migration or persistent embedding index was introduced.

Every response rechecks all records in the current page, including non-hit records, plus the bounded metadata fingerprint. This catches the tested edit after candidate capture. It is not a transaction snapshot: final-read-to-response races, same-second modifications elsewhere, changes beyond the bounded window and disconnected browser stale displays remain limitations.

## Independent retrieval challenge

Before inference, 24 new synthetic documents and 66 queries were written and hashed in `challenge-preregistration.json`. No cutoff, weights, synonym table or embedding recipe was fitted to these results. The worker launched at that point matched the PR #9 implementation. A later regression replay follows launcher-only security changes; `embedding-recipe-check.json` proves the Encoder/windowing/validation AST is unchanged.

| Query group | Count | Top 1 | Top 5 |
| --- | ---: | ---: | ---: |
| Literal | 6 | 6 | 6 |
| Paraphrase | 24 | 23 | 24 |
| Cross-language | 24 | 0 | 8 |
| Absent topic | 12 | Not an answer classifier | All 12 return candidates |

The negative queries' highest scores range from about **0.770 to 0.860**. A score such as 0.8 cannot be declared an answerability threshold. The larger challenge shows substantially weaker cross-language retrieval than the previous tiny set; this remains an explicit product limitation. These are authored synthetic topics, not real-user accuracy or a blind product comparison.

## Security and reproducibility

- Capability GET and search POST perform complete streaming SHA-256 verification of all three model files, inside the same concurrency slot. GET has a ten-second deadline; POST includes validation in its sixty-second budget. No health hash cache.
- All 24 retrieval runtime distributions have platform-specific wheel hashes in `requirements-retrieval-linux-py312.lock`; offline `pip --require-hashes --dry-run` resolution passed. This is a lock for tested CPython 3.12/Linux x86_64, not a universal-platform package claim.
- The explicit provisioning `--read-only` option was executed twice and verified idempotent: directory0555, verified model/manifest files0444. Owner/root can still chmod; administrator ownership/read-only mounts remain deployment concerns.
- The production retrieval launcher closes inherited descriptors>=3, rejects socket standard descriptors, sets no_new_privs and installs Linux x86_64 seccomp restrictions before model imports. Native libc socket denial, inherited FD closure, child/thread inheritance and real ONNX execution were tested. Unsupported isolation fails closed.
- This is not a filesystem sandbox, privilege drop or protection against a compromised interpreter before the Python entry point. `/proc`, files, other services and deployment capabilities need separate protection. Direct research Encoder imports and the separate ASR evaluation do not silently inherit the production launcher policy.

## Real service and regression evidence

`validation/retrieval-coverage-20261118/coverage-http.json` records real SQLite/HTTP with real model inference: 126 records, a target dated2000 unreachable in the first100 but reachable in the second batch, owner/query-bound continuation, inserted/deleted records invalidating snapshots, restart behavior, deleted old-target absence, and tampered model config rejected by both status and search. The concurrent-edit case uses a clearly marked controlled pause after genuine candidate capture, then runs actual ONNX; it is deterministic fault injection, not a real user's timing measurement.

The 5000 limit and oversize-progress cases are unit-tested; 126 records are the real load test. Individual observed requests are recorded, not advertised as SLA. The first seed attempt hit the real120-writes/minute limit; pacing was added, with no limit disabled. One full frontend attempt was killed with SIGKILL; its log is retained. Final aggregate results are recorded in `validation/retrieval-coverage-20261118/final-summary.json`.

Browser launch was attempted with `chromium_sandbox=True` and failed before page interaction with socket Operation not permitted. Desktop controls, mobile layout, soft keyboard and live multi-device behavior remain unverified. No sandbox was disabled.

## Audio: actual evaluation, not a shipped transcription feature

`moteary/asr-evaluation/` provides reproducible isolated CPU int8 evaluation using non-personal eSpeak-generated audio, fixed multilingual tiny/base weights and local default Silero VAD. Complete lazy generators were consumed; source/model hashes, segment outputs, timing, licenses and failures are preserved in `validation/asr-20261118/`. Model weights, generated audio and installed packages are not uploaded.

| Same synthetic input | tiny, no VAD | tiny + default VAD | base + default VAD |
| --- | ---: | ---: | ---: |
| English normalized WER | 0% | 0% | 5.56% |
| Chinese CER | 103.125% | 103.125% | 346.875% |
| Four-second zero silence | Hallucinated “You” | Empty | Empty |
| Corrupt WAV | Rejected | Rejected | Rejected |

PyAV19.0.2 was incompatible with faster-whisper1.2.1; the isolated evaluation pins16.0.1 and retains the failure. Standard VAD fixes this silence sample without threshold tuning, but Chinese output remains unsuitable. Base was evaluated after seeing tiny's results; that comparison is not held-out validation and does not prove base generally worse. eSpeak Chinese quality and ASR model capability are confounded, and human speech remains untested.

There is no new production ASR endpoint, microphone UI or automatic transcript indexing. No private audio is sent to a cloud provider. The evaluation uses local files and a Python network guard; native UCX diagnostic socket attempts were separately denied by the host, so it does not claim the production retrieval seccomp policy or prove total native-network isolation. Original-audio upload/playback recovery behavior remains the earlier implementation, not newly certified by ASR experiments.
