# Local retrieval checkpoint — 2026-11-18

Based on draft PR #8 (`ad8730767cfe93a2dd0b57c9245cdccf2d01159e`), on independent branch `feat/local-retrieval-20261118`. No merge, auth redesign, database schema, cloud inference or persistent vector store. Setup and license details: [LOCAL_RETRIEVAL.md](LOCAL_RETRIEVAL.md).

## Delivered behavior

A separate explicit semantic-search action in the real workspace sends a query to the current self-hosted instance. A fixed local multilingual E5 ONNX model ranks current authorized original passages; results link directly to their records. Owner is enforced on the server even if a client supplies a different creator filter. Category/source/date/space filtering is preserved. Before output, the server rereads owner/access/content and rejects changed results. Memo invalidation/SSE, scope changes, account changes and cancellation clear UI results. No model means an explicit unavailable response, with original keyword search still operational.

The model is real, optional and administrator-provisioned; no lookup table for benchmark answers. Texts are independently encoded after a real candidate-order sensitivity defect was found in shared batches. Old reproductions are retained; positive/reverse/positive replay of the final worker yields identical hits, scores and ranks.

## Actual results

| Check | Result | Evidence type |
| --- | --- | --- |
| Frontend full suite | 199 files; 1740 passed, 2 environment-dependent tests skipped; exit 0 | Vitest/jsdom, not browser |
| TypeScript / Biome | 689 files, passed | Static checks |
| Production frontend | passed, 21.11 s | Vite release build |
| Final Go executable | built; exact SHA in `http-model.json` | Compiled executable, not committed binary |
| Python importer/PDF/retrieval suite | 75 tests: 74 passed, 1 NumPy-dependent test skipped in PDF venv | Unit tests |
| Worker-specific suite in retrieval venv | 9 passed, including the above NumPy test | Unit/controlled subprocess tests |
| Retrieval/PDF/gateway Go race tests | passed | Controlled worker subprocesses; not model-quality proof |
| Expanded Go server/core race suite | 16 packages passed; server/api failed existing Webhook DNS test | Failure retained: sandbox UDP DNS unavailable |
| Real model + SQLite + HTTP | 7 groups passed | Real accounts, current binary and actual quantized model |
| Chromium with `chromium_sandbox=True` | blocked before page: socket Operation not permitted / SIGABRT | Actual launch attempt; no sandbox disabled |

The seven real HTTP groups cover anonymous denial; 20 model queries with source-byte substring checks; A/B separation including another user's PUBLIC/PROTECTED records and forged creator filter; actual TCP close during inference with busy-slot release; positive workspace category/source/date filtering and excluded category; deletion/edit invalidation on subsequent queries; restart without model returning 503 while literal search still retrieves saved content. Final real harness takes roughly 66 seconds on this shared machine, including repeated cold model loads and service checks; this is not a general latency promise.

The fixed small synthetic challenge now gives the same totals via direct worker and real HTTP:

| Query group | Cases | Expected record at rank 1 | Expected record in top 5 |
| --- | ---: | ---: | ---: |
| Literal | 12 | 12 | 12 |
| Paraphrase | 4 | 2 | 4 |
| Cross-language | 2 | 0 | 2 |

All 18 positive cases occur in the top five; 14 are first. **Both negative queries still return five candidates.** This is ranking, not an answerability classifier, calibrated confidence or universal recall evaluation. The earlier keyword-only baseline had 12/18 positive literal matches and no six semantic matches; its exact-match metric must not be relabeled as semantic top-five performance. Cross-language top-one remains weak. No real personal data or comparison against other complete products was used.

## Honest failures and limitations

- An initial concurrent test run caused Go linker processes to be killed and a frontend fork termination timeout; it was interrupted and rerun at bounded concurrency. Initial records are retained under `first-attempt-*`.
- The first HTTP harness used incorrect wrapped request bodies. It was corrected to the native Memo body, with exact saved-text assertions and nonempty candidate assertions; its vacuous empty-record result is explicitly invalidated in `invalid-harness-result.json`. An earlier PATCH shape error was also corrected. These were test-harness errors, not claimed product regressions.
- Shared-batch ONNX inference showed candidate-order-sensitive rankings. Evidence is retained; independent-input inference fixes the reproduced issue. No thresholds or answers were tuned to the challenge.
- Existing Webhook DNS failure remains; full Go suite is not green. Browser controls, mobile layout, soft keyboard, playback and multi-device UI are unverified. UI cancellation tests use mocks; the new TCP cancellation check separately verifies real socket interruption and slot recovery.
- Only latest 100 matching records / 512 KiB candidate body / 400 windows are considered. Truncation is explicit. Large collections need a future scalable authorized index. There is no reranker, OCR, ASR or generated answer in this feature.
- No durable vector index means deletion leaves no index to synchronize, but final-read-to-response races and offline browser stale displays remain possible. This does not solve existing PDF cleanup TOCTOU or old-import orphan limitations.
- Python socket blocking plus local constructors is not a native/OS network sandbox. Model processing shares the server user's filesystem access; use deployment isolation for hostile multi-user environments. One global inference slot is not a per-user CPU quota.

Evidence lives in `validation/retrieval-20261118/`; it includes only synthetic content, sanitized logs, package versions, model hashes and measured results. Model weights, venv, node_modules, databases and executable artifacts are excluded from the commit.
