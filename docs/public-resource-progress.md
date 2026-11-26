# Making the Mashov reader safe as a public resource — progress

Working notes for the three-phase change described in
[ADR-0046](adr/0046-no-shared-mashov-account.md). Delete this file when the work
lands.

## Phase 1 — Delete the shared env credentials: **DONE**

- All 14 `useSharedSession` branches collapsed onto the per-connection path.
  Pattern A (8 per-student tasks) and Pattern B (5 connection-loop tasks);
  `notifications.task.ts` was deleted instead of collapsed.
- New `skipNoConnections()` in `sync/connection-fanout.ts` — zero connections
  reports `success` with no `sync_run`. Reasoning in ADR-0046; it hinges on the
  "T13 finding 3" comment in `freshness.service.ts`, which records what a
  bare-keyed failed row did last time.
- Deleted from `MashovSessionService`: `login`, `postSharedLogin`,
  `extractAndStoreCookies`, `getAuthHeaders`, `refreshIfExpired`,
  `ensureAuthenticated`, `initialize`, `isSessionValid`,
  `parseAndPersistHousehold`, and the shared cookie/CSRF fields.
- Deleted from `MashovHttpClient`: `get`, `getResponse`, `put`, `delete`,
  `requestWithRetryResponse`. **`send()` was NOT dead** — `requestForConnection`
  dispatches through it; it was removed and restored.
- `ensureStudentsAvailable` is a no-op without a connection, returning *before*
  the TTL probe and writing no `syncRun`.
- Deleted `session.service.ts`, `session.module.ts`, its unit spec, and
  `env-session-fence.spec.ts`. `SessionModule` **was** imported by
  `tests/integration/api.test.ts`; swapped for `MashovSessionModule` and the
  `get`/`put` doubles dropped from the override.
- Config/docs: `docker-compose.yml` (3 services), `.github/workflows/ci.yml`,
  `README.md`, `docs/architecture.md` (incl. the stale "single shared session"
  rate-limit mitigation), ADR-0030 amended, ADR-0046 written and indexed.
- Fan-out failures now carry their cause: `every connection failed for <guid>
  (tried N): <reasons>`. Without this the real error was stranded in a
  per-connection warn line and `/more` showed no diagnosis.
- `mail-inbox` sweep adopts unowned rows **only** when the household has one
  connection and the run is untargeted. Otherwise legacy NULL-owned orphans
  would be swept by nobody and inflate the badge forever.

### Still outstanding from Phase 1 (needs a human)

- **`.env.example` and `backend/.env.example`** are outside write permission.
  Remove `MASHOV_SEMEL`, `MASHOV_USERNAME`, `MASHOV_PASSWORD`; keep
  `MASHOV_BASE_URL`, `MASHOV_YEAR`.
- **`backend/.env`** still holds a real Mashov password that nothing reads any
  more. Worth deleting those three lines.

## Phase 2 — Notification-window sync: **DONE**


- `sync/source-policy.ts` — the single policy table (source, task, TTL,
  reported threshold, task sets, per-student), env-overridable, with
  `source-policy.spec.ts`. Covers all 16 sources; the six that were missing
  from the old threshold table now report health on `/more`.
- `FreshnessService` reads it; its own `SOURCE_THRESHOLDS` is gone and
  `PER_STUDENT_SOURCES` is derived from the same table.
- `NotificationsTask` deleted (nothing read `NotificationEvent`); the table and
  `ConnectionService`'s delete-on-unlink are retained.

Also done:
- Task sets on `SyncExecutionContext` (`taskSet`, `respectTtl`, `silent`), set
  filtering and per-source TTL skipping in `refreshAll`, and the roster rule
  extended to "or the scoped roster is empty" (otherwise a digest-set run on an
  empty roster fetches nothing and reports a clean success).
- `notification-window.task.ts`: digest-lead at `:50 10-18` and mail at
  `*/30 7-20`, both Jerusalem, both gated on their notification flag, scoped by
  a narrow `digest_recipient` query with no `DigestModule` import, sequential
  with jitter and a tick budget.
- All 14 per-task `@Cron` decorators and `HistoryBackfillTask` deleted. Only
  two sync crons remain, plus the rollover and the `sync_run` prune.
- `ROSTER_TTL_MINUTES` 60 → 24h.
- `SYNC_STALE_AFTER_MS` exported from `digest.service.ts`; the lead-tick/
  trip-wire relationship is pinned in `notification-window.task.spec.ts`
  against the real constant.

## Phase 3 — Login set and sync-on-read: **DONE**

- `/auth/syncing`, add-school and the header refresh all run the `login` set
  with `respectTtl: false` (a TTL-respecting manual refresh would show a
  spinner and no change). No frontend change was needed: `TASK_LABELS` already
  falls back to the raw task name and the e2e mocks use arbitrary totals.
- `SyncOnReadService` with all five guards from `ensureStudentsAvailable`:
  connection-scoped TTL probe, in-flight dedupe, a `sync_run` recorded on
  failure too, a per-process in-flight cap, and serve-stale on every error.
  Call sites: `children.service.ts` (timetable+bells, subjects, notices, and
  `getChildren` for the add-school landing) and `settings.service.ts`
  (profile). `ChildrenModule` now imports `SyncModule`.
- `GET /dashboard` deliberately NOT hooked — `FreshnessBar` polls it app-wide.
- `useDashboard` relaxed: 60s → 300s poll, 30s → 120s staleTime, window-focus
  refetch on. Nothing writes on a 60s cadence any more.

### Three bugs the new tests caught, worth remembering

- **A missing module export that nothing could see.** `ChildrenService` and
  `SettingsService` gained injected sync tasks, and `SyncModule` listed them as
  providers but not exports. `tsc` was happy (the constructor types fine) and
  all 2396 unit tests passed, because every unit spec constructs these services
  positionally with hand-made doubles — so nothing ever asked Nest to resolve
  them. It surfaced only in the Docker integration suite, minutes later, as a
  whole auth suite failing for no visible reason. `sync.module.di.spec.ts` now
  compiles the real graph with Prisma and Redis stubbed, so a missing export
  costs seconds instead of a container build. It immediately earned its keep by
  catching a follow-on slip where a provider was deleted instead of reordered.

- **The read-path dedupe had a race.** Registering the in-flight marker after
  the async freshness read let three concurrent page loads all clear the TTL
  check and all fetch — the exact amplifier the class exists to prevent. The
  marker now covers the whole decision, not just the fetch.
- **The env TTL override was broken.** `derivedStale` read the baked-in default
  rather than the effective TTL, so raising a TTL via env left the reported
  threshold where it was and the source read stale from the moment it was due.

## Code-review round (medium): 11 findings, all real

A `/code-review` pass over the working tree found 11 issues. Every one checked
out against the code; all are fixed. Two were the same class of bug this work
exists to prevent -- an unguarded upstream fetch on the request path.

**High.**

- **The read-path failure sentinel satisfied nothing.** `SyncOnReadService`
  recorded a failed attempt so a broken upstream could not leave the TTL gate
  open -- but `isFresh` read only `successRuns`, and the sentinel is written
  with status `failed`. With Mashov down, *every* `/children`, `/timetable`,
  `/subjects`, `/notices` and `/profile` request performed a fresh upstream
  login, bounded only by the in-flight cap. `isFresh` now has two gates: a
  successful run inside the TTL, or **any** attempt inside a short retry window
  (`SYNC_ON_READ_RETRY_MINUTES`, default 15, clamped to the TTL). The window is
  deliberately short: a 7-day TTL must not strand the grid for a week over one
  502. The old spec only asserted `closeRun('failed')` was called, never that
  the next call skipped -- it does now.
- **The roster's TTL never applied.** `students` is not in `buildTasks` (the
  roster runs separately), so `skipped.has('students')` was false by
  construction, `rosterInSet` collapsed to `wanted.has('students')`, and
  `StudentsTask` -- a full upstream login, with no TTL gate of its own -- ran on
  all nine digest-lead ticks per connection per day. The `students` 1-day TTL
  was dead for every set listing it. `runManualRefresh` now probes `students`
  explicitly alongside the built list.

**Medium.**

- `localIsEmpty` ran on *every* call, before any freshness decision, against
  its own doc ("called only once a fetch is committed to") -- four extra `count`
  queries per `/children` request for a two-school household even when nothing
  was stale. It was also unguarded, so a transient DB error in the count turned
  a servable page into a 500 out of a method documented "never throws". The
  in-flight operation now exposes a `committed` promise that resolves the
  moment the decision is made, so the probe runs only when a fetch is really
  happening, and a throw is caught and serves the local copy.
- **The profile freshened only the first school.** `SettingsService` passed
  `connections[0].id` while `UserDetailsTask` narrows to `context.connectionId`,
  so a two-school household's second profile was never refreshed again once the
  cron was gone -- and the emptiness probe counted across *all* connections, so
  the first view of a school-B card with no row never even waited. Now a loop
  over every connection, each probing its own rows.
- **Per-call budgets stacked.** Each `ensureFresh` waited up to
  `SYNC_ON_READ_BUDGET_MS` (4s) of its own, sequentially: ~16s for a first
  `/children` load with two schools, past the 15s frontend-proxy ceiling that
  `sync-run.service.ts` records as the thing that broke `source-health`.
  Callers now mint **one** deadline per request with `deadlineFromNow()` and
  share it across every source and connection. The fetches still run; they
  just stop being waited on.
- **Lowering a TTL via env discarded a deliberate threshold.** The fix for the
  raising direction broke the other one: `SYNC_TTL_HOMEWORK_MINUTES=30`
  replaced homework's 24h reported threshold with `max(60, 60) = 60` minutes,
  so any household not synced for an hour showed amber in the app-wide
  `FreshnessBar` -- the permanent banner `STALE_FACTOR` exists to prevent. Now
  `max(explicit, derived)`, which is correct in both directions.
- `.env.example` still invites the operator to fill in `MASHOV_SEMEL`,
  `MASHOV_USERNAME` and `MASHOV_PASSWORD` -- removed everywhere else. **Still
  outstanding; outside write permission.** See the Phase 1 hand-off above.

**Low.**

- Three comments named symbols that do not exist:
  `assertDigestLeadWithinTripWire` "in `source-policy.spec.ts`" and a
  boot-time `assertQuietHoursCovered`. The guards are real but are unnamed
  `it(...)` blocks in `notification-window.task.spec.ts`; the comments now
  point at them by suite name.
- `skipNoConnections` had been inserted between `reportNoConnectionTarget`'s
  JSDoc and its declaration, so a long doc describing a `failed` run documented
  the function that deliberately writes none. Moved below.
- `csrfToken`, `sessionCookies`, `isAuthenticating` and `authPromise` on
  `MashovSessionService` were left over from the shared session, read only by
  commented-out code -- an invitation to reintroduce the exact shape ADR-0046
  removed. Deleted.
- `skippedResult`'s comment claimed `tasksTotal` arithmetic was unchanged;
  `tasksTotal` is computed from the filtered list, so `tasks.length >
  tasksTotal` whenever anything is skipped. The comment now says what the code
  does, and why that is the wanted shape (the bar must not sit at 4/9 forever).

New regression tests: the failure backoff and its expiry, the probe not running
on the fresh path, a throwing probe, a spent deadline, the roster TTL skip and
its two overrides, the lowered-TTL threshold, and the per-connection profile
freshening.

## Merging master: a nineteenth source arrived

`GradesTask` landed on master while this branch was open (PR #58), with a
`*/12` cron, a `useSharedSession` branch and a `SOURCE_THRESHOLDS` entry -- all
three of which this branch removes. It was not a textual conflict so much as a
new instance of the same shape, so it got the same treatment as the other eight
Pattern A tasks:

- shared-session branch collapsed onto the per-connection fan-out, with the
  refusing-year guard gone and failure causes aggregated into the thrown error;
- `@Cron('*/12 * * * *')` deleted -- 120 requests per child per day for
  assessments a teacher posts a few times a term;
- added to `SOURCE_POLICY` with a 6h TTL, the 24h reported threshold it shipped
  with, `perStudent: true`, and `sets: ['full']` only;
- freshened on view in `children.service.ts:getGrades`, like `getSubjects`;
- three shared-session specs replaced by the zero-connection pair every other
  task has, plus one asserting the failure causes are carried.

`history-backfill.task.ts` was a modify/delete conflict -- master added grades
to the backfill, this branch deletes the task. Deletion wins: nothing else
references it.

Worth noting that `typecheck:tests` (added below) caught five integration-suite
constructor sites in about a second. Before it, those were the failures that
only appeared minutes later as "suites failed to run" inside Docker.

## A verification gap this work exposed

`npm run lint` typechecked `backend/src` and `backend/test`, and ran **eslint
but not tsc** over the repo-root `tests/` tree. So a signature change in
`backend/src` that broke `tests/integration/*.ts` was invisible locally and in
the `lint` CI job — it surfaced only when the Docker integration suite compiled
those files, minutes later, as three suites "failing to run" with zero test
failures reported.

That bit this change twice: once for the `SyncOnReadService` constructor
arguments and once for the deleted `HistoryBackfillTask` import. Fixed by
adding `typecheck:tests` to the `lint` chain, pointed at the
**`tsconfig.integration.json` that ts-jest already uses** — the same compile
the container does, in about a second. `npm run lint` is what CI's lint job
runs, so it is wired in automatically.

## Verification state

- `npm run lint` clean — backend lint + typecheck, frontend lint, tests lint +
  typecheck.
- Backend unit suite: **116 suites / 2398 tests** green.
- Frontend suite: **36 files / 408 tests** green.
- Integration suite: **21 suites / 527 tests** green, in Docker.
- **E2E not yet run.** `npm run test:pr:dry` reports a forced full run (the
  compose and CI changes match its full-run patterns), so e2e is required
  before this ships.
