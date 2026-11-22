# ADR-0034: Child Activity Badges Count Unread Items for the School Year, Not a Rolling Window

- **Date**: 2026-11-22
- **Status**: Accepted
- **Deciders**: User, Backend agent, Frontend agent

## Context and Problem Statement

נלי's card on `/children` read `0 שיעורי בית · 0 אירועים · 0 חיוביים`, and her child page header read
`0 שיעורי בית · 0 אירועים שליליים · 0 אירועים חיוביים` — directly above a list of unread homework and a
behaviour tab full of events. Verified against the live stack:

| נלי (2026/27) | in the DB | on the chip |
|---|---|---|
| homework | 52 rows, latest 18/11 | 0–2 |
| behaviour | 21 rows → 12 `attention`, 8 `positive`, 1 `neutral`, latest 15/11 | 0 |
| subjects | 15 | 15 ✓ |

Every count chip was "unread items whose `lessonDate` falls in the last seven days", while the list
*underneath* each chip spans the whole configured history window. `subjectCount` and
`totalWeeklyHours` used the same year scope with no date floor, which is why only those two
survived.

That is worse than merely wrong. For an elementary school that logs events weekly — or for any
school over a holiday — the window is empty almost always, so a healthy sync and a dead one render
identically: three zeroes. The chip is the first thing a parent reads on the page, and it was
telling them the app was broken.

A second defect sat in the same lines: the amber chip counted `classification !== 'positive'`, so
`neutral` rows — attendance authorised by the school, `חיסור בשל פעילות בית-ספרית` — were presented
as negative events. That is מיקה's `19 אירועים ⚠`, of which only 7 were actually `attention` this
year.

The logic existed twice: `children.service.getUnreadChildActivityCounts` (serving `/children` and
`/children/:guid`) and an inline copy in `dashboard.service.getChildren` (the home cards). Two
copies of a rule is how the home card and the children card gained the ability to disagree about
the same child.

## Decision

**A child's activity chip counts every unread, non-archived item of its kind in that child's current
school year. No date floor.**

One shared counter, `backend/src/common/child-activity-counts.ts`:

```ts
unreadChildActivityCounts(prisma, userItemState, studentGuid, yearScope, userId)
  → { unreadHomeworkCount, attentionCount, positiveCount, neutralCount }
```

Both services call it. The year scope stays each caller's own — cross-child
(`yearScopeForStudents`) for the two lists, that child's own school's year (`currentYearScope`) for
the workspace — so a household with two schools at different rollover points is unaffected.

**And `neutral` is its own bucket.** The amber chip counts `classification === 'attention'` only;
`neutral` gets a third, muted chip labelled `אחר`, using `getBucketLabel` from
`frontend/src/lib/behavior.ts` — the same wording as the behaviour filter tabs, so a chip and the
tab it summarises name the same thing.

The invariant this buys: **a chip is the "לא נקרא" total of the list it sits above, for the current
school year.** With `MASHOV_YEAR` unset — a one-year window — the two numbers are equal, and the
chip is checkable by eye against the list, which is exactly what the old rule was not. Where
`MASHOV_YEAR` reaches further back, the list is wider than the chip by the earlier years it admits:
on the deployment this was verified against (`MASHOV_YEAR=2026`), נלי's homework chip reads 52 for
2026/27 over a list whose unread total is 182 across both years.

The current year is the right scope for the chip even so, for the reason ADR-0024 gives for every
other staleness signal: the chip answers "what is waiting for me *now*", and a count that carries
last June's unread homework forward never falls, which is the failure mode the "count everything"
option below is rejected for. Making the two numbers identical is a question about what the *list*
should default to, not about the counter.

Wire field names are unchanged (`recentHomeworkCount`, `recentBehaviorCount`,
`positiveBehaviorCount`, plus the new `neutralBehaviorCount`); roughly ten e2e specs pin them, and
renaming them buys nothing a corrected comment does not. `attentionBehaviorCount` is dropped from
the workspace summary — it is now exactly `recentBehaviorCount`, and no component ever read it.

## Alternatives Considered

- **Keep a window, widen it to 30 days.** Rejected: it only moves the threshold at which a quiet
  school starts reporting zero. A fortnightly-logging school at the end of a holiday is still
  indistinguishable from a failed sync, and the chip still cannot be reconciled against the list
  below it.
- **Count all items in the year, read or not.** Rejected: the number would never go down. A badge
  the parent cannot clear is noise after the first week; unread state is what the lists already
  filter on, and what the parent can act on.
- **Rename the wire fields to `unread*`.** Deferred, not rejected. The names are now mildly
  inaccurate rather than actively misleading, and the churn across the e2e fixtures and the API
  contract is real. Worth doing with the next breaking contract change.
- **Fold `neutral` into the positive chip, or hide it.** Rejected: an authorised absence is neither
  good news nor bad, and hiding it would make the amber chip plus the green chip fail to add up to
  the behaviour list's total — reintroducing the unreconcilable-chip problem on a smaller scale.

## Consequences

**Good**

- The chips are checkable: each equals the unread total of the list beneath it.
- A quiet week no longer looks like an outage. The "is my sync working" question is answered by the
  freshness card (ADR-0028) and `latestUpdateAt`, which are built for it.
- `attention` means attention. מיקה's chip drops from 19 to 7, and the 227 attendance rows read as
  what they are.
- One counter, so `/dashboard`, `/children` and `/children/:guid` cannot diverge again.

**Bad / accepted trade-offs**

- The numbers are larger — 52 rather than 2. For a household that has never opened the app this is
  a big first badge. Accepted: it is the truth, and marking items read brings it down.
- The counter now reads every row of the year per child rather than a week's worth, then batches
  read-state per id. At real volumes (tens to low hundreds of rows per child per year) this is
  cheap, but it scales with the year rather than with the week. If it ever matters, the fix is a
  grouped `count` plus a `user_item_state` join, not a date floor.
- `recentHomeworkCount` / `recentBehaviorCount` on `GET /dashboard`'s **summary** object are
  untouched: those are household-wide seven-day counts, a different statistic, and the contract
  comments now say so explicitly.
