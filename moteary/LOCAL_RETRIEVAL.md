# Optional local semantic retrieval

This adds a separate **experimental semantic ranking** panel to `/moteary`. Keyword search remains available and unchanged. It retrieves existing original passages and links, not generated answers. Model inference runs on the current Youji server, which may be a remote self-hosted instance, not necessarily the browser's computer.

## Actual component reuse and license

Memos remains the only record store. No vector database, cloud embedding provider, or persistent derived index is added. The optional worker directly uses ONNX Runtime 1.23.2 (MIT), Hugging Face tokenizers 0.22.1 (Apache-2.0), and NumPy 2.3.5 (BSD plus bundled dependency notices). Their actual distribution licenses are in `moteary/licenses`; the tested transitive environment is recorded in `validation/retrieval-20261118/python-environment.txt`.

Model: [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small), fixed revision `614241f622f53c4eeff9890bdc4f31cfecc418b3`. The model card declares MIT. The E5 upstream [Microsoft UniLM license](https://github.com/microsoft/unilm/blob/master/LICENSE) is retained as `e5-upstream-MIT.txt`; this is upstream license text, not a claim the model repository contains its own LICENSE file. The original model card was inspected at the fixed revision; its SHA-256 was `0038de97aee16258cecbad7ffda4b4febd6953e747a00e0ddbc8e6ed241e9c1c`. No model weights are committed or redistributed by this PR.

We use the publisher's quantized `onnx/model_qint8_avx512_vnni.onnx` (118,346,824 bytes), local tokenizer (17,082,730 bytes), and config. Exact expected hashes are in `retrieval_worker.py`. Query/passage prefixes, attention-mask mean pooling and L2 normalization follow the model's documented retrieval recipe; the adapter is our code. The quantized variant was tested on this CPU only; portability and accuracy on other architectures are not certified. FastEmbed was evaluated as an alternative, but **not integrated**. No test-case synonym dictionary or answer lookup is used.

## Administrator setup

The default installation has no model requirement. Missing paths/files produce an unavailable status; existing keyword search still works. This does not change default Go/web dependencies or Docker packaging.

```bash
python3 -m venv /absolute/path/youji-retrieval-venv
/absolute/path/youji-retrieval-venv/bin/pip install --require-hashes -r moteary/requirements-retrieval-linux-py312.lock
# Explicit provisioning step: downloads public model files, never user records.
python3 moteary/prepare_retrieval_model.py --directory /absolute/path/e5-small --read-only
export YOUJI_RETRIEVAL_PYTHON=/absolute/path/youji-retrieval-venv/bin/python
export YOUJI_RETRIEVAL_WORKER=/absolute/path/checkout/moteary/retrieval_worker.py
export YOUJI_RETRIEVAL_MODEL=/absolute/path/e5-small
./build/youji --addr 127.0.0.1 --port 5230 --data /absolute/path/data
```

This tested lock targets CPython 3.12 on Linux x86_64; it includes all 24 runtime distributions and exact wheel hashes. Other platforms require separately verified packages and are not enabled by the current network-isolation worker. All paths must be absolute and controlled by the administrator. The read-only option seals the dedicated model directory with 0555 and model/manifest files with 0444 mode bits. The owner or root can still change these bits; use a separate administrator owner and a read-only mount for a stronger boundary. Reprovision into a new dedicated directory; the serving account should not unseal or download into the active model directory. In the workbench, optionally apply category/source/date/space filters, then enter a description under “近义 / 跨语言找回” and click “尝试语义找回”. The keyword input is independent. Open each returned original record to verify meaning and context. A score is **not a probability**, and even a query with no matching answer may return five plausible-looking candidates.

The model preparation script pins revisions and checks hashes before replacing files. Serving requests never call it or any downloader. Both capability GET (10-second deadline) and search POST stream and verify all three fixed hashes within the same concurrency slot, with no cache. Worker startup verifies hashes again before loading. Missing/modified files fail closed, and a busy health check is shown as busy.

The production worker requires Linux x86_64 with `close_range` support (Linux >= 5.9). Before importing model libraries it closes inherited descriptors >=3, rejects socket standard descriptors, sets `no_new_privs`, and installs a seccomp filter denying socket creation/connect/traffic syscalls, io_uring, x32 compatibility and common cross-process descriptor/memory access paths. The filter is installed in the fresh single-threaded process; subsequently created threads/children inherit it. Native libc IPv4/IPv6/Unix socket denial, inherited socket closure and child/thread inheritance have been tested. If installation is unavailable, inference fails closed. Offline flags and the Python socket guard remain additional checks, not the primary native-network claim.

This is **not a complete filesystem/process sandbox or privilege drop**. The worker still has the server user's allowed filesystem access; `/proc`, filesystem-mediated IPC, administrators and deployment capabilities require separate protection. Go passes no API credential environment and uses pipe stdin/stdout with discarded stderr. Directly importing `Encoder` in a research script does not install the production launcher restriction; the direct synthetic benchmarks separately report their actual guard. The filter is installed by the Python entry point after interpreter startup, so the interpreter and startup hooks must themselves be trusted and administrator-controlled. Strong deployments should isolate the service account, enforce deployment-level egress policy and mount model/runtime files read-only.

## Scope, resource and consistency bounds

- Authenticated GET `/api/youji/retrieval/processor` and POST `/api/youji/retrieval/search`. Requests use the existing gateway authentication. Query text is in POST JSON, not URL.
- The server derives the owner from the authenticated identity. It independently enforces owner, access scope, NORMAL state, no comments, and authorized CEL filters before sending text to the worker. Browser-supplied creator filters cannot broaden this boundary.
- The bounded candidate list includes up to 5000 matching metadata records, newest first, and explicitly reports if older records exceed that limit. Each request processes the next 100 records, with at most 512 KiB content and 1 MiB serialized input. The UI offers an explicit continuation button and replaces the previous batch results; these are per-batch top five, never a global top five. Oversize/budget-skipped records are counted and cannot permanently block later batches. The 5000 cap is not a general large-library scalability claim. The worker-input budget is enforced after loading the current page: up to 100 full bodies can still be read from the database first. Extreme individual memo sizes have not been load-tested; the 512 KiB budget is not a hard bound on total server memory.
- At most 400 round-robin original-text windows of 256 Unicode characters with 32-character overlap; tokenizer capped at 512 tokens. A pathological string can still be token-truncated within its displayed source window. Each text is encoded independently: the earlier shared-batch implementation showed candidate-order-dependent scores, and positive/reverse/positive replay now gives identical results. No invented summary. At most five distinct records, best window per record; window budget truncation is reported.
- One query process at a time, 60-second server timeout, worker 50 CPU seconds and 3 GiB address-space ceiling, capped output. Requests may be rejected as busy; this is a small-instance pilot, not a multi-user scheduling service.
- No persistent vectors or content cache. A continuation snapshot binds owner, query, filters and bounded metadata; list changes reject continuation. Every batch reads current records; before response the server rechecks the entire current page’s owner/access/filter and exact content, then the metadata fingerprint. Changed/deleted/archived records reject that response. Same-second changes to another page are not a transaction snapshot, and records beyond the bounded list are not covered. UI clears results on memo cache invalidation/SSE, scope change, account change or cancellation. A final read-to-response race remains, and disconnected clients cannot instantly learn remote deletions.
- Cancellation kills the inference subprocess; this feature writes no memos or attachments. Existing PDF deletion/attachment concurrency limits are not fixed by retrieval.

## Reproduce validation

```bash
/absolute/path/youji-retrieval-venv/bin/python -m unittest discover -s tests/moteary -p test_retrieval_worker.py
/absolute/path/youji-retrieval-venv/bin/python tests/moteary/benchmark_retrieval.py \
  --model-dir /absolute/path/e5-small --output /tmp/youji-benchmark.json
YOUJI_RETRIEVAL_PYTHON=/absolute/path/venv/bin/python \
YOUJI_RETRIEVAL_MODEL=/absolute/path/e5-small \
python3 tests/moteary/run_retrieval_web_e2e.py
```

The earlier 20-case challenge and the subsequent preregistered 66-query challenge are synthetic and include negative queries. The larger challenge exposes weak cross-language ranking and high scores for unrelated candidates; no score cutoff was fitted. See the newer coverage QA record for those results. Do not describe its numbers as general recall, user productivity, or a mature multilingual search benchmark. Direct-worker tests and real HTTP tests are distinct from browser interaction tests. See `validation/retrieval-20261118/` and the accompanying QA record for actual outcomes.
