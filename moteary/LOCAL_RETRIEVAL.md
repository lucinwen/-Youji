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
/absolute/path/youji-retrieval-venv/bin/pip install -r moteary/requirements-retrieval.txt
# Explicit provisioning step: downloads public model files, never user records.
python3 moteary/prepare_retrieval_model.py --directory /absolute/path/e5-small
export YOUJI_RETRIEVAL_PYTHON=/absolute/path/youji-retrieval-venv/bin/python
export YOUJI_RETRIEVAL_WORKER=/absolute/path/checkout/moteary/retrieval_worker.py
export YOUJI_RETRIEVAL_MODEL=/absolute/path/e5-small
./build/youji --addr 127.0.0.1 --port 5230 --data /absolute/path/data
```

All paths must be absolute and controlled by the administrator. In the workbench, optionally apply category/source/date/space filters, then enter a description under “近义 / 跨语言找回” and click “尝试语义找回”. The keyword input is independent. Open each returned original record to verify meaning and context. A score is **not a probability**, and even a query with no matching answer may return five plausible-looking candidates.

The model preparation script pins revisions and checks hashes before replacing files. Serving requests never call it or any downloader. Worker startup hashes all required local files and fails closed if missing or modified. The runtime uses only local file constructors, offline flags and a Python socket guard. No token or parent environment is passed to the worker. This is not an OS network/filesystem sandbox: ONNX/native libraries run with the server process user's access. Deploy with a low-privilege user and network egress restrictions where stronger isolation is needed.

## Scope, resource and consistency bounds

- Authenticated GET `/api/youji/retrieval/processor` and POST `/api/youji/retrieval/search`. Requests use the existing gateway authentication. Query text is in POST JSON, not URL.
- The server derives the owner from the authenticated identity. It independently enforces owner, access scope, NORMAL state, no comments, and authorized CEL filters before sending text to the worker. Browser-supplied creator filters cannot broaden this boundary.
- Latest 100 matching records, at most 512 KiB original content and 1 MiB serialized worker input. Candidate truncation is displayed. It is not an exhaustive search over large libraries.
- At most 400 round-robin original-text windows of 256 Unicode characters with 32-character overlap; tokenizer capped at 512 tokens. A pathological string can still be token-truncated within its displayed source window. Each text is encoded independently: the earlier shared-batch implementation showed candidate-order-dependent scores, and positive/reverse/positive replay now gives identical results. No invented summary. At most five distinct records, best window per record; window budget truncation is reported.
- One query process at a time, 60-second server timeout, worker 50 CPU seconds and 3 GiB address-space ceiling, capped output. Requests may be rejected as busy; this is a small-instance pilot, not a multi-user scheduling service.
- No persistent vectors or content cache. Every query reads current records; before response the server rechecks owner/access/filter and exact content. Changed/deleted/archived records reject that response. UI clears results on memo cache invalidation/SSE, scope change, account change or cancellation. A final read-to-response race remains, and disconnected clients cannot instantly learn remote deletions.
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

The 20-case synthetic challenge is deliberately small and includes negative queries. Do not describe its numbers as general recall, user productivity, or a mature multilingual search benchmark. Direct-worker tests and real HTTP tests are distinct from browser interaction tests. See `validation/retrieval-20261118/` and the accompanying QA record for actual outcomes.
