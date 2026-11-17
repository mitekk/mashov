# Fix: children data frozen at the 2025/26 school year

See the conversation plan. Stages:

1. Stage 1 — Production hotfix (ops only, no code). Measure `/api/schools` max year,
   `UPDATE household_connection SET "schoolYear" = 2027`, set `MASHOV_YEAR=2027`,
   restart backend, parent re-signs-in. Rollback = revert env + UPDATE.
2. Stage 2 — `SchoolYearService` (auto-detect year, persist on connection, daily
   re-check) + `SchoolYearRolloverTask`. Remove `?? '2026'` literals and pinned
   `MASHOV_YEAR: "2026"` in compose/CI.
3. Stage 3 — Roster refresh: `students.task.ts`, `persistRoster` on the
   per-connection login path, per-user `ensureStudentsAvailable`, TTL short-circuit,
   NOT_FOUND envelope fix.
4. Stage 4 — `schoolYear Int @default(0)` column on HomeworkItem, BehaviorItem,
   SubjectEnrollment, TimetableEntry, MessageBoardItem; unique keys absorb the year;
   backfill script + committed migration; query sites scoped.
5. Stage 5 — Observability: `students` freshness source, `computeContentFreshness()`,
   drop `student.updatedAt` from `latestUpdateAt`.
6. Stage 6 — ADR 0024.
