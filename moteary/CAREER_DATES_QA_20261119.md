# Career dates acceptance — 2026-11-19

Implementation source checkpoint: `6194a44be82efe5a0f0ea35c7de611cc1fac2e40`, based on PR21 `51d5a06bcab691fe092f374577531c1f68b4260f`. Subsequent evidence-only commit does not change runtime source. Independently rebuilt Linux binary SHA256 `4acad04d6c29c81cc63682fe227491cb80105d0270ad404ec0d86665e6a0cb7d`. Trusted PR21 baseline rebuilt earlier: `e55614168cdb55680742ef4d3ccbc6bf19f58e0f07271928bcb4187e5b1598ba`.

## Passed

- Production frontend and Go1.27.2 backend build; Node24.22.3 / pnpm11.25.0 (project declares11.0.1); lint/typecheck.
- Final synthetic real SQLite/HTTP: 7 groups, including real PR21 database migration, old unknown record visibility, legacy-created provenance, new capture timestamp, calendar set/change/clear/leap validation, malformed requests no partial writes, native create_time edits not changing capture, content and ZIP bytes unchanged, dates before pagination, cross-account and anonymous denial, restart/relogin, deletion removes metadata and matches. See `validation/career-dates-20261119/career-dates-http.json` and `tests/moteary/run_career_dates_e2e.py`.
- Existing manual atomic HTTP 6 groups and source/date retrieval HTTP 6 groups passed on pre-checkpoint equivalent runtime source, binary `c1b9125ea3ea279cf78e2f3e51da3c8e9b665e5ee9241d25a548ad628fdd5527`. These are not relabelled as final binary runs.
- Frontend full suite: `TZ=UTC pnpm --dir web test --maxWorkers=2`: 2028 passed,11 skipped. Date/workspace targeted30 passed, including Shanghai/Los Angeles pure calendar-day preservation and no timezone conversion.
- `go test -p 1 -race ./filter ./store/db/sqlite ./server/api -run 'TestYouji|TestCompile' -count=1` passed using GOMAXPROCS2/GOMEMLIMIT1GiB. SQLite fresh/migration/guardrail/upgrade tests passed separately. No actual MySQL/PostgreSQL service tests.
- Trusted final binary clean startup:4/4 via `YOUJI_DEMO_REAL_BINARY=... python3 -m unittest discover -s tests/moteary -p test_demo_start.py`.

## Failed attempts retained and limits

Initial full frontend run:2024 passed,4 failed,11 skipped. Three stats assertions assume UTC but host uses GMT-0600; independently reproduced the same three failures on fixed PR21 unchanged files. One locale scan exceeded5s under concurrent compilation. Isolated105/105 and subsequent full UTC/limited run passed without relaxing assertions or editing unrelated tests. Initial race compile was killed while compiling modernc SQLite; reduced compile concurrency/memory budget then passed. These first failures are not product fixes.

Cloud browser attempted `http://127.0.0.1:5243/moteary`: connection refused; observation of that failed tab then rejected by browser URL security policy. No alternate network, public binding, disabled sandbox, or ASR retry. No real desktop UI, mobile viewport, phone or Windows acceptance. UI tests are jsdom. All test servers stopped; only synthetic data used.

New event date is entered on the saved record card, not inferred from text or collected in the initial editor. Legacy-created remains editable historical record time, not an immutable audit timestamp. Concurrent event edits are last-write-wins, not CAS. P1 clickable private source relations remains deferred: native relation access/cache behavior does not meet the requested withdrawn-source guarantees. No new dependencies/models/licenses added. Database rollback requires restoring the pre-upgrade backup; do not run PR21 directly against a migrated database.
