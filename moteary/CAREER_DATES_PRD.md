# Career OS first loop: event date and capture time

Baseline: PR21 51d5a06bcab691fe092f374577531c1f68b4260f. P0 is a complete owner-only date workflow in the existing Youji workspace. P1 source references is independent and must not delay P0.

## Product and API contract before implementation
- Event date is optional YYYY-MM-DD calendar text, with real Gregorian validation; no timezone conversion or default to today. Empty means unknown.
- Capture time is server assigned and read-only; legacy records must identify whether the timestamp is inherited from their existing creation time rather than a historical audit fact. Editing event date must never modify capture time or memo original/content.
- Existing records stay visible under default all-dates view; unknown is visibly distinct and explicitly selectable. Date filtering must operate before pagination, not just on the loaded page.
- Authenticated owner-only metadata endpoint: GET/PATCH /api/youji/memos/{uid}/dates. PATCH {eventDate: string|null}; response {eventDate: string|null,capturedAt: RFC3339,captureTimeBasis: "captured"|"legacy-created"}. Non-owner/anonymous cannot read or mutate this metadata. Invalid date 400; absent or foreign record404.
- Existing authenticated memo listing gains native event_date CEL filtering (==, >=, <=), string calendar dates; empty string denotes unknown. Filtering combines owner/category/source/keyword before pagination. No ID-list expansion or loaded-page-only filtering. Default all-dates view retains old unknown records.
- SQLite real acceptance required. Schema consistency for supported drivers required; untested databases explicitly stated.
- Source references: evaluate native memo relations; no text disclosed for missing/withdrawn/private foreign source; opt-in and clearable. Do not claim delivered until independently tested.

## Acceptance
Synthetic brief and review with different event dates; set/change/clear date; leap days and invalid strings; date filtering across pages; old unknown records remain visible; capture timestamp stable across edits/restart; anonymous and second account denied; content/original hashes unchanged. Build production frontend+backend independently. Browser/mobile separately measured or marked untested. Never run ASR or expose public listener.

## P1 decision after native relation review
Native REFERENCE relations allow readable public/other-owner targets and existing UI may retain cached snippets. These do not meet the requested owner+PRIVATE and withdrawn-source behavior. P1 is not shipped in this date milestone; no new source association capability is claimed.

Calendar-day tests run under Asia/Shanghai and America/Los_Angeles. Legacy capture basis remains explicit; created_ts is editable and not an immutable historical audit field.
