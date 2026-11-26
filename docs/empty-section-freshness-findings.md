# Why מיקה's מקצועות and לוח שיעורים rendered empty for a week

**Date:** 26.11.2026
**Status:** cause confirmed against production; fixes landed on
`fix/skip-sign-in-when-session-exists`

## Symptom

On `/children/<guid>?section=subjects|timetable`, one child of a two-child
household showed the empty states for **מקצועות** and **לוח שיעורים**. Her
**ציונים**, **שיעורי בית** and **התנהגות** were fine, and her sibling was fine
throughout. `GET /children/<guid>/subjects` answered a clean
`200 {"data":[]}`, and source-health read green.

## What it was not

The original hypothesis was a two-schools-on-two-school-years divergence: rows
stranded at `schoolYear 2026` while the read served `2027`. Production refuted
it.

- Both `household_connection` rows are on `schoolYear 2027`. There is no
  divergence to exploit.
- Her live guid held **zero** `subject_enrollment` and **zero**
  `timetable_entry` rows at *any* year, not rows at an earlier one.

So neither widening the read nor resolving the served year by data presence
would have changed anything.

## What it actually was

1. She changed school (elementary 482273 → junior high 484121) and Mashov
   issued her a **new `studentGuid`**. The old row survives with
   `isActive: false`, holding last year's 19 subjects and 32 timetable entries.
2. The junior-high connection was **unlinked and re-linked** (its oldest
   `sync_run` is the moment it was created). The unlink transaction deletes the
   child's per-child rows, including `timetable_entry` and `subject_enrollment`
   (`connection.service.ts:440-441`).
3. **The freshness markers outlived the rows.** The unlink deletes
   `sync_run WHERE householdConnectionId = <connection>` (:490), but
   per-student runs written by the scheduled path carry a **NULL**
   `householdConnectionId` — 9,857 such rows existed — so that predicate never
   matched them. And a connectionless run is deliberately admitted into *every*
   connection's snapshot (`SyncOnReadService.recordAttempt`).
4. `isFresh` reads **successful** runs only. Her last `groups` success was
   25.11 and her last `timetable` success 22.11, both inside the **7-day TTL**.
   So `operation.committed` resolved `false` and `ensureFresh` returned before
   ever calling `localIsEmpty`.

The emptiness probe — the one thing that would have noticed — was unreachable
precisely in the case where it was needed.

### Why only those two sections

TTL, nothing else. `grades` (6h) and `homework` lapsed within hours of the
re-link and re-fetched the same day. `groups`, `lessons_count` and `timetable`
sit at 7 days, so they would have stayed empty until 02.12 and 29.11.

## Fixes

| # | Change | Why |
|---|--------|-----|
| 1 | The unlink also deletes `sync_run` rows whose `source` ends in `:<guid>` for each child being removed | A success marker must never outlive the rows it describes. Stops recurrence at the source. |
| 2 | `ensureFresh` probes `localIsEmpty` **before** the freshness decision; an empty copy collapses the TTL to the retry window | Self-heals this and any future variant. "Fresh but empty" is a contradiction, and the marker is the half that is wrong. |
| 3 | `meta: { schoolYear, yearsAvailable }` on the subjects and timetable responses; honest Hebrew empty states; a `Logger` warn in `ChildrenService` | A section that cannot be filled now says why instead of asserting there is no data. |

Fix 2 costs one indexed count per source per view, including views that turn
out fresh. The spec that previously asserted the opposite
(`does not probe the local copy when nothing is going to be fetched`) was
rewritten rather than deleted — it names the trade and why the saving was false
economy.

Alongside those, the four emptiness probes are now year-scoped, so
`localIsEmpty` is true exactly when the read it guards would return no rows.
That was the original plan's Phase 2. It is not what broke here, but with fix 2
the probe is finally load-bearing rather than dead, so the invariant is worth
holding.

## Immediate repair

No migration and no `UPDATE`. `POST /api/v1/sync/refresh` (or a fresh sign-in)
runs the tasks directly rather than through `ensureFresh`, so it bypasses the
stale marker and refills both sections.

Stale-year rows under the **old** guid are harmless history. Do not relabel
them: both tables are unique on `(studentGuid, schoolYear, …)`, so an
`UPDATE … SET "schoolYear"` collides with rows already at the target year and
aborts.

## Loose ends

- The orphaned `isActive: false` student row should have gone in the unlink's
  own `student.deleteMany` (:501) and did not. Separate small leak.
- Production shows daily `groups`/`lessons_count` runs at 06:00 and `timetable`
  at 03:00, although the per-task crons were supposedly removed in favour of
  sign-in / manual refresh / first view. Something still schedules them; worth
  confirming which path, since it is what wrote the NULL-stamped runs.

## Reproducing the diagnosis

`docs/ops/` has no runbook for this yet. The queries that settled it:

```sql
-- served vs exists_any per table, for one guid
SELECT 'subject_enrollment' AS tbl, "schoolYear", count(*)
FROM subject_enrollment WHERE "studentGuid" = '<guid>' GROUP BY 1,2;

-- the decisive one: which connection owns the per-student runs
SELECT source, status, "startedAt", "fetchedCount", "householdConnectionId"
FROM sync_run
WHERE split_part(source, ':', 2) = '<guid>'
ORDER BY "startedAt" DESC LIMIT 25;
```

A `NULL` in that last column, next to a `success` inside the source's TTL and
zero rows in the table, is this bug's signature.
