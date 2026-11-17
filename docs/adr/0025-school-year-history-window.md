# ADR-0025: `MASHOV_YEAR` Means the Earliest Year to Fetch, Never the Year in Scope

- **Date**: 2026-11-17
- **Status**: Accepted
- **Deciders**: Backend agent, Planner
- **Supersedes**: the `MASHOV_YEAR` decision in [ADR-0024](0024-school-year-resolution-and-rollover.md)

## Context and Problem Statement

[ADR-0024](0024-school-year-resolution-and-rollover.md) fixed the frozen school year: the current
year is resolved from upstream, reconciled against Mashov's own answer on every login, persisted
on `householdConnection.schoolYear` and re-checked daily. In that work `MASHOV_YEAR` was demoted
to an optional break-glass **override** — set it, and it pins the current year.

That demotion left the variable actively misleading. `resolveForSchool` short-circuited on it
*before* the cache, the `/api/schools` max, the stored-year clamp and the ceiling, so
`MASHOV_YEAR=2026` meant "the current year is 2026" — which is precisely the frozen-year
condition ADR-0024 exists to prevent. Production still carried `MASHOV_YEAR=2026` while the live
year was 2027. The one lever whose name suggests it controls the school year was the lever that
would re-break it, and the only thing standing between production and a repeat of the five-month
outage was that nobody had restarted the backend with the resolver in place.

There is also a real want behind the name: a parent joining in year 8 would like to see year 7's
homework and behaviour, not an empty history.

## Decision

`MASHOV_YEAR` is the **earliest school year to fetch from**. It has no say in which year is
current.

- `resolveForSchool` no longer reads it, and `SchoolYearSource` loses its `'override'` member.
- `schoolYearWindowFor()` resolves a `{ start, current }` window. `start` is
  `max(MASHOV_YEAR ?? current, current - 2)`, clamped to at most `current`. A value above the
  current year is refused with a logged warning rather than honoured, because it would otherwise
  produce an empty window and hide the live year — the one property the variable must never be
  able to break again. Unset, the window is one year wide and behaviour is unchanged.
- Reads split in two. `historyScope()` widens the lists and feeds, where more data is the point.
  `currentYearScope()` — the old `schoolYearScope()`, now its alias — keeps every present-tense
  view and **every staleness signal** on the current year alone.
- The crons keep fetching the current year only. A separate nightly `HistoryBackfillTask` fetches
  each historical year **once**, resumably, and no-ops when complete.

### Why the staleness signals stay single-year

A range would let a child with nothing yet this year report last June's homework as their latest
update. That is the exact blindness that hid the original bug for five months. Widening
`latestUpdateAt`, the freshness badge or `contentFreshness` would undo ADR-0024's only detection
mechanism while leaving its cause fixed, so those reads are deliberately excluded and carry tests
saying so.

### Alternatives considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Make `MASHOV_YEAR` the earliest year to fetch | Reuses the name operators already have, needs no production `.env` edit, and the existing `2026` becomes *correct* under the new meaning | Two meanings in the git history; anyone reading an old runbook has to be told | **Selected** |
| Keep it as a break-glass override of the current year | Already built; useful if upstream detection is ever wrong | It is a loaded gun pointed at the exact failure ADR-0024 fixed, and production already had it set to a stale value. A lever that can re-break the thing is not a safety lever. The documented hotfix (`UPDATE householdConnection`) covers the real emergency | Rejected |
| Rename to `MASHOV_START_YEAR` | Unambiguous; no overloaded history | Needs a coordinated production `.env` change, and a missed deploy means the old name is silently ignored — a quiet revert to one-year behaviour rather than a loud failure | Rejected; the clarity is not worth a silent-failure window |
| Fetch every year in the window on every cron tick | No new task; history appears immediately | Each extra year is a separate login plus a per-student fetch across eight task types, every 12 minutes, forever, for data that cannot change. The way to earn a rate-limit block | Rejected |
| A separate table for backfill progress | Explicit, queryable, room for an attempts counter | `syncRun` already records exactly this: a successful `history:<year>:complete` row for a connection *is* the ledger, and the **failed** rows for the same source are the attempts counter, so even the capping below needs no new table | Rejected as premature |

### What "complete" has to mean

A review of this branch found that the eight year-scoped tasks each reported
`status: 'success'` when *every* connection attempt for a student threw — the
per-connection `catch` logged a warning, left the item list empty, and closed
the run green. Combined with a ledger keyed on success, the first night's
rejected historical login would have recorded the year permanently complete
having fetched nothing, with no retry and no way back short of manual SQL. That
is the realisation of this ADR's own top unverified risk, so three things now
have to hold before a year is recorded complete:

1. **The tasks report honestly.** An all-connections-failed student now throws
   into the existing per-student handler, which records a failed `syncRun` and
   a non-zero `failedCount`. This also stops a broken *live* sync from showing
   green, which was the same bug on the current-year path.
2. **Something actually arrived.** A year whose eight tasks all succeed with an
   aggregate `fetchedCount` of 0 is recorded `failed`, not complete — a refused
   historical login is indistinguishable from an empty year, and the safe
   reading is "not yet done".
3. **What arrived belongs to the year asked for.** If Mashov silently coerced
   the login to the current year, the rows were stamped with the historical
   year while holding current-year content; both satisfy
   `@@unique([studentGuid, schoolYear, lessonId])`, so every item would appear
   twice in the feed with nothing anywhere to notice. The newest row stamped
   with that year must fall inside its span (Sep year-1 .. Aug year) or the
   year is refused with a loud warning. Dates are the only evidence available,
   since the wrong-year response is a valid 200.

Honest failure reporting then creates a second problem the original design did
not have: a year that fails every night would be retried forever and, under
"one year per run, first incomplete wins", would block the older year
permanently. So the year to attempt is chosen by **fewest failed attempts
first**, most recent year breaking the tie, and a year is retired after three
failures. The failed ledger rows are the counter.

### Why the source name is a prefix, never a suffix

`FreshnessService` treats any run key matching `` `${source}:` `` as a variant success of
`source`, so per-student keys like `homework:<guid>` count. A backfill run named
`homework:<guid>:2026` would therefore register as a **fresh `homework` success** and mask a
broken current-year homework sync — recreating ADR-0024's blindness by a new route.
`history:<year>:homework:<guid>` matches no `SOURCE_THRESHOLDS` entry and no
`startsWith('homework:')` test, so it is invisible to source health. That is correct: a finished
historical year says nothing about whether live syncs work. `SyncController` excludes the prefix
from `sourcesCompleted` for the same reason.

### Why a historical login must not touch the present

`persistRoster` runs on every connection login, and `Student` has no `schoolYear` — identity is
stable across years, by design. A login for a dead year would therefore stamp the live children
with that year's `classCode`/`classNum` and set `isActive: true` on children who have since left.
A login reaching **backwards** now reads data and nothing else: no roster persist, no
`mashovUniqueId` write-back (a replayed `uniquId` may evict the live session upstream). A login
reaching **forwards** is the rollover offering a candidate year and still persists the roster,
which is what it is for. Direction is the discriminator, not inequality.

## Consequences

**Good**
- The current year is always fetched and always reachable, whatever the environment says. That
  property is now enforced by the resolver rather than by nobody having set the variable.
- Production needs no `.env` change: `MASHOV_YEAR=2026` against a live 2027 becomes a correct
  one-year-back window instead of a frozen year waiting to happen.
- History is bounded and paid for once, not per tick.
- The session cache is keyed on `(connectionId, year)`, which closes a latent corruption: a cache
  keyed on the connection alone would hand a caller asking for one year another caller's
  year-scoped cookies, and the wrong-year response is a valid 200 that no retry can detect.

**Bad / accepted**
- In September the dashboard and feed show last year's items rather than being empty. That is the
  intended behaviour under this change; the unchanged `latestUpdateAt` is what still reports the
  new year as quiet.
- `pagination.total` on the homework and behaviour lists grows with the window, by design.
- **Backfilled items arrive marked unread.** `UserItemState` has no row for an
  item nobody has seen, and the default is `{ isNew: true }`; the lists' default
  filter is `status = 'new'`. So the morning after the first backfill night, a
  parent's homework tab shows an entire prior school year flagged new, and in
  September — the case this change exists to improve — the feed is *entirely*
  prior-June items flagged new. The counts are unaffected (they stay 7-day and
  current-year), so this is lists-only. It is left as-is deliberately: the two
  obvious fixes both have a real cost, and which one is right is a product
  call, not an implementation detail. Defaulting prior-year items to *not* new
  would hide the history behind a filter change, which defeats the point of
  fetching it; leaving them new floods the default view once. Needs a decision
  before this reaches a real family with a populated history.
- A past year's timetable has little value but costs one fetch; included for uniformity rather
  than for a use case.
- Two years for one connection may be in flight at once. That is what makes the backfill safe to
  run beside the crons, but it is also a second concurrent upstream session per connection.

**Unverified**
- Whether Mashov rate-limits a connection that logs in several times in quick succession for
  different years. The sequential, one-year-per-night design makes it unlikely to bite, but it is
  unmeasured.
- Whether a historical login is accepted at all for a year the child has left, or silently
  coerced to the current year. The backfill deliberately does not call `reconcileFromLogin`
  (Mashov would answer with the *current* year and the reconcile would try to "correct" the
  backfill onto it). Both failure modes are now *detected* rather than assumed away — see "What
  'complete' has to mean" — and the ledger row records what was fetched, so
  `select source, status, "fetchedCount" from sync_run where source like 'history:%'` is the
  first thing to read after the first real run. What remains unknown is which of the two
  Mashov actually does.
- Whether a historical year's `groups`/`lessons_count` data is served at all for a year the child
  has left. If it comes back empty, those two tasks should be dropped from the backfill set.

## What this ADR does not do

- `SyncController.TOTAL_SYNC_SOURCES = 14` still compares a flat count against `groupBy` rows
  that include per-student variants, so `done` already trips early with more than one child. The
  `history:` exclusion keeps this change from making it worse; it does not fix it.
- `backend/src/session/session.service.ts` remains dead code (`SessionModule` is not imported by
  `app.module.ts`) carrying a third copy of the year logic. Left untouched on purpose: it is
  unreachable, and deleting it plus its spec plus the module is a separate change.
- `HouseholdConnection` still has no `@@unique([schoolCode, username])`.
- The coercion guard aggregates by `schoolYear` alone, not per connection, so in a multi-household
  deployment one household's strayed rows would refuse another's year. Single-household today.
- `FeedService` still has no `take`: both reads load every matching row into Node before
  paginating, which the window now multiplies by up to three. Pre-existing shape, newly more
  expensive.

## Links

- Supersedes the `MASHOV_YEAR` decision in [ADR-0024](0024-school-year-resolution-and-rollover.md)
- Runbook: [docs/ops/school-year-hotfix.md](../ops/school-year-hotfix.md)
- Plan: [docs/plans/school-year-history-window.md](../plans/school-year-history-window.md)
