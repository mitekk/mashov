# ADR-0036: The Default Lists Show the Current School Year; a Past Year Is Archived by Derivation

- **Date**: 2026-11-22
- **Status**: Accepted
- **Deciders**: User, Backend agent, Frontend agent
- **Partially supersedes**: [ADR-0025](0025-school-year-history-window.md) — the lists and feeds no longer span the `MASHOV_YEAR` window by default

## Context and Problem Statement

[ADR-0034](0034-child-activity-badges-count-unread-this-year.md) made each child activity chip count
unread items in the *current* school year. The lists beneath the chips still spanned the
`MASHOV_YEAR` history window ([ADR-0025](0025-school-year-history-window.md)), so the two numbers
disagreed. Verified against the live stack, on נלי's page:

| נלי | rows in 2026/27 | rows in 2025/26 | the `לא נקרא` tab spanned |
|---|---|---|---|
| homework | 52 — and the chip read 52 | 130 | 182 |
| behaviour | 21 | 91 | 112 |

The extra 130 homework rows were "unread" only because nobody had ever opened a year that ended in
June. Across the database there are 221 past-year rows in total, all of them in that state.

ADR-0025 widened the lists on purpose: *a parent joining in year 8 would like to see year 7's
homework and behaviour, not an empty history.* The want is real. The default view is the wrong
place for it: a year the student has already left is history, not a to-do list, and a `לא נקרא` tab
that opens on 182 items of which 130 can never be acted on teaches the parent to ignore the tab.

## Decision Drivers

- The invariant ADR-0034 set out to buy — a chip equals the `לא נקרא` total of the list beneath it
  — was still false wherever `MASHOV_YEAR` reaches back, which on this deployment is everywhere.
- The history want (ADR-0025) must survive: the backfill keeps fetching, and last year stays
  reachable somewhere.
- Rollover is automatic and unattended (daily cron at
  `backend/src/sync/tasks/school-year-rollover.task.ts:48`, or a sign-in at
  `backend/src/auth/auth.service.ts:337`). Whatever marks last year as done must not need an event
  hook to stay correct.
- State is per user (`user_item_state`, ADR-0016). A household member who joins next year has no
  state rows, and must still see last year as archived.

## Decision

Two halves.

**1. `לא נקרא` and `הכל` show the current school year only** — on the child lists, the dashboard
feed and `/feed`. `ארכיון` keeps spanning the full `MASHOV_YEAR` window, so last year is reachable
in exactly one place. `MASHOV_YEAR` still governs what the backfill *fetches*; it no longer governs
what the default view *shows*.

- `ChildrenService.getHomework` / `getBehavior` pick `historyScope(window)` when
  `status === 'archived'` and `currentYearScope(window.current)` otherwise.
- `DashboardService` and `FeedService` both switch to `yearScopeForStudents` (current year). Both
  lose their now-unused `ConfigService` dependency.
- `historyScopeForStudents` is deleted; it had no caller left.

**2. A past-year item *is* archived — by derivation, not by a migration.**

```ts
isArchived = state.isArchived || isPastSchoolYear(item.schoolYear, student's current year)
```

`isPastSchoolYear(rowYear, currentYear)` lives in `backend/src/common/school-year/school-year.scope.ts`.
**`schoolYear = 0` is not past.** Pre-migration rows carry 0, `currentYearScope` deliberately admits
them, and 0 means "unknown"; reading it as last year would archive a half-migrated database
wholesale.

A private `effectiveItemState()` in `children.service.ts` returns
`{ isNew: stored.isNew && !isPastYear, isArchived: stored.isArchived || isPastYear, isPastYear }`.
The list endpoints, the detail endpoints and the four single-item mutators all derive it, and
`mapHomeworkItem` / `mapBehaviorItem` emit a new `isPastYear: boolean`. Nothing is written at
rollover: the moment `household_connection.schoolYear` advances, last year's items read as archived
everywhere, for every member of the household, including one who joins later. Today's 221 past-year
rows are archived the moment this ships, with no backfill.

**Frontend.** `isPastYear` joins `HomeworkItem` / `BehaviorItem` and their normalizers.
`HomeworkItem.tsx`, `BehaviorItem.tsx`, `HomeworkDetailPage.tsx` and `BehaviorDetailPage.tsx` render a
muted `שנה קודמת` badge in place of the archive toggle, and hide the read toggle, when `isPastYear`.
`HomeworkSection.tsx` / `BehaviorSection.tsx` exclude past-year rows from `selectedArchivedIds`, so
the bulk `שחזר מארכיון` button hides when only such rows are selected.

**Unchanged.** Notices (`getNotices`), timetable, subjects and the digest were already
`currentYearScope`. Mail has no `schoolYear` column and is untouched.

The invariant this buys: **the chip equals the `לא נקרא` total exactly**, and `ארכיון` becomes the
home of everything the history backfill fetches.

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Lists show the current year; past year archived by derivation | Chip equals tab total. No event hook, no bulk write, correct for a member who joins later, 221 existing rows fixed with no backfill. History stays one tab away | A past-year item cannot be un-archived: the derived rule outranks the stored flag. Archive reads carry a per-row comparison | **Selected** |
| Leave the lists wide; widen the chip to match the window | No list change; chip and tab agree | Rejected for ADR-0024's reason, restated in ADR-0034: the chip answers "what is waiting for me now", and a count carrying last June's unread homework forward never falls | Rejected |
| Rollover job writes `isArchived = true` on every past-year item for every household member | Plain stored state; un-archive keeps working | An event hook to maintain, plus a bulk `user_item_state` write per member per rollover (the only bulk insert today is the household-merge copy at `school-links.service.ts:566`). Wrong for a member who joins afterwards. Needs a backfill for the 221 existing rows — all to reach the state derivation reaches for free | Rejected |
| Drop the history window entirely (revert ADR-0025) | Simplest model; one year everywhere | Throws away a real want. The archive tab serves it, and the backfill keeps fetching | Rejected |
| Keep the archive tab on the current year too; surface last year via a year picker | Explicit, user-controlled | New UI and a new query parameter for what the archive already means: "not in my way", which is exactly what last year is | Rejected as scope |

## Decision Outcome

**Chosen**: current-year default lists and feeds, with past-year items archived by derivation.

**Rationale**: ADR-0034 made the chip honest, but only a list that defaults to the same year can make
the two numbers agree, and the agreement is the point: 52 against 182 told the parent the count was
broken. Derivation wins over a rollover job because the three drivers — unattended rollover, per-user
state and late-joining members — all favour computing "past" from `schoolYear` at read time rather
than recording it at write time. The price is that a past-year item cannot be restored, which is
acceptable because restoring last year's homework into a current-year view is exactly what the
change exists to prevent; the control is replaced by a `שנה קודמת` badge so the limit is visible
rather than a toggle that silently fails.

**Positive Consequences**:
- The chip equals the `לא נקרא` total on every list, checkable by eye.
- The 130 never-actionable rows leave נלי's default view; 221 rows database-wide are archived on
  deploy with no migration.
- Rollover needs no new code path. The daily cron and sign-in advance `schoolYear`, and every read
  follows.
- Correct for a member who joins next year, with no state rows of their own.

**Negative Consequences / Risks**:
- Past-year items are permanently archived: `isArchived` is `stored || derived`, so the stored flag
  cannot override it. The restore control is replaced by the badge, and the bulk `שחזר מארכיון`
  ignores such rows.
- Last year is now one tab away rather than in the default view. A parent joining in year 8 must open
  `ארכיון` to find year 7. That is the deliberate trade against ADR-0025's default.
- Every mapper and mutator must route through `effectiveItemState()`. A new endpoint that reads
  `user_item_state` directly will disagree with the lists; the shared helper is the only guard.
- Whether `schoolYear` stays correct now matters for visibility, not only freshness. A stuck
  `household_connection.schoolYear` (the ADR-0024 failure) would keep a finished year in the default
  view; the staleness signals ADR-0024 built still detect it.

## Links

- Partially supersedes: [ADR-0025 — `MASHOV_YEAR` Means the Earliest Year to Fetch](0025-school-year-history-window.md)
- Related: [ADR-0024 — School year resolution and rollover](0024-school-year-resolution-and-rollover.md), [ADR-0016 — Per-user item state](0016-per-user-item-state.md), [ADR-0034 — Child activity badges](0034-child-activity-badges-count-unread-this-year.md)
- Implemented in: `backend/src/common/school-year/school-year.scope.ts`, `backend/src/children/children.service.ts`, `backend/src/dashboard/dashboard.service.ts`, `backend/src/feed/feed.service.ts`, `frontend/src/components/child/`
