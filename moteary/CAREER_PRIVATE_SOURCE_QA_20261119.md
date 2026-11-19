# Private source acceptance — 2026-11-19

Baseline: PR22 `04ef9b48eff860341960b8ed48b7d1f6a410da55`, unchanged. Local implementation checkpoint `ccb1c45dcb83e3ce74344641b0da5f5c80d9b531`. Subsequent evidence-only commit changes no runtime code. Independently built Linux binary SHA256 `e9c0782fac76e96f87c0b5deff69274bf7d30e03b009b5ff0255b4dab079a839`. Frontend production build completed before Go embedded assets. Node24.22.3, pnpm11.25.0 (declared11.0.1), Go1.27.2; no new dependency or model.

## Actual results

- Real SQLite/HTTP source acceptance:8 groups passed. PR22 database migration, old review defaults none, same-title/exact-ID set/overwrite, failed overwrite preserves prior reference, foreign/missing/self/invalid-login rejection, source PUBLIC/PROTECTED/archive unavailable with no old identity/body, review privacy required, source deletion and same-UID recreation unavailable, current corrected content fresh on open, no ordinary memo/list/native-relation metadata, text/date integrity, restart then clear/restart. Responses checked no-store.
- Same final binary repeated PR22 date acceptance:7 groups passed, including PR21 old database upgrade through both migrations, event-date filtering before paging, original ZIP integrity, ownership, capture-time distinction, restart/deletion.
- Same final binary existing manual atomic HTTP:6 groups passed (8 concurrent POSTs only1 import+7 verified and zero unlinked attachments); existing source/date retrieval HTTP6 groups passed; clean startup4/4 passed.
- Frontend: `TZ=UTC pnpm --dir web test --maxWorkers=2`:2037 passed,11 skipped. Targeted source/workspace/date39 passed. Lint/typecheck passed. UI checks are jsdom, including fresh open calls, failed reads clearing old data, account/visibility changes, blur/hide cleanup, same-title IDs and pure-text rendering.
- Go source/date/API/store/migration scoped regression passed. `GOMAXPROCS=2 GOMEMLIMIT=1GiB go test -p 1 -race ./store/db/sqlite ./server/api -run TestYouji -count=1` passed.

Evidence: `validation/career-private-source-20261119/`. Reproducer `tests/moteary/run_career_source_e2e.py` with `MOTEARY_BINARY` and trusted `YOUJI_BASELINE_BINARY` (PR22 binary SHA `4acad04d6c29c81cc63682fe227491cb80105d0270ad404ec0d86665e6a0cb7d`). Dates script uses the separately trusted PR21 binary SHA `e55614168cdb55680742ef4d3ccbc6bf19f58e0f07271928bcb4187e5b1598ba`.

## Failed attempt and limits

First source HTTP attempt passed2 groups then rejected an assertion expecting400 for a malformed source resource name; implementation returned the contract's neutral409. Test corrected to expect409 for invalid source names, retaining400 for malformed JSON shape/type/unknown fields. No product change was made to pass this assertion. Original failure retained as `first-test-expectation-mismatch.json`, from preliminary binary7ee6861a… .

No real browser/phone/Windows acceptance. Previously denied cloud-browser loopback/URL path was not retried or bypassed this round. No public listener, real/private material, ASR or other model executed. All temporary synthetic service processes stopped. MySQL/PostgreSQL schema and implementation updated but not runtime tested; SQLite only actual database acceptance.

One optional source per review, selected by exact memo ID; it opens current source body in a fresh plain-text panel, not a general graph or attachment player. No automatic legacy relation migration. Last-write-wins changes, not CAS. Permission checks occur at database query time; no system can retract already delivered bytes instantly. UI clears body on close/blur/hidden/account change and revalidates on click; it does not provide live revocation push while a page remains foreground. Full database backups may include private metadata; the source field is excluded from normal memo serialization, not from administrator backups. Rollback requires restoring pre-migration backup, not running an old binary on the migrated DB.
