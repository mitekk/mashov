# ADR-0024: School Year — Resolve from Upstream, Persist on the Connection, Scope the Rows

- **Date**: 2026-11-17
- **Status**: Accepted
- **Deciders**: Backend agent, Planner

## Context and Problem Statement

In production the family's data was frozen. `classCode`/`classNum` still showed the 2025/26
class months after the children had moved up, and the newest content in the database was dated
**28/06/2026** — read on 2026-11-17.

The crons were not broken. They ran every 5–12 minutes and recorded `syncRun` success the whole
time. They were fetching **a school year that had ended.**

Mashov names a school year by its *ending* calendar year: `year: 2026` means Sep 2025 – Jun
2026. The year is sent only in the `POST /api/login` body, but the resulting Mashov session is
**year-scoped**, so every downstream GET returns that year's data. 28/06/2026 is simply the last
school day of the year the app kept asking for.

Three defects compounded:

1. **The year was a deploy-time constant.** `MASHOV_YEAR=2026`, read in four places each with a
   literal `?? '2026'` fallback, written to `householdConnection.schoolYear`, which all 13 sync
   tasks pass to their login. Nothing ever advanced it. Worse, the connection lookup was *keyed*
   on the year (`findFirst({ where: { schoolCode, schoolYear } })`), so even a corrected env var
   would have created a second connection rather than advancing the existing one.
2. **The roster was never re-fetched.** Children exist only on the `/api/login` response — Mashov
   has no roster endpoint. `MashovSessionService.loginWithCredentials()`, the login every cron
   goes through, read `response.headers` and discarded `response.data`, throwing
   `accessToken.children[]` away on every login. There was no roster sync task, and the one
   self-heal path was gated `if (activeStudents > 0) return` — it fired only when the `student`
   table was completely empty, which is never the case when the symptom is a stale class.
3. **Staleness was invisible.** `FreshnessService` measured *when a sync ran*, never the *age of
   the content*. `latestUpdateAt` included `student.updatedAt`, which bumps on every sign-in.
   That is precisely why the freshness badge read "fresh" for five months.

## Decision Drivers

- The family must see their real 2026/27 data, and the next August rollover must happen by
  itself. A fix that needs a human to notice and edit an env var has not fixed the class of bug
- Last year's rows must survive. `homework_item` and `behavior_item` hold the only copy of the
  family's history and past dates cannot be re-fetched upstream
- Production's schema comes from `npx prisma db push --accept-data-loss` on every container boot
  (`backend/Dockerfile`), so any schema change has to be safe under that flag
- A failure of this shape must be *visible*. Thirteen green crons over a dead year is the exact
  failure mode the health page existed to catch and did not

## Considered Options

### How the year is determined

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Auto-detect from upstream, persist on the connection, re-check daily | Rolls over with no human in the loop; the connection stays the single source the 13 crons already read | Two-phase (the login body needs a year before Mashov will say the right one), so a corrected year costs one extra login | **Selected** |
| Keep `MASHOV_YEAR` as the source of truth, document the August edit | Zero new code | This *is* the bug. It already failed once, silently, for five months, and the failure is only visible to someone who knows what 28/06 means | Rejected (retained as an optional break-glass override) |
| Derive from the calendar alone | No upstream call, never lags | Cannot tell an unavailable year from a live one, so a school that publishes late would get an empty year with no signal | Rejected as the sole source; used as the floor |
| Trust `/api/schools[].years` alone | Upstream's own answer | The sample in `apis/get-api-schools.md` tops out at 2025 for a doc captured in 2026, so `years[]` appears to lag the in-progress year | Rejected as the sole source; used as the other input |

Phase 1 takes `max(calendarSchoolYear(now), maxYearFromSchoolsApi(semel))`, clamped above by
`calendar + 1` and below by the stored `connection.schoolYear` (never regress). Taking the max
rather than either input alone means an API lag is harmless and a calendar edge is caught.
Phase 2 reads Mashov's own `accessToken.schoolSettings.schoolYear` and, when it disagrees with
what was sent, **re-logs in exactly once** — the session cookies are year-scoped, so reusing the
first login's cookies would reproduce this bug a year later.

### What to do with last year's rows

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Add a `schoolYear` column and scope the reads | Keeps history; the mixing is fixed at the query layer | ~20 read sites and 8 write sites to touch; the unique keys have to change | **Selected** |
| Purge on rollover | Trivial; no column | Destroys the only copy of the family's history for data that cannot be re-fetched | Rejected |
| Year-partitioned tables | Clean separation | Enormous change for a single-household app, and `db push` has no story for it | Rejected |
| Leave them mixed | No work | `subjectCount` and the feed stay wrong, and — the real blocker — the unique keys collide | Rejected |

The unique keys were the deciding factor. `TimetableEntry @@unique([studentGuid, day, lesson])`
is the clearest case: the same day and lesson recur every single year, so without the year in the
key next year's timetable overwrites last year's row by row, silently.

## Decision Outcome

**Chosen**:

1. `SchoolYearService` (`backend/src/common/school-year/`) resolves the year in two phases and
   caches per semel for 6h. It deliberately does **not** import `MashovSessionModule` —
   `AuthModule`, `ConnectionModule` and `SyncModule` all consume it, and routing the
   `/api/schools` call through the session module would create a cycle.
2. The connection lookup in `auth.service` stops being keyed on the year and advances
   `schoolYear` in place. This is the mechanism that unfreezes existing connections with no
   admin action.
3. `SchoolYearRolloverTask` (`@Cron('0 4 * * *')` plus one-shot on boot) advances every active
   connection and re-reads its roster. This is what makes the rollover self-maintaining: it does
   not wait for anyone to sign in, and the family that stays signed in all summer is exactly the
   family that would otherwise sit on a dead year for months.
4. `persistRoster` runs on **every** connection login, and `StudentsTask` (`'students'`,
   `@Cron('*/30 * * * *')`) makes it scheduled. It runs first and alone in a manual refresh,
   because all 13 other tasks iterate `prisma.student.findMany` and cannot see a child that has
   not landed yet.
5. `schoolYear Int @default(0)` on `HomeworkItem`, `BehaviorItem`, `SubjectEnrollment`,
   `TimetableEntry` and `MessageBoardItem`, with the year absorbed into every unique key. Reads
   go through one shared `schoolYearScope()` fragment plus `currentSchoolYearFor()`.
6. `computeContentFreshness()` measures the age of the content and degrades `overallState` to
   `degraded` on `stale_year`.

`MASHOV_YEAR` survives as an optional break-glass override and is therefore **dropped from the
required-env guard**. Leaving it there would mean the app cannot boot without the very constant
that caused the freeze.

**Rationale**: the single most important property is that no human has to notice. Every other
option on the table — including the one the codebase already had — put a person in the loop
once a year and failed silently when that person did not act. The resolver plus the daily
rollover task removes the person; the content-freshness check means that if the removal is itself
wrong, the health page says so in words a parent can read rather than reporting "fresh".

`Student` is deliberately left without a `schoolYear`: GUIDs are stable across years, so the
roster sync updates `classCode`/`classNum` in place and identity is preserved.
`MailConversation`, `MailMessage` and `NotificationEvent` are left alone until there is evidence
they are year-scoped upstream.

**Positive Consequences**:
- A connection advances on sign-in *and* on a daily cron, so neither path is load-bearing alone
- The 13 existing sync tasks needed no change to their year handling — they already read
  `conn.schoolYear`, which was the right design all along; only the thing writing it was wrong
- Last year's homework and behaviour remain queryable, and a year-over-year view becomes possible
- `stale_year` fires on today's production state by both of its tests, so the check is known to
  detect the failure it was written for rather than only to compile

**Negative Consequences / Risks**:
- **`db push` is the real migration path.** Adding a *required* `Int` with no default to a
  populated table under `--accept-data-loss` can drop and recreate the table. The column is
  therefore declared `@default(0)` so the add is non-destructive, and
  `backend/scripts/backfill-school-year.ts` is what stamps `0 → 2026` and swaps the unique
  indexes in production; the committed migration exists for repo and CI parity. The script
  asserts row counts are unchanged and never deletes. **Stage 4 must not be deployed without
  running `db push` against a restored copy of the prod DB first and confirming the output says
  *added column* and never *will be dropped*.** The `db push` vs `prisma migrate deploy` tension
  deserves its own ADR and is out of scope here.
- The shared read scope admits `schoolYear = 0` alongside the resolved year, so a database where
  `db push` has added the column but the backfill has not yet run serves stale data rather than a
  blank screen. That window ends when the backfill runs.
- The roster **cannot deactivate the complement** (students in neither `children` nor
  `inactiveChildren`). `Student` has no FK to a user or connection, so it is a global table and
  the complement contains other households' children. A child removed from a family without
  appearing in `inactiveChildren` therefore stays active. Giving `Student` an owner is the real
  fix and is pre-existing scope.
- The element shape of `accessToken.inactiveChildren` is undocumented. It is parsed defensively
  (`childGuid ?? guid ?? studentGuid`, or a bare string) and the first raw sample is logged once.
- Whether Mashov rejects or silently coerces an unavailable `year` is unmeasured. That determines
  whether the single phase-2 re-login is load-bearing or merely defensive; it is cheap either way.
- `src/session/session.service.ts` is dead code (`SessionModule` is not imported by
  `app.module.ts`) yet carries a third copy of the children-persist logic. Only its hard
  requirement on `MASHOV_YEAR` was removed here, via the pure `calendarSchoolYear` helper, so the
  boot hazard is gone without threading a new dependency through unreachable code.

## Links

- Related: [ADR-0023](0023-bounding-mashov-egress-abortsignal.md) — the egress hop this work lands on top of; egress was confirmed working, which is what made the frozen year the live cause
- Related: [ADR-0018](0018-direct-mashov-credential-login.md) — the login whose body carries the year
- Related: [ADR-0012](0012-timetable-data-persistence.md) — the sync-and-store decision that makes a stored row's year meaningful
- Implemented in: `backend/src/common/school-year/`, `backend/src/auth/auth.service.ts`,
  `backend/src/session/mashov-session.service.ts`, `backend/src/sync/tasks/students.task.ts`,
  `backend/src/sync/tasks/school-year-rollover.task.ts`, `backend/src/sync/freshness.service.ts`,
  `backend/prisma/schema.prisma`, `backend/scripts/backfill-school-year.ts`
- Production hotfix runbook: `docs/ops/school-year-hotfix.md`
