# Redefine `MASHOV_YEAR` as the earliest year to fetch, not the year in scope

## Context

PR #8 fixed the frozen school year: the current year is now auto-detected from
upstream (`SchoolYearService`), reconciled against Mashov's own answer on every
login, persisted on `householdConnection.schoolYear`, and re-checked daily. In
that work `MASHOV_YEAR` was demoted to an optional break-glass *override* —
when set, it pins the current year.

That demotion left the variable actively misleading. `resolveForSchool`
short-circuits on it (`school-year.service.ts:73-76`) before the cache, the
`/api/schools` max, the stored-year clamp and the ceiling, so a value of `2026`
means "the current year is 2026" — which is exactly the frozen-year condition
the branch exists to prevent. Production still has `MASHOV_YEAR=2026` set while
the live year is 2027, so the one lever whose name suggests it controls the
school year is the lever that would re-break it.

**New meaning.** `MASHOV_YEAR` is the *earliest* school year to fetch from. It
never influences which year is current. Unset, it equals the current year, so
the default behaviour is unchanged. Either way the current year is always
fetched and always reachable — that property is what the variable must stop
being able to break.

### Decisions taken

| Question | Decision |
|---|---|
| Does it still affect the current year? | **No.** `resolveForSchool` stops reading it entirely. |
| Fetch strategy | Crons keep running the current year only. A separate backfill fetches each historical year **once**, resumable, and no-ops when complete. |
| How far back | `max(MASHOV_YEAR, currentYear - 2)`, further narrowed to years `userSchoolYears` says the child actually has. The cap is deliberate: each extra year is a separate login plus a per-student fetch across eight task types. |
| Where history appears | Lists and feeds span the range. "What is true now" views stay current-year. |
| Staleness signals | `latestUpdateAt`, the freshness badge and `contentFreshness` stay **current-year only**. |
| Name | Keep `MASHOV_YEAR`. Prod needs no `.env` change, and its existing `2026` becomes correct under the new meaning. |

### Why staleness signals stay single-year

A range would let a child with nothing yet this year report last June's
homework as their latest update. That is the precise blindness that hid the
original bug for five months, and `dashboard.service.ts:297-299` and
`children.service.ts:88-90` carry comments saying so. Widening those reads
would undo PR #8's only detection mechanism while leaving its cause fixed.

---

## Stage 1 — Two scopes instead of one

`backend/src/common/school-year/school-year.scope.ts` today exports
`schoolYearScope(year)` -> `{ schoolYear: { in: [year, 0] } }` and
`currentSchoolYearFor(prisma, userId?)`. Both stay; add the range alongside.

```ts
export interface SchoolYearWindow { start: number; current: number }

/** The current year alone — "what is true now", and every staleness signal. */
export function currentYearScope(year: number) { /* = today's schoolYearScope */ }

/** The configured history window. `0` keeps half-migrated rows visible. */
export function historyScope(w: SchoolYearWindow) {
  return { OR: [{ schoolYear: UNSCOPED_SCHOOL_YEAR },
                { schoolYear: { gte: w.start, lte: w.current } }] };
}

/** Resolves both ends. Free function taking prisma, like currentSchoolYearFor. */
export function schoolYearWindowFor(prisma, config, userId?): Promise<SchoolYearWindow>
```

`start` = `max(MASHOV_YEAR ?? current, current - 2)`, clamped `<= current`. A
`MASHOV_YEAR` above the current year is ignored with a logged warning rather
than honoured — it would otherwise produce an empty window.

Keep `schoolYearScope` as the name for the current-year fragment (it is already
correct at every site that keeps it) and introduce `historyScope` for the
widened ones, so the diff reads as "this site opted into history" rather than
"every site changed meaning".

## Stage 2 — Apply the right scope per read site

Mechanical, but the split is the whole substance of the change. Representative
paths; the full list is the existing `schoolYearScope` call sites.

**Widen to `historyScope`** — lists and feeds, where more data is the point:
- `backend/src/feed/feed.service.ts:43,:47` — the two unbounded `orderBy desc`
  reads. Replace the comment at `:32-33`, which currently states the opposite
  intent.
- `backend/src/children/children.service.ts:190` (`getHomework`), `:257`
  (`getBehavior`) — `pagination.total` grows by design.
- `backend/src/dashboard/dashboard.service.ts:123,:128` — the "latest 20"
  lists. Ordered `desc`, so history surfaces only when the current year is
  sparse. In September that means the dashboard shows last year's items rather
  than being empty; that is the intended behaviour under this change, and the
  unchanged `latestUpdateAt` is what still reports the year as quiet.

**Keep `currentYearScope`** — present-tense views and all staleness signals:
- `children.service.ts:523` (`getTimetable`) — one row per
  `(studentGuid, schoolYear, day, lesson)`. A range returns two subjects for
  the same slot and the payload at `:530-542` carries no year to disambiguate.
- `children.service.ts:551` (`getSubjects`), `:72` / `:129` (`subjectCount`),
  `:132` (`_sum.weeklyHours`) — `groupId` recurs yearly, so a range doubles the
  subject list, the count and the weekly-hours total.
- `children.service.ts:75,:80` and `dashboard.service.ts:261,:266` — the
  `findFirst … desc` pairs behind `latestUpdateAt`.
- `dashboard.service.ts:91,:97,:245,:253` and `children.service.ts:785,:793` —
  the 7-day activity counts. The window already bounds them; a range only adds
  the risk of counting a prior-year row dated inside the window.
- `children.service.ts:660` (`getNotices`) — `expirationDate > now` self-scopes.
- `freshness.service.ts:109,:113` are already unscoped on purpose and stay so.

**Indexes.** `feed.service.ts` filters on `schoolYear` with no `studentGuid`,
so the existing compound uniques (all leading on `studentGuid`) cannot serve a
range predicate, and the reads load every row into memory before paginating.
Add `@@index([schoolYear, lessonDate])` to `HomeworkItem` and
`@@index([schoolYear, eventAt])` to `BehaviorItem`. Additive, so `db push`
adds them without a rewrite.

## Stage 3 — Per-year fetching

### 3a. Key the session cache on the year (prerequisite — do this first)

`connectionSessions` (`mashov-session.service.ts:91`) is keyed on
`connectionId` alone, and `:707-710` returns a cached entry **without comparing
the requested year**. Today nothing asks for two years, so it is latent. The
moment a backfill exists, it and the 13-task `Promise.all`
(`sync.service.ts:92`) race for one connection, and the loser reads the
winner's year while stamping its own — wrong-year rows written under a correct
unique key, with no error anywhere. `getForConnection`'s 401/403 retry
(`mashov-http.client.ts:81-88`) cannot catch it: the wrong-year response is a
valid 200.

Change the key to `` `${connectionId}:${year}` `` in `connectionSessions`,
`lastLoginByConnection` and `lastRosterByConnection`, and make `forceRefresh`
evict only that composite key. Two years may then be in flight for one
connection concurrently, which is what makes the backfill safe to run beside
the crons.

`refreshRosterForConnection:481-493` currently depends on whole-connection
eviction to force a fresh session after a year correction; with a composite key
it must evict the *old* year's entry explicitly. That is a behaviour-preserving
edit, and the existing test "refreshes the roster even when active students
already exist" plus a new "does not reuse a session cached for a different
year" cover it.

### 3b. Thread the year through the task context

`SyncExecutionContext` (`backend/src/sync/sync.types.ts:4-6`) gains two fields:

```ts
export interface SyncExecutionContext {
  connectionId?: string;
  /** Fetch and stamp this year instead of the connection's current year. */
  schoolYear?: number;
  /** Prefixes syncRun.source so a backfill cannot mask live-source health. */
  sourcePrefix?: string;
}
```

In each of the eight year-scoped tasks, `schoolYear` becomes
`context.schoolYear ?? connections[0]?.schoolYear ?? fallbackSchoolYear`, and
the same value is passed as `getForConnection`'s `year` argument — one variable
feeding both the login year and the row stamp, as it already is. On the
shared-session path (`useSharedSession`, `homework.task.ts:57`) a historical
year is **not** supported: that path goes through the process-global session,
which has no per-year identity. The backfill only ever runs with an explicit
`connectionId`, so it never takes that path; guard it with an early return and
a log rather than silently fetching the wrong year.

### 3c. Source naming — prefix, never suffix

`freshness.service.ts:275-277` treats any key matching
`` k.startsWith(`${source}:`) `` as a variant success of `source`. So a
backfill run named `homework:<guid>` — or `homework:<guid>:2026` — would
register as a **fresh `homework` success** and mask a current-year homework
failure, recreating PR #8's blindness by a new route.

Therefore `sourcePrefix = \`history:${year}:\``, giving
`history:2026:homework:<guid>`. That matches no entry in `SOURCE_THRESHOLDS`
(`freshness.service.ts:18-35`, an allow-list by base name) and no
`startsWith('homework:')` test, so it is invisible to source health — correct,
since a completed historical year says nothing about whether live syncs work.

`sync.controller.ts:79-86` does a bare `groupBy(['source'])` and compares
`>= TOTAL_SYNC_SOURCES`. Add `source: { not: { startsWith: 'history:' } }` to
that `where`, or the backfill's rows inflate `sourcesCompleted` and trip `done`
before the real sync has finished. (That count is already fragile for
per-student sources — see the carried-forward note below — but this change must
not make it worse.)

### 3d. Persist `userSchoolYears`

Discarded today at `school-year.service.ts:136-143`. Add
`schoolYears Json @default("[]")` to `HouseholdConnection` — **`Json`, not
`Int[]`**, matching every other list in the schema (`labels`,
`teachers`, `files`, `recipients`) and additive for `prisma db push`. Write it
in `parseAndPersistHousehold` (`mashov-session.service.ts:651-681`) and on the
roster refresh path from `accessToken.userSchoolYears`, which
`apis/post-api-login.md:125` documents as always present.

### 3e. `HistoryBackfillTask`

New `backend/src/sync/tasks/history-backfill.task.ts`, `@Cron('0 3 * * *')`.
**No `onApplicationBootstrap` hook** — the rollover task's awaited hook was a
finding on PR #8 for exactly this reason.

Per active connection:
1. `current = connection.schoolYear`;
   `start = max(MASHOV_YEAR ?? current, current - 2)`.
2. Candidate years = `[start … current - 1]`, descending so the most recent and
   most useful year lands first if the run is interrupted. The current year is
   the crons' job and is never in this list.
3. Intersect with the persisted `schoolYears`, when non-empty, so a year the
   child has no records for costs nothing.
4. Skip any year with a successful `syncRun` under source
   `history:<year>:complete` for this connection — that row **is** the
   completion ledger. No new table, no new column, and resumable after a crash
   because a year is only marked complete once every task for it succeeded.
5. Open `history:<year>:complete`, run the eight year-scoped tasks
   sequentially with `{ connectionId, schoolYear: year, sourcePrefix }`, close
   it `success` only if all eight succeeded, else `failed` — so a partial year
   is retried tomorrow rather than being recorded as done.

Sequential, not `Promise.all`: a historical year is not urgent, and eight
concurrent logins for one connection against a rate-limited upstream is how
you earn a block. One year per connection per nightly run keeps the worst case
bounded at two nights for a two-year window.

It must **never** write `householdConnection.schoolYear` — that field is the
current year and `SchoolYearRolloverTask` owns it. It also must not call
`reconcileFromLogin` on a historical login: Mashov would answer with the
*current* year and the reconcile would try to "correct" the backfill onto it.
Use a plain session-for-year helper with no reconciliation.

## Stage 4 — Docs, config and the ADR

- **New ADR** `docs/adr/0025-school-year-history-window.md`, superseding the
  `MASHOV_YEAR` decision in `0024`. Record the rejected alternatives: keep it
  as an override, rename to `MASHOV_START_YEAR`, fetch every year on every tick.
- Amend `docs/adr/0024-…md:23,:56,:105,:179` to point at 0025 rather than
  restating the old meaning.
- `README.md:151` — rewrite the env-table row.
- `docs/ops/school-year-hotfix.md:72` — currently says `MASHOV_YEAR` is "**not**
  a useful lever here, despite the name". Under the new meaning it is a lever
  for a different thing; say which.
- `docs/architecture.md:234` — stale since ADR-0024; fix while here.
- `backend/src/session/session.service.ts:94` is dead code
  (`SessionModule` is not imported by `app.module.ts`) but holds a third copy of
  the old semantics. Delete the file or leave it untouched — do not half-update it.
- `docker-compose.yml:50` passes `MASHOV_YEAR` through and needs no change.
  CI never sets it, which stays correct.

> **Blocked, needs a human:** `.env.example:9` and `backend/.env.example:4` both
> read `MASHOV_YEAR=2026` presented as required. I cannot read or edit either
> file — the permission classifier denies it as "Undermining Oversight", via
> every method tried. Both need a one-line edit describing the new meaning.

## Tests

Per `.claude/rules/testing.md`: failing test first, names as specifications,
80% line gate.

**`school-year.scope.spec.ts`** (new) — `start` equals `current` when
`MASHOV_YEAR` is unset; honours a configured earlier year; clamps a year more
than two back to `current - 2`; ignores a year above `current` and warns;
ignores a non-numeric or empty value; `historyScope` includes year `0`;
`currentYearScope` excludes a prior year.

**`school-year.service.spec.ts`** (extend) — **drop the three override tests at
`:63`, `:75`, `:84`** and replace with: `MASHOV_YEAR` does not change the
resolved current year; a `MASHOV_YEAR` far in the past still resolves the
current year from the calendar.

**`feed.service.spec.ts`** (extend; `:93`, `:108` assert the exact single-year
`where` and must change) — includes a prior-year item within the window;
excludes a year before the window; still excludes nothing when the window is
one year wide.

**`children.service.spec.ts`** (extend; `:1007`, `:1330`, `:1348`, `:1365`,
`:1382` pin the single-year shape) — `getHomework` returns a prior-year item;
`getTimetable` returns one entry per day and lesson with two years present;
`subjectCount` does not double-count a `groupId` that recurs; `totalWeeklyHours`
sums only the current year; `latestUpdateAt` stays null when only prior-year
content exists.

**`dashboard.service.spec.ts`** (extend) — the latest-20 lists include a
prior-year item; `latestUpdateAt` ignores it.

**`freshness.service.spec.ts`** (extend) — `contentFreshness` still reports
`stale_year` when only prior-year content exists, with a two-year window open.

**`mashov-session.service.spec.ts`** (extend) — does not reuse a session cached
for a different year on the same connection; keeps two years' sessions
concurrently; `forceRefresh` evicts only the year asked for; a year correction
still evicts the superseded year's session.

**`history-backfill.task.spec.ts`** (new) — fetches nothing when
`MASHOV_YEAR` is unset; fetches the year before current when it is set one
back; clamps to two years when it is set five back; skips a year absent from
the connection's persisted `schoolYears`; skips a year already recorded
complete; records `failed` and retries when one of the eight tasks fails;
never updates `householdConnection.schoolYear`; prefixes every inner run's
source with `history:<year>:`.

**`homework.task.spec.ts`** (extend) — stamps and fetches `context.schoolYear`
when given; still uses the connection year when not; refuses a historical year
on the shared-session path.

**`sync.controller.spec.ts`** / **`freshness.service.spec.ts`** (extend) —
`history:` runs are excluded from `sourcesCompleted`; a completed historical
year does not make a stale live source report fresh.

**`tests/integration/`** — a three-year window returns all three years from the
feed and exactly one timetable per slot; the backfill is idempotent across two
runs; `MASHOV_YEAR` set to a year beyond the cap fetches only two years back.

## Verification

```bash
cd backend && npm run typecheck && npm run lint && npm run test:coverage
DATABASE_URL="postgresql://u:p@localhost:5432/d" npx prisma validate
cd .. && npx tsc --noEmit -p tsconfig.integration.json
docker compose --profile test up --abort-on-container-exit --exit-code-from integration integration
```

The integration run is the load-bearing one: the new indexes, the range
predicate and the backfill's idempotency are all things only real Postgres can
confirm.

**Manual, against production after deploy**

1. `docker compose logs backend | grep "resolved year"` -> still `year=2027`,
   with `MASHOV_YEAR=2026` set. This is the regression that matters most: the
   variable must no longer move the current year.
2. `select "schoolYear", count(*) from homework_item group by 1 order by 1;` ->
   rows under both 2026 and 2027, none under 0.
3. `GET /feed` -> items from both years, newest first.
4. `GET /children/<guid>/timetable` -> exactly one entry per day+lesson.
5. `GET /settings/source-health | jq '.contentFreshness'` -> `current`, computed
   from 2027 alone.
6. Set `MASHOV_YEAR=2019` and restart -> logs warn that the start year was
   clamped to 2025, and no 2019 fetch is attempted.

## Flagged uncertainties

- `apis/post-api-login.md:125` marks `userSchoolYears` as always present, with
  one real sample at `:171`. Treated as reliable; the backfill still falls back
  to the capped window blind if the array is empty or missing, rather than
  fetching nothing.
- Whether Mashov rate-limits a connection that logs in several times in quick
  succession for different years. The sequential one-year-per-night design
  makes this unlikely to bite, but it is unmeasured. Worth watching the first
  real run rather than guessing a delay.
- Whether a historical login is even accepted for a year the child has left, or
  silently coerced to the current year. `reconcileFromLogin` would reveal it,
  but the backfill deliberately does not call it — so the first run should be
  checked by confirming rows actually landed under the older `schoolYear`,
  not by trusting a `success` status.

**Carried forward from PR #8, still not addressed:**
- `SyncController.TOTAL_SYNC_SOURCES = 14` compares a flat count against
  `groupBy` rows that include per-student variants, so `done` already trips
  early with more than one child. This change must not worsen it (hence the
  `history:` exclusion) but does not fix it.
- `backend/src/session/session.service.ts` is dead code carrying a third copy
  of the old year semantics.
- `HouseholdConnection` still has no `@@unique([schoolCode, username])`; the
  migration's dedupe statement makes `active = true` effectively unique
  instead. Adding the constraint needs a separate deploy after the dedupe has
  run once in production.
- Whether a historical year's `groups`/`lessons_count` data is even served by
  Mashov for a year the child has left, or returns empty. If empty, those two
  tasks should be dropped from the backfill set.
- `TimetableEntry` history has little value (a past year's timetable is not
  actionable) but is harmless and costs one fetch; included for uniformity
  rather than for a use case.

---

## Tasks

The stages above are the specification. These task headings are the execution
order; each names the stage that specifies it. Ordering constraint from Stage
3a: the session-cache key change lands **first**, before anything can ask for
two years at once.

### Task 1: Key the Mashov session cache on `(connectionId, year)`

Implements **Stage 3a**. No read-side or backfill change yet.

- Compose the key for `connectionSessions`, `lastLoginByConnection` and
  `lastRosterByConnection`; `forceRefresh` evicts only the composite key.
- `refreshRosterForConnection` evicts the superseded year's entry explicitly
  when a year correction happens.
- Tests (`src/session/mashov-session.service.spec.ts`): does not reuse a
  session cached for a different year on the same connection; keeps two years'
  sessions concurrently; `forceRefresh` evicts only the year asked for; a year
  correction still evicts the superseded year's session. Existing "refreshes
  the roster even when active students already exist" must stay green.
- Verify: `npx jest src/session/mashov-session.service.spec.ts`
  Expected: all pass, including the four new names.

### Task 2: Two scopes and the window resolver

Implements **Stage 1**.

- `school-year.scope.ts`: add `SchoolYearWindow`, `currentYearScope`,
  `historyScope`, `schoolYearWindowFor`. Keep `schoolYearScope` and
  `currentSchoolYearFor` exported and unchanged.
- `school-year.service.ts`: `resolveForSchool` stops reading `MASHOV_YEAR`;
  drop `readOverride` and the `'override'` member of `SchoolYearSource`.
- Tests: new `src/common/school-year/school-year.scope.spec.ts` with the seven
  cases the Tests section names; `school-year.service.spec.ts` loses its three
  override tests and gains the two replacements.
- Verify: `npx jest src/common/school-year`
  Expected: all pass; no test asserts `source: 'override'`.

### Task 3: Apply the right scope at every read site

Implements **Stage 2**, including the two Prisma indexes.

- Widen: `feed.service.ts` (both reads + the `:32-33` comment),
  `children.service.ts` `getHomework` / `getBehavior`,
  `dashboard.service.ts` latest-20 lists only.
- Keep current-year: every other site in the Stage 2 list. `dashboard.service`
  must now carry both scopes rather than one `yearScope`.
- `schema.prisma`: `@@index([schoolYear, lessonDate])` on `HomeworkItem`,
  `@@index([schoolYear, eventAt])` on `BehaviorItem`.
- Tests: `feed.service.spec.ts`, `children.service.spec.ts`,
  `dashboard.service.spec.ts`, `freshness.service.spec.ts` per the Tests
  section.
- Verify: `npx jest src/feed src/children src/dashboard src/sync/freshness.service.spec.ts`
  then `npx prisma validate`.
  Expected: all pass; `prisma validate` reports the schema valid.

### Task 4: Persist `userSchoolYears` on the connection

Implements **Stage 3d**.

- `schema.prisma`: `schoolYears Json @default("[]")` on `HouseholdConnection`.
- Write it from `accessToken.userSchoolYears` in `parseAndPersistHousehold`
  and on the roster refresh path.
- Tests (`mashov-session.service.spec.ts`): persists the array from the login
  body; leaves it untouched when the login omits it.
- Verify: `npx jest src/session && npx prisma validate`
  Expected: all pass.

### Task 5: Thread the year and the source prefix through the sync tasks

Implements **Stage 3b** and **Stage 3c**.

- `sync.types.ts`: `schoolYear?` and `sourcePrefix?` on
  `SyncExecutionContext`.
- All eight year-scoped tasks (groups, behavior, out-behave, homework,
  lessons-count, daily-behave, message-board, timetable): year becomes
  `context.schoolYear ?? connections[0]?.schoolYear ?? fallbackSchoolYear`,
  fed to both `getForConnection` and the row stamp; `sourcePrefix` prefixes the
  `syncRun.source`; the shared-session path refuses an explicit
  `context.schoolYear` with a log and an early return.
- `sync.controller.ts`: exclude `source: { not: { startsWith: 'history:' } }`
  from the `sourcesCompleted` `groupBy`.
- Tests: `homework.task.spec.ts` per the Tests section, plus
  `sync.controller.spec.ts` excluding `history:` runs, plus
  `freshness.service.spec.ts` — a completed historical year does not make a
  stale live source report fresh.
- Verify: `npx jest src/sync`
  Expected: all pass.

### Task 6: `HistoryBackfillTask`

Implements **Stage 3e**.

- New `src/sync/tasks/history-backfill.task.ts`, `@Cron('0 3 * * *')`, no
  bootstrap hook, registered in `SyncModule`.
- Window, candidate years descending, intersect persisted `schoolYears`, skip
  years already complete, one year per connection per run, eight tasks
  sequentially, `history:<year>:complete` as the ledger.
- Never writes `householdConnection.schoolYear`; never calls
  `reconcileFromLogin`.
- Tests: new `src/sync/tasks/history-backfill.task.spec.ts` with the eight
  cases the Tests section names.
- Verify: `npx jest src/sync/tasks/history-backfill.task.spec.ts`
  Expected: all eight pass.

### Task 7: Docs, ADR and the dead-code decision

Implements **Stage 4**.

- New `docs/adr/0025-school-year-history-window.md` with the three rejected
  alternatives; amend `0024` to point at it; `README.md` env row;
  `docs/ops/school-year-hotfix.md`; `docs/architecture.md`.
- `backend/src/session/session.service.ts`: delete or leave whole — never
  half-update.
- Verify: `grep -rn "MASHOV_YEAR" README.md docs/ backend/src | grep -v plans/`
  Expected: no surviving description of `MASHOV_YEAR` as an override of the
  current year.

### Task 8: Integration coverage and full verification

Implements the **Tests** section's `tests/integration/` bullet and the
**Verification** block.

- Integration: a three-year window returns all three years from the feed and
  exactly one timetable per slot; the backfill is idempotent across two runs;
  `MASHOV_YEAR` beyond the cap fetches only two years back.
- Verify: the whole Verification block, in order.
  Expected: typecheck clean, lint clean, coverage >= 80%, `prisma validate`
  valid, integration container exits 0.
