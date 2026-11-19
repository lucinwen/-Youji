# Private source reference — scoped Career OS P1

Baseline PR22 04ef9b48eff860341960b8ed48b7d1f6a410da55. One optional source per private review, owner-controlled; no generic graph, no import of old relationships.

## Contract
- GET/PATCH /api/youji/memos/{uid}/source. PATCH {sourceName:"memos/uid"|null}; no other fields. Both records must currently be NORMAL, PRIVATE and owned by signed-in user; self-reference rejected. Setting/overwriting validates both in the database mutation, not only a stale preliminary read. Clearing requires owned private review and does not require source to exist.
- GET returns {status:"none"|"available"|"unavailable",sourceName?:string}. Only available includes sourceName. Never return title/snippet/content on metadata route. Missing/foreign/nonprivate review:404; invalid/missing/foreign/nonprivate source:neutral409; unauthorized401.
- GET /api/youji/memos/{uid}/source/open freshly checks both records and returns {status:"available",sourceName,content} or neutral unavailable (no identifier/body/title). Both GET routes no-store. No generic relation cache or list metadata.
- Persist source database identity in nullable private column with migrations for all supported drivers. Do not copy titles/bodies or mutate old generic relations. Deleted source must not resolve to a newly created same-name UID. Old records default none.
- UI accepts exact memo resource ID (display explains how to copy it), permits clear, and opens a fresh plain-text source view on click, with no cached snippet fallback. Same titles disambiguated by exact ID. Clear displayed source on close, account/visibility changes and before revalidation; no claim of instantaneous revocation of already delivered bytes.
- Normal memo GET/list/export and generic relation APIs must not expose this private reference metadata. No source response persists in query/local storage.

## Acceptance
Actual synthetic SQLite/HTTP: set/overwrite/clear; duplicate titles different IDs; source deletion, archive or PUBLIC/PROTECTED transition unavailable; review visibility transition denies; cross-account source and review denied; invalid login; restart; old PR22 DB migration; no content/original/date mutation; generic list lacks metadata. UI tests fresh read per click, failures clear previous data, account/unmount cleanup. Repeat PR22 date and existing saving/retrieval regressions. Browser already blocked; no repeat or bypass, no public listener, no ASR.
