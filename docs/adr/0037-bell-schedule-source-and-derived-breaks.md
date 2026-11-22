# ADR-0037: Bell Times Come From the School When It Serves Them, From a Labelled Default When It Does Not — and Breaks Are Derived

- **Date**: 2026-11-22
- **Status**: Accepted
- **Deciders**: User, Backend agent, Frontend agent
- **Related**: [ADR-0012](0012-timetable-data-persistence.md) — sync-and-store for near-static upstream data; [ADR-0030](0030-per-connection-data-scoping.md) — per-school scoping

## Context and Problem Statement

The child workspace's timetable grid labels each row with a bare period number — "1",
"2", "3". A parent can see *that* there is a maths lesson third period, but not *when*
third period is, and nothing in the grid shows recess or lunch at all.

The data to answer that did not exist in this project. `GET /api/students/{guid}/timetable`
returns `timeTable.lesson`, a 1-based index with no clock time
(`apis/get-api-students-id-timetable.md`). The only period times anywhere in the
codebase were a hardcoded, client-only, school-agnostic map of *start* times in
`frontend/src/components/child/ReleasesDialog.tsx`, used to label the early-release
dropdown — eight entries, no end times, and no relationship to any particular school.

Mashov has an undocumented `GET /api/bells`. Its shape is known from the open-source
`yardnsm/node-mashov` client (`src/api-config.js` declares the route;
`src/controllers/bells.js` maps `lessonNumber`, `startTime`, `endTime`; its fixture
carries `{"lessonNumber": 1, "startTime": "08:15:00", "endTime": "09:00:00"}`). It
serves period rows only — no break rows.

Probed live on 2026-11-22 against two real schools (semel 484121 and 482273, year
2027), `GET /api/bells` answered **HTTP 200 with an empty array** for both. The route
is real; neither school publishes bell times through it, and no live response has yet
carried a field to verify the names against. Every school on this deployment therefore
reads `source: 'default'` today.

## Decision Drivers

- The feature has to ship whether or not the endpoint exists. Building on an unverified
  upstream means the failure mode of "it 404s for this school" must be a working screen,
  not an empty one and not a red sync run.
- Default times are a guess. A parent who reads "11:45–12:30" and plans a pickup around
  it is owed the information that we are guessing.
- Bell times are school-wide. Keying them per student would multiply one upstream call
  by the number of children, and the endpoint takes no student guid to begin with.
- Two period-time tables in one codebase will diverge. The release picker's map was
  already the only answer to "when is period 3", in a file that has nothing to do with
  the timetable.

## Decision

**1. A school-keyed sync-and-store task, on ADR-0012's reasoning.**
`bell_schedule` is keyed `(schoolCode, schoolYear, lesson)` —
`backend/src/sync/tasks/bells.task.ts` iterates active user-owned connections **deduped
by (schoolCode, schoolYear)**, so two parents at one school, or one parent with two
children there, produce one upstream call. There is no `orderConnectionsForStudent` and
no ownership stamping: neither applies to a resource that is not a child's.

**2. A 404 or an empty array closes the run `success` with `fetchedCount: 0`.**
Logged once at `warn`. Only a transport or auth failure is a real failure. This is the
decision that makes building on an unverified endpoint safe: if `GET /api/bells` turns
out not to exist, the task is a permanent, quiet no-op rather than a weekly red run
nobody can action.

**3. A bundled default schedule, and `source` on the wire.**
`backend/src/common/bells/default-bell-schedule.ts` carries eight periods, built from
the start times the release picker already shipped plus 45-minute lessons. The read path
(`GET /api/v1/children/:guid/timetable`) answers with
`schedule: { source: 'school' | 'default', periods, breaks }`. The grid renders the
times either way; on `'default'` it also renders
*השעות מוצגות לפי לוח זמנים ברירת מחדל ועשויות לא להתאים לבית הספר*. Approximate times
are never presented as the school's own.

**4. Breaks are derived from gaps, server-side.**
`backend/src/common/bells/derive-breaks.ts` sorts periods by `lesson` and emits a break
for each consecutive pair whose gap satisfies
`MIN_BREAK_MINUTES (5) <= gap <= MAX_BREAK_MINUTES (90)`. The lower bound keeps a
one-minute changeover out of the grid; the upper bound stops a split-day schedule
rendering a three-hour "recess" the child spends at home. Of the emitted breaks, the
single longest with `minutes >= LUNCH_MIN_MINUTES (20)` is `kind: 'lunch'`, ties
resolved to the earliest; the rest are `recess`. One lunch per day, because two
*הפסקת אוכל* rows tell a parent nothing about which one the child eats in.

Deriving on the server rather than in the grid means the digest can reuse it, and means
the bundled default produces breaks on exactly the same rules as a school's own — the
default's gaps (5, 10, 5, **25**, 5, 5, 5) are chosen so the post-fourth-period gap
reads as lunch.

**5. The duplicate map is retired.** `LESSON_TIMES` is gone from `ReleasesDialog.tsx`;
`LessonTimePicker` reads period starts from the `schedule` on the timetable query it
already consumed, and keeps its `<input type="time">` fallback for a day with no usable
lessons.

## Consequences

**Good**
- The timetable answers "when", from the school itself wherever Mashov serves it.
- One period-time table in the codebase, shared by the grid and the release picker.
- A missing or differently-shaped endpoint costs a normalizer change in one file
  (`bells.task.ts`) plus `apis/get-api-bells.md`. Nothing else knows the upstream shape.
- Times are stored as `"HH:MM"` strings. A bell time is a wall clock reading with no
  date and no zone; a `DateTime` column is how 08:15 becomes 06:15.

**Bad / accepted**
- Both schools probed answer `200 []`, so every school reads `source: 'default'` and
  every parent sees the caveat. That is the honest state, not a regression — and the
  sync task stays a quiet no-op until some school does serve a schedule.
- The release picker now depends on the timetable response for its period starts. With
  no schedule at all it degrades to the free time input rather than to a dropdown of
  guessed slots.
- 404 detection matches the status out of `MashovHttpClient`'s flattened error message,
  because the client does not surface a status. A miss costs one `failed` run, not a
  wrong answer.
- Bell times take no part in `history-backfill.task.ts`. Last year's bell schedule is
  not of historical interest.
