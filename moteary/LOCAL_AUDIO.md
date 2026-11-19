# Local audio review (experimental)

The authenticated `/moteary` workspace accepts a local audio file (WAV, MP3, OGG,
M4A, FLAC or WebM, nonempty and at most 16 MiB). Select **试听所选本机音频**
to listen without uploading. Browser codec support is not guaranteed. Paste text
or import a UTF-8 TXT/Markdown transcript, correct it, and explicitly confirm
private storage. Saving sends the original and text to your configured Youji
server; a self-hosted server may be remote.

The original ZIP, machine draft (if explicitly requested), model provenance,
segment times and human correction live in **one PRIVATE Memo**. No duplicate
transcript Memo or persistent vector index is created. Keyword retrieval finds
saved text and the original filename. Open the same record to edit the correction;
retrying the importer with different text refuses to overwrite it. The workspace's
verified-original player can download the original bytes and compare its hash.
Machine timestamps are approximate; the explicit pre-save seek buttons do not
start playback automatically. A hash in editable text checks consistency, not
source authenticity.

## Explicit correction draft backup

Before refresh or navigation, choose **下载校订草稿 JSON**. This user-triggered file
contains the human correction and optional machine draft plus owner, filename and
original SHA-256; it contains sensitive text and must be stored appropriately. It
includes no audio bytes, makes no network request and does not use browser storage.
A save receipt contains different information and is not a transcript backup.

To restore, select the same original audio under the same account, leave the human
correction field empty, and choose **恢复校订草稿 JSON**. Version/schema, 1 MiB file
limit, 256 KiB human-text bound and source identity are checked. Optional machine
segments must satisfy the same local API bounds. Existing edits are not silently
overwritten; back them up before clearing them yourself. Restore only fills this
page and resets the save-confirmation checkbox; it never uploads, transcribes or
saves automatically. JSON metadata is editable and proves neither permissions nor
model authenticity. No service data is read during restore.

The workspace now puts quick capture before folded import panels. Folding retains
form state and does not cancel active saves; folding the audio panel pauses its
player. Keyword search remains visible while source/date controls can be folded,
and applied filter summaries remain visible. Actual phone layout and native
keyboard behavior still require a suitable browser/device acceptance environment.

## Recovery and deletion

The dedicated `/api/youji/audio-original/import` endpoint derives a stable ID
from the authenticated owner, audio hash and filename. On supported SQLite
servers, one transaction commits the original ZIP BLOB and PRIVATE record.
Retry verifies existing body and original bytes; changed corrections or legacy
originals conflict instead of overwriting. Unsupported servers return 404/501;
the client does not fall back to separate uploads. Old orphan uploads are not
adopted or automatically deleted. Download receipts before leaving.

The original is at most 16 MiB, request at most 24 MiB, and body at most 256 KiB;
account quotas still apply. This is bounded but not streaming: JSON/base64/ZIP
and SQLite buffers retain multiple copies, so concurrent large imports can use
substantial memory. It validates names and stores bytes, not codec validity or
playability. No audio decoder or model runs during saving.

Delete the source with the existing Memo delete action; the correction is part of
that same record. Old unlinked uploads need explicit review. Deletion checks do
not certify physical erasure, backups or external object storage. A cancelled or
lost-response save may have committed; retry the same input to verify. Client
identity checks are reinforced by the server's owner comparison and transaction;
this is not an all-source or all-database atomicity guarantee.

See [audio transaction validation](AUDIO_ATOMIC_QA_20261119.md) for the fixed build,
actual checks and untested boundaries. ASR assessment remains paused.

## Optional local ASR adapter — not accepted for production quality

**The current release checkpoint does not certify real ASR through this adapter.**
The independent small-model evaluation was stopped after automatic approval review
rejected continuation because of an unexpected Microsoft telemetry connection.
Its payload and delivery outcome are unknown. No alternative execution path or
model was used to bypass that rejection. The adapter stays unconfigured by default;
manual transcripts work without it. See `asr-real-evaluation/README.md` and the dated
QA report for exact evidence and remaining approval requirements.

Implementation contract for a separately authorized deployment:

- `YOUJI_AUDIO_PYTHON`: absolute path to the dedicated Python interpreter.
- `YOUJI_AUDIO_WORKER`: absolute path to `moteary/audio_worker.py` (with the trusted
  sibling `retrieval_worker.py` used for native network restrictions).
- `YOUJI_AUDIO_MODEL`: absolute local model directory, administrator-owned/read-only.
- The directory contains `manifest.json` with `{repo, revision, files:[{file,bytes,sha256}]}`.
  Allowed repositories: Systran/faster-whisper-tiny, -base, -small. Revision is a full
  40-character SHA. Required files: config.json, model.bin, tokenizer.json, vocabulary.txt.
  An existing preprocessor_config.json must also be listed. Every manifest file is
  stream-hashed on health checks and transcription. The manifest is an administrator
  trust root, not independent proof of model authorship; use recorded provider hashes.
- Dependencies currently require faster-whisper 1.2.1, PyAV 16.0.1, and the fixed
  bundled Silero VAD hash. Existing evaluation dependency/license records are under
  `asr-evaluation/` and `validation/asr-real-20261118/`. These audio dependencies do
  not have the retrieval environment's full wheel hash-lock certification.
- Linux x86_64 only: the launcher installs the existing native syscall network
  restrictions before importing inference libraries. Installation fails closed;
  tokenizer/model must be local and complete. No token is passed to the worker.
  This implementation has non-inference guard tests, **not a completed real ASR
  egress audit**. It is not a filesystem sandbox or privilege drop. Deployment still
  needs no-network isolation, read-only mounts and least privilege.

Protected API: GET `/api/youji/audio/processor`, POST
`/api/youji/audio/transcribe` (`application/octet-stream`, raw bytes). One shared
slot; health deadline 20 seconds, transcription deadline 180 seconds, worker CPU
limit 150 seconds, input 16 MiB, decoded duration 120 seconds. Incremental PyAV
resampling bounds the audio before inference. CPU int8, one thread, Chinese (`zh`),
transcribe task, default VAD and beam size 5; the lazy generator is fully consumed.
Status: 503 unavailable, 429 busy, 413 too large, 422 invalid/no speech/too long,
504 timeout. Successful preview returns original hash, engine/model/revision,
language/duration and segments/text; it writes no Memo, attachment or index.

The frontend never saves a machine draft automatically, and only an explicit action
copies it to an empty correction field. All saved text remains user-editable: the
machine draft is provenance text, not an immutable server audit record. More than
120 seconds, microphone capture, background jobs, diarization and reliable Chinese
quality are not completed features.
