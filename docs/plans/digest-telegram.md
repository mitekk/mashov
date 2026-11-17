# Per-child daily activity digest → Telegram

Spec: `school-parent-portal-requirements-v3.md` (§3–4 product thesis; constraint 4 is
deliberately departed from — see ADR-0027, Task 12).

## Context

Delivery is pull-only today. This feature pushes a per-child Hebrew briefing to Telegram
hourly from 13:00 to 19:00 Asia/Jerusalem. Per child, per hour: a cheap **checker** decides
whether anything unreported exists; only if it does, a **collector** assembles today's facts,
an **LLM summarizer** writes Hebrew prose into a fixed template, and a pluggable **sender**
delivers it. Nothing new → no LLM call, no message, no cost.

Three things the codebase does not have today: durable per-child recipient config, an
outbound third-party egress path (the first ever — ADR-0018 deleted the only one), and a
runtime LLM call.

### Decisions taken (locked — do not revisit)

| Topic | Decision |
|---|---|
| Summarization | LLM (`claude-opus-5-5`, `@anthropic-ai/sdk`) with a deterministic fallback |
| Channel | Telegram only, behind a `DigestSender` interface; `LogSender` for dev/tests |
| Recipients | Per child, in Postgres |
| Dedup | Persisted reported-item rows in Postgres (not Redis — ADR-0017) |
| "Due tomorrow" | LLM-extracted explicit deadline from the Hebrew text when present; else timetable next-lesson heuristic |
| LLM privacy | First names only; family names, GUIDs, teacher/reporter names stripped |

## Global Constraints

1. **Never touch the Mashov egress path.** This module must not depend on
   `MashovHttpClient`, `MashovSessionModule`, or `createMashovAxios`. `HTTPS_PROXY` is
   process-wide and plain axios honours it, so the Telegram and Anthropic clients both set
   `proxy: false` explicitly.
2. **Use `SchoolYearService.currentSchoolYearFor(userId)`** (DB-only). Never
   `resolveForSchool()` — it calls `/api/schools` through the residential proxy. Resolve once
   per run, not per child.
3. **Every query scopes by `schoolYear`.** The rollover work re-keyed `homework_item`,
   `behavior_item`, and `timetable_entry` with it.
4. **Never read `updatedAt` as a novelty signal.** The 12-minute sync tasks upsert identical
   rows and churn it every pass. Novelty is `contentHash` vs `DigestReportedItem`.
5. **Dates.** Mashov sends naive local timestamps (`"2025-09-05T00:00:00"`); in a UTC
   container those store as `...T00:00:00Z`. "Today's rows" means *UTC midnight of the
   Jerusalem calendar day*, never `startOfDay(new Date())`. One shared helper, directly tested.
6. **Do not set a process-wide `TZ`** and do not record digest runs in `sync_run` —
   `sync.controller.ts:16` hardcodes `TOTAL_SYNC_SOURCES = 14` and would silently skew the
   dashboard's freshness percentage. `DigestDelivery` is the digest's own run log.
7. **Logic lives in `*.service.ts`.** `backend/package.json`'s `collectCoverageFrom` excludes
   `src/sync/tasks/**` and `src/**/*.controller.ts`, so the 80 % gate only bites on services.
8. **Secrets are never logged.** `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`.
9. TDD per `.claude/rules/testing.md` — failing test first, always.

## Review Focus

Input classes and failure modes the planned tests do not fully exercise; check each
deliberately at final review:

- An item created late in the day whose `lessonDate` is today but which is first seen by a
  run after the Jerusalem date has rolled — is it lost? (Known plan limitation: the
  homework-new window is today-only by design. Behavior matches on `lessonDate` OR `eventAt`.)
- Free-text `remark` / `homeworkText` naming *other* children, against the first-names-only
  decision. The redaction test covers structured fields; free text is passed through by design.
- An LLM-extracted `explicitDueDate` that differs between two runs for the same homework row.
- Message volume: 7 sends/day/child with no cap.
- Concurrent claim where two runners interleave between `createMany` and `confirmedAt`.
- A silent upstream sync failure presenting as a quiet day.

---

## Task 1: Schema, migration, and the three missing indexes

**Goal.** Three new models plus the indexes the checker needs, migrated.

**Files.** `backend/prisma/schema.prisma`, `backend/prisma/migrations/<ts>_digest/migration.sql`

**Interfaces produced.** `DigestRecipient`, `DigestReportedItem`, `DigestDelivery` Prisma models
consumed by every later task.

**Steps.**

1. Add to `backend/prisma/schema.prisma`:

```prisma
model DigestRecipient {
  id          String   @id @default(cuid())
  userId      String
  studentGuid String
  channel     String
  address     String
  displayName String?
  enabled     Boolean  @default(true)
  activeFrom  DateTime @default(now())
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user AppUser @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([studentGuid, channel, address])
  @@index([studentGuid, enabled])
  @@index([userId])
  @@map("digest_recipient")
}

model DigestReportedItem {
  id          String    @id @default(cuid())
  studentGuid String
  itemType    String
  itemId      String
  contentHash String
  reportedFor DateTime  @db.Date
  claimedAt   DateTime  @default(now())
  confirmedAt DateTime?
  deliveryId  String?

  @@unique([studentGuid, itemType, itemId, contentHash])
  @@index([studentGuid, reportedFor])
  @@map("digest_reported_item")
}

model DigestDelivery {
  id             String   @id @default(cuid())
  studentGuid    String
  reportFor      DateTime @db.Date
  runAt          DateTime @default(now())
  status         String
  itemCount      Int      @default(0)
  recipientCount Int      @default(0)
  channel        String?
  messageText    String?
  usedLlm        Boolean  @default(false)
  errorMessage   String?

  @@index([studentGuid, reportFor])
  @@map("digest_delivery")
}
```

   `itemType` is `'behavior' | 'homework_new' | 'homework_due'` — the *reason* an item was
   reported, so one homework row can be reported once as new and later as due.
   `activeFrom` stops the first run blasting a backlog.
   `contentHash` is in the unique key on purpose: a teacher editing homework text yields a new
   hash → a new row → a legitimate re-report as changed. A stable hash means already reported.

2. Add `digestRecipients DigestRecipient[]` to `AppUser`.
3. Add the indexes that do not exist today (the composite uniques lead with `studentGuid`, so
   child lookups are covered but date-range scans are not):
   - `HomeworkItem`: `@@index([studentGuid, schoolYear, lessonDate])`
   - `BehaviorItem`: `@@index([studentGuid, schoolYear, lessonDate])` **and**
     `@@index([studentGuid, schoolYear, eventAt])` — the checker matches on either date.
   - `SyncRun`: `@@index([source, startedAt])` — unrelated but adjacent;
     `FreshnessService.getAllSourceHealth()` table-scans `sync_run`, which has no index at all
     and grows forever. Cheap to fix while we are in the schema.
4. `cd backend && npx prisma migrate dev --name digest`
   **Expected:** migration applies cleanly; `npx prisma generate` succeeds.
5. `cd backend && npx tsc --noEmit`
   **Expected:** exit 0.

**Commit.** `feat(db): add digest recipient, reported-item, and delivery tables`

---

## Task 2: Types, date helpers, and deadline derivation

**Goal.** `digest.types.ts` and `digest-deadline.service.ts`, including the two helpers that
are the easiest things in this feature to get wrong.

**Files.** `backend/src/digest/digest.types.ts`, `backend/src/digest/digest-deadline.service.ts`,
`backend/src/digest/digest-deadline.service.spec.ts`

**Interfaces produced.**
- `DigestItemType = 'behavior' | 'homework_new' | 'homework_due'`
- `DigestCandidate { itemType; itemId; contentHash; ... }`
- `DigestPayload` — consumed by Tasks 4 and 5.
- `jerusalemDayBounds(now: Date, timeZone: string): { todayStart: Date; tomorrowStart: Date; reportFor: Date }`
- `mashovDayFromJsDate(d: Date): number`
- `estimateFromTimetable(studentGuid, schoolYear, groupId, fromDate): Promise<Date | null>`
- `hasDeadlineHint(text: string): boolean`

**Steps.**

1. **RED** — write `digest-deadline.service.spec.ts` first, using the existing fake-timer
   pattern from `backend/src/common/school-year/school-year.service.spec.ts:54`:

```ts
jest.useFakeTimers({ doNotFake: ['nextTick'] });
jest.setSystemTime(new Date(2026, 10, 17, 14));
```

   Cases:
   - `mashovDayFromJsDate`: Sunday → 1, Friday → 6, Saturday → 7 (never matches a lesson).
     Weekday base is **confirmed** by `apis/get-api-students-id-timetable.md:38`:
     `day` is `1 = Sunday … 6 = Friday`, so `mashovDay = jsGetDay() + 1`. An off-by-one here
     silently shifts every estimate by a day, which is why it is its own named helper with its
     own test.
   - `jerusalemDayBounds`: a January system time (IST, UTC+2) and a July one (IDT, UTC+3);
     both must produce UTC-midnight boundaries of the *Jerusalem* calendar date. Include a
     22:00-Jerusalem case, where the UTC date and the Jerusalem date differ.
   - `estimateFromTimetable`: walks forward from `fromDate + 1` up to 14 days over the `day`
     values of the `(studentGuid, schoolYear, groupId)` `TimetableEntry` rows, returning the
     first matching weekday; returns `null` when the group has no entries.
   - `hasDeadlineHint`: matches `מחר`, `עד יום`, `להגיש`, and a bare date; does not match
     ordinary homework prose.
   **Expected:** suite fails — module does not exist.
2. **GREEN** — implement both helpers and the service.
   **Expected:** `cd backend && npx jest src/digest/digest-deadline` passes.

**Note.** `hasDeadlineHint` deliberately *widens* the candidate set so the LLM can later
resolve an explicit deadline the timetable would have missed; the LLM then *narrows* it. This
is why the LLM's extraction cannot be the gate — the checker must stay LLM-free.

**Commit.** `feat(digest): derive homework deadlines from timetable and text hints`

---

## Task 3: The checker

**Goal.** `digest-checker.service.ts` — the cheap predicate plus candidate-ID production.
Four narrow queries, no LLM, no upstream calls, run per child 7×/day.

**Files.** `backend/src/digest/digest-checker.service.ts` + `.spec.ts`

**Interfaces consumed.** Task 2's `jerusalemDayBounds`, `estimateFromTimetable`,
`hasDeadlineHint`, `DigestCandidate`.
**Interfaces produced.** `check(studentGuid, schoolYear, now): Promise<DigestCandidate[]>`

**Steps.**

1. **RED** — spec first. Cases: nothing new; new behavior; new homework; due-tomorrow;
   an edited item re-reports (hash changes); an unconfirmed stale claim is reclaimed;
   the `activeFrom` cutoff excludes older items.
   **Expected:** fails — module absent.
2. **GREEN** — implement:
   - **Behavior today.** `BehaviorItem` carries *two* dates: `lessonDate` (when the event
     happened) and `eventAt` (when the teacher recorded it, from Mashov's `timestamp`). Match
     on **either**:
     `where: { studentGuid, schoolYear, OR: [{ lessonDate: { gte: todayStart, lt: tomorrowStart } }, { eventAt: { gte: todayStart, lt: tomorrowStart } }] }`,
     selecting `{ id, eventCode, achvaName, classification, justifiable, subject, remark, lessonDate, eventAt }`.
     A `lessonDate`-only window would silently miss a teacher entering yesterday's absence
     this afternoon — exactly the news a parent wants today. Dedup is by `contentHash`, so
     widening cannot cause a repeat.
   - **Homework assigned today.** Same window on `homeworkItem.lessonDate`, selecting the
     fields the parent sees.
   - **Homework possibly due tomorrow.** Bounded lookback (`DIGEST_DUE_LOOKBACK_DAYS`,
     default 14). A row is a candidate if **either** `estimateFromTimetable` puts its group's
     next lesson tomorrow **or** `hasDeadlineHint(homeworkText)` matches.
   - **One** dedup query: `digestReportedItem.findMany({ where: { studentGuid, contentHash: { in: hashes } } })`,
     ignoring rows that are unconfirmed **and** `claimedAt` older than 30 minutes (crashed
     claims). Any candidate whose hash is absent ⇒ something to report.
   - Filter out items dated before the child's earliest `DigestRecipient.activeFrom`.
   `contentHash` is sha256 over the fields actually shown to the parent.
   **Expected:** `npx jest src/digest/digest-checker` passes.

**Commit.** `feat(digest): decide cheaply whether a child has anything unreported`

---

## Task 4: Collector and report template

**Goal.** Build the payload from DB rows; render the fixed Hebrew template deterministically.

**Files.** `backend/src/digest/digest-collector.service.ts`,
`backend/src/digest/digest-report.template.ts`, + specs

**Interfaces produced.** `collect(studentGuid, candidates): Promise<DigestPayload>`;
`renderReport(payload, lines): string` where `lines` is the LLM's prose or the deterministic
fallback strings.

**Steps.**

1. **RED** — specs first, including the deterministic fallback rendering and the
   `צפי הגשה` estimate label.
   **Expected:** fails.
2. **GREEN** — implement. The template owns section headers, item bullets, and the estimate
   label. The LLM writes prose; it never decides what is in the report.
   **Expected:** `npx jest src/digest/digest-collector src/digest/digest-report` passes.

**Commit.** `feat(digest): assemble and render the Hebrew report deterministically`

---

## Task 5: Summarizer

**Goal.** One Anthropic call per child per run, only after the checker says yes, with a
deterministic fallback that still sends.

**Files.** `backend/src/digest/digest-summarizer.service.ts` + `.spec.ts`

**Steps.**

1. `cd backend && npm install @anthropic-ai/sdk`
2. **RED** — spec first with a mocked SDK: happy path; timeout → fallback; malformed output →
   fallback; **and the redaction assertion**; and that the client is constructed with
   `proxy: false`.
   **Expected:** fails.
3. **GREEN** — implement. `claude-opus-5-5`, `output_config: { effort: 'low' }` (small,
   well-specified task), `max_tokens: 2000`, non-streaming, structured output via
   `output_config.format`:

```ts
{
  headline: string,            // one short Hebrew line
  behaviorLine: string,        // Hebrew, 1–2 sentences
  homeworkLine: string,
  dueTomorrowLine: string,
  deadlineResolutions: Array<{ ref: string; explicitDueDate: string | null }>,
}
```

   **PII boundary.** The prompt carries: child **first name** (`Student.privateName`), subject
   names, `achvaName`, `classification`, remark text, dates, homework text. It does **not**
   carry family names, `studentGuid`, `reporter`, teacher names, or usernames. A single
   `buildPrompt()` owns this redaction and is unit-tested against it directly — that test is
   the enforcement mechanism.

   Deadline resolution order: **explicit from text > timetable estimate**. A candidate whose
   explicit deadline is *not* tomorrow is dropped from the due-tomorrow section but **still
   recorded as reported**, so it is not re-evaluated every hour.

   Failure (timeout, 429, refusal, malformed output): log, set `usedLlm: false`, render the
   same template with deterministic Hebrew strings, and **still send** — a parent getting a
   plainer message beats a parent getting nothing. Tone precedent:
   `backend/src/dashboard/dashboard.service.ts:277-283` already emits Hebrew status strings.
   **Expected:** `npx jest src/digest/digest-summarizer` passes.

**Commit.** `feat(digest): summarize the day in Hebrew with a deterministic fallback`

---

## Task 6: Senders and recipient service

**Files.** `backend/src/digest/senders/digest-sender.interface.ts`,
`senders/telegram.sender.ts`, `senders/log.sender.ts`,
`backend/src/digest/digest-recipient.service.ts`, + specs

**Interfaces produced.** `DigestSender { channel: string; send(address: string, text: string): Promise<void> }`

**Steps.**

1. **RED** — specs first. Telegram: posts to the Bot API `sendMessage`; constructed with
   `proxy: false` (assert it — `HTTPS_PROXY` is process-wide and plain axios honours it, and
   ADR-0023's egress hop is a single residential tinyproxy with a 10 s `AbortSignal` and no
   retry-on-abort); never logs the token. Recipient service: CRUD.
   **Expected:** fails.
2. **GREEN** — implement. `LogSender` is the dev/test/dry-run sink.
   **Expected:** `npx jest src/digest/senders src/digest/digest-recipient` passes.

**Commit.** `feat(digest): add pluggable senders and recipient management`

---

## Task 7: Orchestration with claim-then-send

**Goal.** `digest.service.ts` — enumerate children → check → claim → summarize → send → confirm.

**Files.** `backend/src/digest/digest.service.ts` + `.spec.ts`

**Steps.**

1. **RED** — spec first: concurrent claim; send failure rolls back the claim; per-child
   isolation; empty result writes `skipped_empty`.
   **Expected:** fails.
2. **GREEN** — implement. `RedisService` has no `SET NX`, no Lua, and no raw client, and
   ADR-0017 forbids durable state there, so correctness comes from the Postgres unique
   constraint, following the `fingerprint` precedent at
   `backend/src/sync/tasks/notifications.task.ts:117-124`:
   1. `createMany({ data: claimRows, skipDuplicates: true })` → returns `count`.
   2. `count === 0` ⇒ another runner (or an earlier hour) already owns every item → skip, send
      nothing.
   3. `count > 0` ⇒ we own them. Summarize and send.
   4. On success: `updateMany` sets `confirmedAt` + `deliveryId`; write `DigestDelivery`
      `status: 'sent'`.
   5. On failure: delete the rows we just claimed, write `status: 'failed'`. Next hour retries.
   6. A crash between 1 and 5 leaves unconfirmed rows — the checker's 30-minute staleness rule
      reclaims them, so nothing is silently lost.

   Plus an in-process `running` guard (precedent: `inFlightManualRefreshByConnection` at
   `backend/src/sync/sync.service.ts:26`) so a slow run never overlaps itself.

   Per-child failure isolation: `try/catch` per child, exactly as `homework.task.ts:70-199`
   does. One child's LLM or Telegram failure must not stop the others.

   Empty result → write a `DigestDelivery` row with `status: 'skipped_empty'` and return. The
   row matters: it is the only way to tell "quiet day" from "job is broken".
   **Expected:** `npx jest src/digest/digest.service` passes.

**Commit.** `feat(digest): orchestrate per-child runs with claim-then-send`

---

## Task 8: Cron task and module wiring

**Files.** `backend/src/digest/tasks/digest.task.ts`, `backend/src/digest/digest.module.ts`,
`backend/src/app.module.ts`

**Steps.**

1. `@Cron('0 13-19 * * *', { timeZone: 'Asia/Jerusalem' })` — seven runs, 13:00…19:00.
   **No existing cron in this repo passes `timeZone`** and there is no `TZ` env anywhere, so
   this is new ground: without it the job fires 10:00–16:00 Israel time in winter and shifts
   with DST. Gated by `DIGEST_ENABLED`, defaulting to `false`.
   No catch-up run — each hour re-derives candidates from the DB, so a missed 15:00 is covered
   by 16:00. Only a miss of the entire window loses a day, and `DigestDelivery` history makes
   that visible.
2. The task is a `@Cron` shell only — no logic (coverage-exempt per `collectCoverageFrom`).
3. `digest.module.ts` imports `PrismaModule`, `ConfigModule`, and `SchoolYearModule` (which
   already exports `SchoolYearService`). Import `SyncModule` only if
   `BehaviorClassifierService` is actually needed — `BehaviorItem.classification` is already
   persisted, so it probably is not.
4. Register in `app.module.ts`.
   **Expected:** `cd backend && npx tsc --noEmit` exits 0; `npx jest src/digest` passes.

**Commit.** `feat(digest): schedule hourly afternoon runs in Asia/Jerusalem`

---

## Task 9: Controller, frontend slow path, API contract

**Goal.** The API surface, per `.claude/rules/api.md` (`/api/v1`, plural nouns, no verbs in
paths, string IDs, error envelope).

**Files.** `backend/src/digest/digest.controller.ts`,
`frontend/src/app/api/v1/[...path]/route.ts`, `docs/api-contract.md`

| Method | Path | Body | Response | Auth |
|---|---|---|---|---|
| GET | `/api/v1/digest/recipients?studentGuid=` | — | `{ data: [...] }` | Yes |
| POST | `/api/v1/digest/recipients` | `{ studentGuid, channel, address, displayName? }` | 201 `{ data: recipient }` | Yes |
| PATCH | `/api/v1/digest/recipients/:id` | `{ enabled?, displayName? }` | 200 | Yes |
| DELETE | `/api/v1/digest/recipients/:id` | — | 204 | Yes |
| POST | `/api/v1/digest/runs` | `{ studentGuid?, dryRun? }` | 201 `{ data: results[] }` | Yes |
| GET | `/api/v1/digest/deliveries?studentGuid=&page=&limit=` | — | 200 paginated envelope | Yes |

**Steps.**

1. `AppSessionGuard` is registered globally (`backend/src/app.module.ts:42`), so every
   endpoint above is authenticated with no extra wiring and no `@Public()` decorator.
2. `ThrottlerGuard` is also global at 50 req/min; give `POST /digest/runs` a tighter
   `@Throttle` (it spends LLM tokens and sends real messages), following the 5/min precedent
   on `POST /sync/refresh`.
3. **Ownership.** `Student` has no `userId`/`connectionId` FK — children are global, and every
   existing cron iterates `student.findMany({ where: { isActive: true } })`; the
   `persistRoster()` doc comment on `mashov-session.service.ts` says as much. `DigestRecipient`
   rows therefore become the de-facto ownership mapping: a child gets a digest only if an
   enabled recipient row exists. This sidesteps the missing FK, makes delivery strictly
   opt-in (correct for pushing children's behavior data to a messaging app), and needs no
   roster refactor. Knowingly accepted failure mode: nothing stops user A creating a recipient
   row for user B's child. Mitigation now — the controller requires `studentGuid` to be in
   `student.findMany({ isActive: true })`, and the row records `userId`, so every row is
   attributable. A real ownership fix is separate work; note it in ADR-0026.
4. `POST /api/v1/digest/runs` makes an LLM call, so add its prefix to `SLOW_PATH_PREFIXES` in
   `frontend/src/app/api/v1/[...path]/route.ts` — otherwise it inherits the 15 s
   `PROXY_TIMEOUT_MS` bound (the `PROXY_SLOW_TIMEOUT_MS` precedent added for `/sync/*`).
5. Update `docs/api-contract.md`.
   **Expected:** `npx tsc --noEmit` exits 0 in both `backend/` and `frontend/`.

**Commit.** `feat(digest): expose recipient, run, and delivery endpoints`

---

## Task 10: Retention prune

**Goal.** A daily prune deleting `DigestReportedItem` and `DigestDelivery` rows with
`reportedFor` / `reportFor` older than 90 days — folded into the existing `0 2 * * *` cleanup
cron in `backend/src/app-session/app-session.service.ts`, or its own `@Cron`.

**Steps.**

1. **RED** — spec first: rows older than 90 days go, newer rows stay.
   **Expected:** fails.
2. **GREEN** — implement.
   **Expected:** `npx jest` for the touched spec passes.

**Commit.** `feat(digest): prune reported items and deliveries after 90 days`

---

## Task 11: Integration test

**Files.** `tests/integration/digest.test.ts`

**Steps.** Against real Postgres: seed two children, one with today's behavior + homework and
one with nothing. Assert child A produces one `DigestDelivery status: 'sent'` and child B
`'skipped_empty'`. Run the digest twice and assert the second run sends nothing. Edit a
homework row's text and assert it re-reports.
**Expected:** `npm run test:integration` passes.

**Commit.** `test(digest): cover dedup, quiet days, and re-reporting against Postgres`

---

## Task 12: ADRs, README, env, compose

**Goal.** Documentation and configuration. `0024` is taken by the school-year rollover, so the
digest ADRs are `0025` and `0026`.

**Config** — add to `.env.example`, `backend/.env.example`, the `docker-compose.yml` backend
service, and the README config table (`README.md:160-166`). Follow the existing pattern:
injected `ConfigService` with an inline default at the read site; no zod anywhere in this repo.

| Var | Default | Notes |
|---|---|---|
| `DIGEST_ENABLED` | `false` | Master switch for the cron |
| `DIGEST_DRY_RUN` | `true` | Renders + logs, sends nothing. Safe first deploy |
| `DIGEST_TIMEZONE` | `Asia/Jerusalem` | Also used for "today"/"tomorrow" |
| `DIGEST_DUE_LOOKBACK_DAYS` | `14` | Due-tomorrow candidate window |
| `DIGEST_LLM_MODEL` | `claude-opus-5-5` | |
| `DIGEST_LLM_TIMEOUT_MS` | `30000` | |
| `ANTHROPIC_API_KEY` | — | Secret. Never logged |
| `TELEGRAM_BOT_TOKEN` | — | Secret. Never logged |

**ADR-0026 — Outbound digest delivery and runtime LLM egress.** Why a pluggable sender with
Telegram first; why this is the project's first third-party egress and why it must bypass the
Mashov proxy; what child data leaves the host and the first-names-only redaction; why push was
a Phase-1 must-not and what changed; the recipient-row-as-ownership trade-off.
`ANTHROPIC_API_KEY` and `TELEGRAM_BOT_TOKEN` are the first non-Mashov secrets in the project
and `ops/` has no secrets-management path — flag that. `docs/model-routing-policy.md` governs
the *build* agents, not runtime LLM use — this ADR fills that gap.

**ADR-0027 — Derived homework deadlines.** Documents the departure from requirements
constraint 4: *"Homework has no proven due date field… must not promise overdue or due-soon
logic."* Confirmed — `apis/get-api-students-studentguid-homework.md` exposes only `lessonDate`
(when homework was **given**). The "1 day remains" half of this feature is therefore a
**derived estimate** (explicit text > timetable next-lesson), and the report must label it as
such (`צפי הגשה` / "estimated", never "due").

Update `docs/adr/README.md`.

**Commit.** `docs(digest): record delivery, LLM egress, and derived-deadline decisions`

---

## Verification

**Unit** — `cd backend && npm test`. 80 % line gate. Cover both DST sides (a January and a
July system time) and the 13:00 / 19:00 boundaries.

**Integration** — `npm run test:integration` against real Postgres.

**End to end, manually** —

```bash
docker compose up --build
# seed a recipient for your own Telegram chat id
curl -X POST localhost:3000/api/v1/digest/recipients -d '{...}'
# dry run first — renders and logs, sends nothing
curl -X POST localhost:3000/api/v1/digest/runs -d '{"dryRun":true}'
docker compose logs backend | grep Digest
# then a real send with DIGEST_DRY_RUN=false
curl -X POST localhost:3000/api/v1/digest/runs -d '{}'
curl localhost:3000/api/v1/digest/deliveries
```

Confirm the Hebrew message renders RTL-correctly in Telegram, the estimate label reads as an
estimate, and that a second immediate run sends nothing.

**Pre-submission** — `npm run lint`, `npm run typecheck`, `npm audit --audit-level=high`,
then `/review` against the Definition of Done.

## Risks

| Risk | Handling |
|---|---|
| **Silence is ambiguous** — a quiet child looks identical to a broken job. | Every run writes a `DigestDelivery` row (`skipped_empty` included) and `GET /digest/deliveries` exposes them. Optional follow-up: an opt-in "all clear" at the 19:00 run only. |
| **First run blasts a backlog.** | `DigestRecipient.activeFrom` cuts off anything older; windows are hard-bounded; `DIGEST_DRY_RUN=true` by default. |
| **`updatedAt` is not a novelty signal.** | Never read it. Novelty is `contentHash` vs `DigestReportedItem`. |
| **Timetable weekday off-by-one.** | Base confirmed (`1 = Sunday`); conversion isolated in one tested helper. |
| **Naive timestamps + UTC containers.** | Jerusalem calendar date → UTC boundaries, one shared helper, directly tested. |
| **DST.** | `timeZone` on `@Cron`; specs run at a January and a July system time. |
| **13:00 is early** — Israeli school days end 13:00–14:00 and teachers enter behavior later. | Accepted: hourly incremental reporting means later runs pick it up, and dedup stops repeats. |
| **Double-send across restarts / instances.** | Postgres unique constraint + claim-then-send + 30-min unconfirmed reclaim. No Redis lock exists to use. |
| **LLM latency or failure stalls the window.** | Per-child timeout, per-child try/catch, deterministic fallback that still sends. |
| **Secrets** — two new third-party credentials, no ops path. | Env vars + `.env.example` placeholders, never logged; flagged in ADR-0026. |
| **Telegram client accidentally using the Mashov residential proxy.** | `proxy: false` explicitly on both clients. Asserted in a unit test. |
| **No child→parent FK.** | Validated against the active roster, `userId` recorded, limitation documented in ADR-0026. |
| **`sync_run` unindexed and unbounded.** | `@@index([source, startedAt])` added in Task 1. |
