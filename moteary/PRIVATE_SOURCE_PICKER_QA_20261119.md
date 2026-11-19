# Private source picker acceptance — 2026-11-19

Baseline PR23 `b3927af054888c8324a851f963603e9e5bfb3651`, unchanged. Local implementation checkpoint `6131daceb1b534c0b2ce23c53b23aeb0d7f43208`, Git tree `ed0be1e925b71003b255df4a6617324fd8a44051`. Remote connector commits may have different author/time metadata; PR description records the matching remote implementation and identical tree. Independently built final Linux binary SHA256 `8b5d56a700ac8ba9c31be4ff0d8acd551c4ce1fbf128ee50d4298e3c52094d83`. Evidence-only commit does not change runtime code.

## Passed

- Production frontend built then embedded by Go1.27.2. Node24.22.3/pnpm11.25.0 (declared11.0.1). No added dependency/model/migration.
- Real SQLite/HTTP selector:6 groups passed.25 eligible records paginated with pageSize2; own review/foreign/public/protected/archived excluded; candidate payload exactly name,label,eventDate,createdAt and no hidden body terms. Full-body keyword beyond2200 chars found while only bounded first-line label returned. Injection-looking keyword stays literal; invalid login/foreign context/bad token/oversized q rejected; client creator/filter cannot broaden scope.
- Critical same-title scenario: both records labelled“岗位简报”, deliberately newer update on wrong version, correct event-date ID selected explicitly. Query changes, reordering and process restart leave reference fixed; subsequent source content correction appears on fresh open, proving current body rather than historical snapshot. Permission change after selection is rejected by existing save; deleted source gives neutral unavailable without old label/body.
- Same final binary: prior source8 groups, dates7 groups, manual atomic save6 groups, source/date retrieval6 groups passed. Clean startup4/4. All synthetic services loopback-only and stopped afterward.
- Frontend full `TZ=UTC pnpm --dir web test --maxWorkers=2`:2046 passed,11 skipped. Source picker/source/workspace targeted42 passed; lint/typecheck passed. Explicit Enter search/confirm, Escape close/focus return, empty page with continuation, account/late-response cleanup and wrong-latest-same-title selection are jsdom tests. Radio selection tests use click to set selection; not a claim of real browser Space/Arrow testing.
- Go scoped SQLite/API/store regression and limited-resource race passed (`-p1`, GOMAXPROCS2/GOMEMLIMIT1GiB). Controlled real-SQLite interleaves test candidate becoming public after first lookup and review deletion/recreation with same UID: no revoked candidate or replacement context response. These are deterministic interleaves, not measured real-world race frequency.

Evidence in `validation/private-source-picker-20261119/`; reproducer `tests/moteary/run_source_picker_e2e.py` with `MOTEARY_BINARY` and trusted PR23 `YOUJI_BASELINE_BINARY` SHA `e9c0782fac76e96f87c0b5deff69274bf7d30e03b009b5ff0255b4dab079a839`. Source/date regression scripts use their separately recorded older baseline binaries.

## Corrections and limits

Independent review identified an empty candidate page with a next token that initially hid “load more”; fixed and tested before final build. Final review identity is bound to internal database ID, not just potentially reusable UID. No required acceptance failures remain in this run.

First copyable commands in `moteary/PRIVATE_SOURCE_PICKER.md` clone the exact new branch. Existing source feature document now explicitly marks #23 historical manual-ID workflow and links to the new guide; no change to frozen #23 remote. README points to the new direct route. No inherited command silently checks out #21.

No real browser/Windows/phone test; previously blocked browser path not retried or bypassed. No public listener, ASR, personal data or cloud model. MySQL/PostgreSQL adapters compile but report no tests to run; no runtime SQL claim for them. Pagination is live offset paging, not a snapshot; re-search may reorder results, but does not modify the saved reference. Candidates are query-time minimal metadata, not authorization to save/open later. Already delivered labels cannot be instantly recalled; close/blur/hide/account/error clears UI and fresh requests recheck. Existing one-source, last-write-wins, no-CAS and no instant-revocation limits remain. This is a tested draft, not a mature cross-device release.
