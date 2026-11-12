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
