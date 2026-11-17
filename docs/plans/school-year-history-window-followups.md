# Follow-ups from the `MASHOV_YEAR` history-window branch

Deferred findings from the whole-branch review of `feat/school-year-history-window`
(`c192a0a..df9df2a`). Everything the review graded Critical or Important was fixed
on the branch; see [ADR-0025](../adr/0025-school-year-history-window.md). These are
the items judged Minor, plus one Important that needs a decision rather than a patch.

## Needs a decision, not a patch

- **Backfilled items arrive marked unread.** `UserItemState` has no row for an item
  nobody has seen and the default is `{ isNew: true }`, while the lists' default
  filter is `status = 'new'`. The morning after the first backfill night a parent's
  homework tab shows a whole prior school year flagged new; in September the feed is
  entirely prior-June items flagged new. Both fixes cost something real — defaulting
  prior-year items to *not* new hides the history behind a filter change, which
  defeats the point of fetching it; leaving them new floods the default view once.
  Counts are unaffected (7-day and current-year). Decide before this reaches a
  family with a populated history. Recorded in ADR-0025's consequences.

## Correctness-adjacent, low likelihood

- `connection.schoolYear === 0` makes the backfill a silent no-op (the candidate
  loop is empty and nothing is logged) while `currentSchoolYearFor` falls back to the
  calendar for reads — so the window opens on a year nothing will ever fill.
- The coercion guard aggregates by `schoolYear` alone, not per connection, so in a
  multi-household deployment one household's strayed rows would refuse another's
  year. Single-household today.
- The downward-correction path in `refreshRosterForConnection` is correct only
  because the `schoolYear` update precedes the re-login; move it and roster
  persistence silently disappears. No test asserts the roster *is* persisted at a
  downward-corrected year.
- A historical login still *sends* the stored `uniquId` while suppressing the
  write-back, so ADR-0025's "a replayed `uniquId` may evict the live session
  upstream" closes the DB half and leaves the upstream half open. Unverified either
  way.
- Pre-existing login-dedupe window (`mashov-session.service.ts`): the placeholder is
  inserted before `authPromise` is assigned, so a caller landing in that window
  starts a duplicate login. Not introduced or worsened here.
- `Number('0x7e2')` is `2018`, so a hex string is silently accepted as `MASHOV_YEAR`.

## Performance

- The two new indexes probably serve neither query: a range on the leading column
  cannot supply `ORDER BY lessonDate DESC`, and the `OR` makes it a bitmap-or or seq
  scan either way. No `EXPLAIN` was run. Additive and cheap, so the cost is write
  amplification on every upsert.
- `FeedService` still has no `take` — both reads load every matching row into Node
  before paginating, which the window now multiplies by up to three.
- The clamp/ignore warning fires per HTTP request (up to four times per page) rather
  than once at boot, so `MASHOV_YEAR=2019` logs a WARN on every dashboard and feed
  load forever.

## Dead weight

- `schoolYearScope` is now a dead export (zero call sites) and its comment claims
  call sites it no longer has. The plan asked for the name to be kept.
- Four of the eight backfilled tasks — `groups`, `lessons_count`, `message_board`,
  `timetable` — write rows no widened read path surfaces. Only `homework` and the
  three behaviour tasks feed the widened lists. The plan justifies `timetable` for
  uniformity but not the other three. If a historical year returns empty for
  `groups`/`lessons_count` (ADR-0025 flags this as unknown), drop them from the set.
- Orphaned `running` ledger rows accumulate when a run crashes mid-year.
  `isAlreadyComplete` only matches `success`, so correctness is unaffected.
- The plan's premise for sequencing the eight tasks — "eight concurrent logins for
  one connection" — is inaccurate: they share one cached session per
  `(connectionId, year)`, so the real saving is extra GETs, not logins. The
  sequential design is still right, for a weaker reason.

## Tests that cannot fail

- `freshness.service.spec.ts`'s "history window open" case: `computeContentFreshness`
  never reads `MASHOV_YEAR` and its aggregates are unscoped, so the property the plan
  names is untestable as the code is factored. The test is a naming guard on the
  `history:` prefix decision, which is worth keeping — but it is not what the plan
  asked for.
- `sync.controller.spec.ts` asserts the Prisma argument, not the exclusion, and
  `/sync/status` has no integration coverage.
- `homework.task.spec.ts`'s "resolves connections in a deterministic order" asserts
  `orderBy: expect.anything()`, so it passes for any `orderBy`. Pre-existing.
- `tests/integration/school-year-history.test.ts` depends on 2027 being the global
  max `schoolYear` across all active connections, which it does not control. Passes
  today; a future fixture at 2028 breaks its read-side assertions.

## Carried forward from PR #8, still open

- `SyncController.TOTAL_SYNC_SOURCES = 14` compares a flat count against `groupBy`
  rows that include per-student variants, so `done` already trips early with more
  than one child. This branch keeps history rows out of that count but does not fix
  the count.
- `backend/src/session/session.service.ts` is dead code (`SessionModule` is not
  imported by `app.module.ts`) carrying a third copy of the year logic. Left whole on
  purpose rather than half-updated.
- `HouseholdConnection` still has no `@@unique([schoolCode, username])`.
- `collectCoverageFrom` does not measure `src/common/**`, `src/sync/tasks/**`,
  controllers or `mashov-session.service.ts`, so the new code here has dedicated
  specs but is outside the 80% gate.

## Blocked on a human

`.env.example:9` and `backend/.env.example:4` both present `MASHOV_YEAR=2026` as
required. The permission classifier denies reading either file, so they are
unedited. Both need a one-line change saying it is optional and means the earliest
year to fetch.
