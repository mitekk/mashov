# Grades view in the child page

## Context

`apis/get-api-students-id-grades.md` documents the upstream Mashov endpoint
`GET /api/students/{studentGuid}/grades` — every graded assessment of the current school
year (numeric grade, assessment title, type, subject, teacher, dates). Nothing in the
product consumes it yet: `grep -ri grade backend/src frontend/src` finds only `degraded`
and `downgrade`. There is no Prisma model, no sync task, no route, no type, no component.

A parent currently sees שיעורי בית / התנהגות / מקצועות / הודעות / לוח שיעורים on a child's
page and has to go back to Mashov itself to see how the child is actually doing. This adds
**ציונים** as a sixth section of the existing child workspace.

Outcome: a parent opens `/children/<guid>?section=grades` and sees one card per subject —
subject name, its average, and a row per assessment (title, type, date, grade badge) —
served from our own Postgres, so it works offline and degrades the same way every other
section does.

**Scope note:** `docs/prd/PRD-current.md` lists "Grade reports, performance analytics" and
"Grades or report cards" under *Out of Scope (Phase 2)*. This change deliberately moves the
read-only view into scope; the PRD should be re-cut with `/prd` afterwards. "Performance
analytics" stays out — no charts, no trends.

## Decisions taken

- **Synced into Postgres**, not a live passthrough — same shape as `behavior`/`subjects`,
  so grades survive an upstream outage, are year-scoped, and appear in source-health.
- **Grouped by subject with an average**, computed in a pure frontend model module. This
  follows `timetable-model.ts`: the backend returns flat year-scoped rows (exactly as
  `getSubjects` does), and the grouping/averaging lives in a separately unit-tested module.
- **Read-only.** No `isNew`/`isArchived` state, no feed entry, no digest item, no detail
  route. The model is shaped so those can be added later; none of them is in this change.

---

## Backend

### Task 1. Prisma model — `backend/prisma/schema.prisma`

Add `GradeItem`, modelled on `BehaviorItem` and `SubjectEnrollment`:

```prisma
model GradeItem {
  id             String   @id @default(cuid())
  studentGuid    String
  gradingEventId Int
  grade          Int
  gradingPeriod  Int
  gradeTypeId    Int
  gradeType      String
  gradingEvent   String
  groupId        Int
  groupName      String
  subjectName    String
  teacherName    String
  eventDate      DateTime
  enteredAt      DateTime            // upstream `timestamp`
  rawPayload     Json?
  schoolYear     Int      @default(0)
  updatedAt      DateTime @updatedAt

  @@unique([studentGuid, schoolYear, gradingEventId])
  @@index([studentGuid, schoolYear, eventDate])
  @@map("grade_item")
}
```

- Upstream `id` and `gradingEventId` are identical in every observed row; store the one
  field and key on it. `rate`/`gradeRate` are `0.0` in all observed rows (unweighted) — not
  stored, and the average is therefore a plain mean. Note this in a comment.
- `timestamp` → `enteredAt` to avoid the `eventDate`/`timestamp` confusion the
  `BehaviorItem` comment already warns about.
- Migration: `backend/prisma/migrations/20261129000000_grade_item/migration.sql`,
  hand-written `CREATE TABLE` + indexes, matching the style of the existing migrations.

### Task 2. Sync task — `backend/src/sync/tasks/grades.task.ts`

Copy `backend/src/sync/tasks/behavior.task.ts` structure exactly, minus the
`BehaviorClassifierService` dependency (grades need no classification):

- `public static readonly SOURCE = 'grades';`
- ~~`@Cron('*/12 * * * *')` — same cadence as homework/behaviour.~~ Removed
  with every other per-task cron (ADR-0046). `grades` is now freshened when
  the ציונים section is opened, behind a 6h TTL.
- Local `interface MashovGrade` mirroring the fields in `apis/get-api-students-id-grades.md`.
- Keep the whole fan-out skeleton verbatim: `studentScopeForContext`,
  `orderConnectionsForStudent`, the shared-session refusal when `requestedYear` is set,
  `getForConnection` per connection with
  `Referer: https://web.mashov.info/students/main/students/${guid}/regularGrades`,
  `stampOwnershipIfChanged`, the `if (!answered) throw` guard, `SyncRunService.openRun`/
  `closeRun` per student, and the `SyncTaskRunResult` return.
- Upsert on `studentGuid_schoolYear_gradingEventId`.

### Task 3. Sync wiring (three one-line edits)

- `backend/src/sync/sync.module.ts` — add `GradesTask` to `providers`.
- `backend/src/sync/sync.service.ts` — add `{ name: 'grades', fn: () => this.gradesTask.execute(context) }` to `buildTasks`, next to `behavior`.
- `backend/src/sync/freshness.service.ts` — add `'grades'` to the 24-hour
  `SOURCE_THRESHOLDS` entry beside `homework`/`behavior` **and** to
  `PER_STUDENT_SOURCES`, since the run key carries a `:${studentGuid}` suffix.

**Not** added to `history-backfill.task.ts`. The backfill writes a per-year completion
marker, so a year already marked complete would never pick a new source up; grades are
current-year only here. Worth saying so in a comment on `yearScopedTasks()`.

### Task 4. Read route

- `backend/src/children/children.service.ts` — `getGrades(studentGuid, userId?)`, a direct
  analogue of `getSubjects`: `requireStudent` **first**, then
  `currentYearScope(await schoolYearForConnection(this.prisma, student.householdConnectionId))`,
  `orderBy: [{ eventDate: 'desc' }]`, mapping each row to the response shape with
  `eventDate`/`enteredAt`/`updatedAt` as `.toISOString()`.
- `backend/src/children/children.controller.ts` — beside `getSubjects`:
  ```ts
  @Get(':studentGuid/grades')
  async getGrades(@Param('studentGuid') studentGuid: string, @Req() req: Request) {
    return this.childrenService.getGrades(studentGuid, req.user?.userId);
  }
  ```
  No DTO — no query params. Authentication is the global `AppSessionGuard`; authorization is
  `requireStudent` → `canSeeStudent`, which 404s (not 403s) a foreign child.

### Task 5. Docs

- `docs/api-contract.md` — new row in the Phase 1 endpoint table and a
  `### GET /api/v1/children/:studentGuid/grades` response-schema section.

---

## Frontend

### Task 6. Types — `frontend/src/types/api.ts`

New `// ─── Grades ───` banner section following the `Subjects` conventions (`id: string`,
ISO strings, no optionals):

```ts
export type GradeTypeId = 1 | 2 | 3 | 4 | 7;

export interface GradeItem {
  id: string;
  studentGuid: string;
  gradingEventId: number;
  grade: number;
  gradingPeriod: number;
  gradeTypeId: number;
  gradeType: string;        // Hebrew label from upstream
  gradingEvent: string;     // free-text assessment title
  groupId: number;
  groupName: string;
  subjectName: string;
  teacherName: string;
  eventDate: string;
  enteredAt: string;
  updatedAt: string;
}

export interface GradesResponse { data: GradeItem[] }
```

### Task 7. Fetcher — `frontend/src/api/children.ts`

`fetchChildGrades(studentGuid)` + private `normalizeGrade(item: UnknownRecord)`, copying
`fetchChildSubjects` verbatim including the `T[] | {data: T[]}` tolerance and the
`String(x ?? '')` / `Number(x ?? 0)` coercion in the normalizer.

### Task 8. Hook — `frontend/src/hooks/useChild.ts`

```ts
export function useChildGrades(studentGuid: string) {
  return useQuery({
    queryKey: ['child-grades', studentGuid],
    queryFn: () => fetchChildGrades(studentGuid),
    staleTime: 5 * 60_000,
    enabled: Boolean(studentGuid),
  });
}
```

The `child-` key prefix is load-bearing: `frontend/src/lib/query-invalidation.ts` evicts
per-child caches by `queryKey[0].startsWith('child-')` on school unlink.

### Task 9. Model — `frontend/src/components/child/grades-model.ts`

Pure, no React — the `timetable-model.ts` precedent. Reuse it from the section component so
the arithmetic is testable on its own:

```ts
export interface SubjectGrades {
  subjectName: string;
  average: number | null;   // null when the subject has no numeric grade
  grades: GradeItem[];      // newest eventDate first
}
export function groupGradesBySubject(grades: GradeItem[]): SubjectGrades[];
export function overallAverage(groups: SubjectGrades[]): number | null;
```

- Group by `subjectName`, sort groups by subject name, grades within a group by `eventDate`
  descending. Average = plain mean (`rate`/`gradeRate` are unweighted upstream), rounded to
  one decimal.
- Skip non-finite / out-of-range grades rather than poisoning an average — a school can be
  in `textualGradesClasses` (see `apis/post-api-login.md`), where grades are not numeric.

New `frontend/src/lib/grades.ts` for presentation, mirroring `frontend/src/lib/behavior.ts`:
`gradeBandVariant(grade): 'positive' | 'info' | 'attention'` so the grade badge reuses the
existing `Badge` variants rather than new colours.

### Task 10. Section — `frontend/src/components/child/GradesSection.tsx`

Built on `SubjectsSection.tsx`, which is the closest existing shape:

- `<section data-testid="grades-section" aria-labelledby="grades-section-title" className="section-stack py-1">`
  with an `sr-only` `<h2>ציונים</h2>` — the tab rail already names the section.
- Four-branch body, identical to every other section: `isLoading && <TableSkeleton rows={5} />`,
  `isError && <ErrorState message="לא ניתן לטעון ציונים" onRetry={() => void refetch()} />`,
  empty → `<EmptyState icon={<ClipboardList className="w-8 h-8" />} title="אין ציונים" />`,
  else the content.
- Content: one `card-base` per `SubjectGrades`. Header row = subject name + `ממוצע {average}`
  (or `—`). Body = a row per grade: `gradingEvent` (title), a `neutral` `Badge` with
  `gradeType`, `formatShortDate(eventDate)` from `frontend/src/lib/dates.ts`, and the grade
  in a `Badge` whose variant comes from `gradeBandVariant`. Numerics get `tabular-nums`,
  missing values render `'—'`.
- Testids: `grades-section`, `grades-subject-${groupId}`, `grades-subject-average-${groupId}`,
  `grades-item-${grade.id}`.
- Logical CSS properties only (`text-start`, `text-end`, `ms-*`) — the app is `dir="rtl"`.

### Task 11. Wiring

- `frontend/src/lib/child-routes.ts` — add `'grades'` to `CHILD_SECTIONS`. Everything
  else (`parseChildSection`, `buildChildSectionHref`) derives from it. Leave
  `DEFAULT_CHILD_SECTION` as `'homework'`.
- `frontend/src/components/child/ChildWorkspacePage.tsx` — one `SECTIONS` entry
  `{ id: 'grades', label: 'ציונים', icon: <ClipboardList className="w-3.5 h-3.5" /> }`
  (after `subjects`), and one render branch `{activeSection === 'grades' && <GradesSection studentGuid={studentGuid} />}`.
  Do **not** add a second tab rail — one copy of each `section-tab-*` testid only.
  No `page-shell-wide` for this section.

---

## Task 12. Tests

- `backend/src/children/children.service.spec.ts` — add `getGrades` to **both** table-driven
  `ROUTES` suites (the foreign-child `404` + "no upstream call happened" one, and the
  `targetForStudent` one). Plus a case asserting the year scope and `eventDate desc` order.
- `backend/src/sync/tasks/grades.task.spec.ts` — model on `homework.task.spec.ts`:
  upsert key, fan-out to the owning connection first, the shared-session year refusal, and
  `status: 'failed'` when every connection fails.
- `tests/integration/children-route-guard.test.ts` — needs **no new test** (it enumerates
  `:studentGuid` routes from Nest metadata and calls each as both parents), but its
  metadata/controller-source count assertion will need the new route accounted for.
- `frontend/src/components/child/grades-model.test.ts` — vitest: grouping, ordering,
  average rounding, a subject with no numeric grades, and an out-of-range grade excluded.
- `tests/e2e/pages/ChildWorkspacePage.ts` — widen the section union in all three places
  (`navigate`, `sectionTab`, `clickSection`).
- `tests/e2e/children.spec.ts` — a `makeGradeItem` factory, a `**/children/*/grades**` stub
  in `stubWorkspaceRoutes`, and tests for: tab navigates and renders, subject grouping +
  average, empty state, error + retry.
- `.github/e2e-map.json` — no new key needed. Editing the map at all forces a full
  run, so leave it alone.

## Verification

```bash
npm run lint                      # backend + frontend typecheck
npm run test:unit                 # includes the new service + task specs
npm run test:integration          # route-guard enumeration picks up /grades
docker compose up --build         # stack healthy, migration applies
npm run test:e2e                  # children.spec.ts
```

Then against the live stack, confirm the sync actually lands rows rather than trusting the
mocks (unset `HTTPS_PROXY` first — the prod tinyproxy ACL 403s every Mashov call from here).

Finally open `/children/<guid>?section=grades` in the browser and check: subject cards with
averages, the ציונים tab reachable from the rail, RTL alignment, dark mode, and a phone
viewport. Confirm `GET /api/v1/settings/source-health` now reports a `grades` source.

## Follow-ups (not in this change)

- Re-cut the PRD with `/prd` — grades are currently listed as out of scope.
- An ADR is not required: this adds no new pattern, it re-applies the synced-source one.
- Feed / digest / `isNew` read-state for grades; a per-grade detail route; term
  (`gradingPeriod`) filtering once a second term exists in the data.
- `schoolSettings.denyStudentsRegularGrades` and `textualGradesClasses` from
  `apis/post-api-login.md` are not surfaced anywhere in the app. A school that denies grade
  visibility, or a class on textual grades, will simply sync nothing and hit the empty
  state — correct, but unexplained to the parent.
