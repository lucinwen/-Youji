# 拾微工作台 (Moteary workspace)

An authenticated, additive workspace at `/moteary` on the complete Memos application.
The existing timeline, editor, search, Spaces, attachment library, and settings remain available.
This is a Chinese-language product increment, not a replacement for the upstream multilingual app.

## Capture and provenance

Six entry points seed the **original `MemoEditor`** with editable Markdown:
text, links, podcast timestamps/excerpts, conversation excerpts, images, and files.
The user enters or selects the material; these entry points do not fetch a webpage, connect a
messenger account, or transcribe a podcast. Original editor recording/upload and any
instance-configured upstream processing remain unchanged.

- `#拾微` selects this collection.
- `#diary`, `#work`, `#idea`, or `#reference` are organizational categories, **not permissions**.
- `#source/text|link|podcast|conversation|image|file` records the user-selected source kind.
- Source material and the user's commentary have separate Markdown sections.
- Tags are editable provenance, not proof of origin or verification.

The list is server-filtered by the authenticated creator, the workspace tag, optional category,
and optional Space. It only counts loaded records, supports pagination, and reports errors
without converting them into empty-state or success messages. Records open in the original
memo detail route. Archival and untagged records remain accessible through upstream views.

## Draft and save behavior

`MemoDraftSeed.content` is optional. It applies only when the original editor's user-scoped
cache has no entry. Existing text, attachments (including an attachment-only draft), visibility,
and Space metadata take precedence. New workspace drafts have separate identities per source
kind, category, Space, and user. Cancel dismisses without clearing the draft; original save logic
owns upload, pending, retry, visibility, and memo creation. Success is shown only after its
`onConfirm` callback. Account changes remount the workspace.

Storage is the current Memos instance. This interface does not claim offline availability,
end-to-end encryption, cross-device synchronization, or AI processing completion. In particular,
ordinary image uploads may process image bytes and remove EXIF. The separate importer archive
workflow is the path for byte-preserved originals; this UI does not claim that guarantee.

## Verification

From `web/`:

```sh
pnpm exec vitest run tests/moteary-sources.test.ts tests/moteary-workspace.test.tsx tests/use-memo-init.test.tsx tests/router-config.test.tsx
pnpm lint
TZ=UTC pnpm test
pnpm release
```

The upstream `filtered-memo-stats.test.ts` uses UTC-midnight fixtures and fixed UTC date
expectations, so the aggregate test command explicitly uses UTC. This does not change the
application's timezone handling. Browser/API verification uses isolated synthetic accounts and
must be recorded separately from component tests.

## Verified batch-audio recovery

Batch audio archives with one local `.original.zip` attachment and one recorded SHA-256
now expose an explicit **校验并试听原件** action on the source card. It fetches only the
same-instance attachment after a click, bounds the archive stream to 17 MiB and decoded
original to 16 MiB, requires exactly one matching ZIP entry, and compares the original hash
before creating a temporary audio Blob URL. Playback is not automatic. The user can download
the verified raw audio, close/release it, or cancel an in-flight read. Closing/unmounting stops
the media, aborts the request and revokes the object URL. Attachment/hash changes remount the
preview; account changes remount the entire workspace.

WAV, MP3, OGG, M4A, FLAC and WebM extensions are recognized, but actual codec support depends
on the browser; a decoding failure keeps the verified download available. A user-editable hash
checks consistency with the record, not source authenticity. This performs no ASR, OCR, model
call, persistent browser storage or remote URL fetch. Other archives retain the existing memo
attachment flow. No change to the native editor's separate large-file upload path.

`tests/moteary-audio-preview.test.tsx` covers archive/hash bounds, authentication request shape,
no prefetch, failed reads/retry, cancellation, media cleanup and original Blob bytes with jsdom
and mocked fetch. It is **not browser media-decoder evidence**. The separate
`scripts/youji_browser_smoke.py` exercises real Chromium decoding, original download and a
390×844 layout when a suitable browser runtime is available; see the dated QA report for its
actual execution status.
