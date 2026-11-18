# Two schools, one session — merged household access

## Context

A parent has children at two different schools. Mashov issues a separate account per
school, so today seeing the second school's children means signing out and signing
back in with the other account. That is the reported problem.

Three decisions taken with the user before planning:

1. **Merged, not switched.** Home, `/children` and `/inbox` show children and mail from
   both schools at once, each child labelled with its school, plus a school filter chip
   row. There is **no "active school" mode at any layer** — no header indicator, no nav
   change. This matches what the product already is: `README.md` promises "a single,
   aggregated briefing across all your children", Home is already a cross-child feed,
   and every data table is already keyed by `studentGuid` with no school column.
2. **Scope reads to the household in the same pass.** `docs/prd/PRD-current.md:12` claims
   Phase 2 delivered "a secure, multi-tenant system where multiple parents … view only
   their own children's data". It did not: `Student` has no user or school column and
   `ChildrenService.getChildren()` returns every active student row with no ownership
   check. Stamping each student with its owning connection — which this feature needs
   regardless — is what that isolation needs, and both touch the same query paths.
3. **Either school's credentials sign you in.** At login, if school+username matches a
   connection already linked to a household, the session attaches to that household, so
   there is no dead end where signing in with the second school shows an empty app.

## What already works — reuse, don't rebuild

- `HouseholdConnection` (`backend/prisma/schema.prisma:10`) is already 1:N on `AppUser`
  with per-school `schoolCode`, `schoolYear`, encrypted password, `mashovUniqueId`.
- Per-connection upstream sessions exist: `MashovSessionService.connectionSessions` keyed
  `"connectionId:year"` (`backend/src/session/mashov-session.service.ts:99`), reached via
  `MashovHttpClient.getForConnection()` (`mashov-http.client.ts:45`).
- ~13 per-student sync tasks already loop every active connection and take the first
  successful response (`backend/src/sync/tasks/homework.task.ts:104-141`).
- `RosterPresenceService` was already written for multiple schools.
- `currentYearScope()` already returns `schoolYear: { in: number[] }`
  (`backend/src/common/school-year/school-year.scope.ts:31`).
- `persistRoster(data, semel, year)` (`mashov-session.service.ts:552`) is called from
  `loginWithCredentials`, which already holds the `connectionId` — stamping ownership is
  a parameter pass-through, not a new lookup.
- Credential validation against Mashov before persisting already exists in
  `ConnectionService.updateConnection` (`connection.service.ts:44-167`), including the
  `UPSTREAM_ERROR` vs `INVALID_CREDENTIALS` split.
- `AppUser.semel` is **read nowhere** in `backend/src` (only `auth.controller.ts` request
  bodies and `school-year.service.ts:162`, both the upstream school list). It can be
  redefined by comment with no migration.
- `/more/schools/new` already passes the gate in `frontend/src/lib/phase1-routes.ts`.
- `/inbox` already keeps its filter in a URL query param (`?filter=`, set with
  `router.replace`) — the precedent for where the school filter lives.
- `frontend/package.json` has **no test runner**; all frontend coverage is Playwright.

## The blockers

1. **Identity.** `AppUser.mashovUserId` is unique and set from the per-school
   `credential.userId` (`auth.service.ts:197,218`), so signing into school B creates a
   *second* `AppUser`, a second `AppSession`, and attaches B's connection to that new
   user. The 1:N relation is structurally present but unreachable through sign-in.
2. **No school discriminator on data**: `Student`, `MailConversation`, `MailMessage`,
   `NotificationEvent`, `BehaviorTypeReference`, `RecipientDirectory`, `ParentProfile`,
   `SchoolActivity` carry none.
3. **The mail unread sweep is gated off above one connection**
   (`backend/src/sync/tasks/mail-inbox.task.ts:83`): "N active connections share one
   unscoped mail table". Linking a second school today silently reintroduces the inflated
   badge fixed in `283c053` (production: 39 local vs 16 upstream, 23 stale orphans).
4. **Half the read paths bypass connections**, using the process-global env-credential
   session: `mail.service.ts:347` (conversation detail), `:607` (attachment),
   `:743,:773,:806` (markAsUnread / archive), and `children.service.ts:590-908` (lesson
   plans, releases, school activities, attachments). `getForConnection` is **GET-only** —
   there is no per-connection PUT, DELETE or raw-response path at all, which is *why*
   every mutation and attachment download still uses the env session.
5. **One year scopes every read.** `currentSchoolYearFor()` (`school-year.scope.ts:131`)
   picks one connection's `schoolYear`; two schools on different years hides one.
6. **`deleteConnection` wipes globally** (`connection.service.ts:195-230`):
   `mailConversation.deleteMany({})`, `notificationEvent.deleteMany({})`, child data for
   all active students — and it omits `studentRelease` and `schoolActivity` entirely
   (a pre-existing bug). There is also no session-cache eviction anywhere, so a deleted
   connection's upstream cookies live until process restart.
7. **Aggregates read one connection**: `cachedNewCount` and `getSchoolInfo()`
   (`dashboard.service.ts:97,:355`), `SettingsService.getProfile()`
   (`settings.service.ts:42`), `ensureStudentsAvailable()` (`mashov-session.service.ts:354`),
   and the `notifications` / `achvas` / `user-details` tasks.

## Key-collision audit (verified against the captured payloads in `apis/`)

Mashov numeric ids are per-school counters; UUIDs are global. Every unique constraint
checked against a real sample:

| Table | Key | Verdict |
|---|---|---|
| `MailConversation.conversationId`, `MailMessage.messageId` | UUID (`200be420-1691-…`) | **Safe** — and must stay `@unique`, since `MailMessage.conversation` is a relation onto it |
| `HomeworkItem`, `BehaviorItem`, `TimetableEntry`, `SubjectEnrollment`, `MessageBoardItem`, `StudentRelease` | per-school int, but key includes `studentGuid` | **Safe** — a child belongs to one school |
| `NotificationEvent.upstreamNotificationId @unique` | per-school counter | **COLLIDES** |
| `SchoolActivity @@unique([userId, schoolYear, activityId])` | `activityId` is `1` in the captured payload; `userId` is the merged household | **COLLIDES** — one school's consent request overwrites the other's |
| `BehaviorTypeReference.code @unique` | school-local taxonomy (`apis/get-api-achvas.md` carries `teacherId`, `commonBehaveId`); `achvas.task.ts:43`'s "global reference data" comment is wrong | **COLLIDES** — and `behavior-classifier.service.ts:36` then answers "is this absence justifiable?" from the wrong school |
| `ParentProfile.upstreamUserId @unique` | per-school user id → two rows | **Safe**, but `settings.service.ts:41` `findFirst()` picks one arbitrarily |
| `RecipientDirectory` | no unique key, no school column | **Mixes** both schools' directories (nothing writes it today) |

Silent wrong-data bugs that appear the moment a second school is linked and are invisible
on a single-school box. They are part of this work, not follow-ups.

## Design

### 1. Identity — connections on the existing `AppUser`, plus login adoption

`AppUser` **is** the household. One `AppUser`, N connections, `AppSession.userId` and
`request.user = { userId }` unchanged.

**Not a `Household` entity above `AppUser`:** `userId` is the app's universal scoping key
— `UserItemState.userId`, `DigestRecipient.userId`, every `*.service.ts` signature. Moving
the session subject rewrites the meaning of `userId` in every read/unread, archive and
digest path for a one-household deployment, and invalidates ADRs 0015/0019/0020. Option A
doesn't close that door: a later `Household` is a 1:1 backfill from this invariant.

Schema, additive:

| Model | Field | Why |
|---|---|---|
| `HouseholdConnection` | `linkedByUserId String?`, `linkedAt DateTime?` | audit: who asserted "this account is mine" |
| `HouseholdConnection` | `displayLabel String?` | optional parent-chosen label; `null` ⇒ derive |
| `AppUser` | `mergedIntoUserId String?` | set when a pre-existing AppUser for school B is absorbed |
| `AppUser` | `semel` | **keep, redefine by doc comment**: the origin school of the credential that created the row; never read for scoping |

**Adoption** in `AuthService.login`, after the Mashov response and before the
`appUser.upsert` at `auth.service.ts:218`:

1. Mashov has already validated `(semel, username, password)` — only then:
2. `conn = householdConnection.findUnique({ schoolCode, username })`. If `conn?.userId` is
   set, **that AppUser owns the session**: refresh the connection row and
   `createSession(conn.userId, ip)`; create no AppUser for `credential.userId`.
3. Else upsert as today; then if `appUser.mergedIntoUserId` is set, follow **one hop**,
   bailing to the original on a self/cyclic pointer.
4. `isFirstLogin` keeps its meaning — `false` on an adopted login, which is correct.

**First login of account B before it was ever linked** gets its own household. That is
correct and must stay: the app cannot know two Mashov accounts are one parent. Merging is
always initiated from inside an authenticated session.

**Merging two pre-existing households**, in one transaction: re-parent the connection
(`userId`, `linkedByUserId`, `linkedAt`); set `mergedIntoUserId` on the orphan; **revoke
every orphan `AppSession`** including the Redis `session:<token>` mirrors — otherwise a
live orphan session survives into a state where every page silently empties; re-point
`DigestRecipient`; copy non-conflicting `UserItemState` rows (skip conflicts — a few of
B's items re-appearing as "new" beats losing the current user's flags). Keep the orphan
`AppUser` row: `AppSession` and `UserItemState` reference it, and the pointer is the audit
trail.

Collisions: same `(semel, username)` already active → `409 CONNECTION_ALREADY_LINKED`.
Same `semel`, different username (mother's and father's accounts at one school) →
**reject**, `409 SCHOOL_ALREADY_LINKED`; the schema permits it but it duplicates children
and breaks the one-chip-per-school model. Cap at **4** active connections →
`409 LIMIT_REACHED`, bounding the sync fan-out against a rate-limited upstream.

**Trust model.** Adoption can't be reached without the school's password. The residual
exposure is the reverse: once B is linked into household X, B's legitimate owner signing
in later lands in X. Mitigations: the audit fields; the school list is permanently visible
on `/more`; unlink sets `conn.userId = null` and clears `mergedIntoUserId`, so a later B
login re-forms its own household; `MASHOV_ENABLE_SCHOOL_LINK_ADOPTION` kill switch; and
**ADR 0028** records the decision.

### 2. Schema — the ownership discriminator

`householdConnectionId String?`, matching the existing `SyncRun.householdConnectionId`.
**Permanently nullable, not transitional**: the shared-session (env) path legitimately
writes unowned rows, NULL means "ownership unknown, re-stamp on next roster refresh", and
a required column makes `prisma db push` on populated production tables impossible.
Relations use `onDelete: SetNull` so a raw connection delete can never silently cascade
away a child's history — §7's scoped delete does that work explicitly.

Push-safe (additive nullable columns + indexes): `student`
(`@@index([householdConnectionId, isActive])`), `mail_conversation`
(`@@index([householdConnectionId, isUnread])`, `([householdConnectionId, sendTime])`),
`mail_message`, `notification_event`, `school_activity`, `parent_profile`.

Two deliberate shape choices:

- **`mail_message` gets its own column** rather than inheriting through the conversation
  relation. Prisma can express the join, but the denormalised column buys a join-free
  `deleteMany` in §7, a direct connection resolve from a `messageId` for attachment
  download (`mail.service.ts:230`), and symmetry with the conversation row the same upsert
  loop already writes. Cost: one `TEXT` per message, written by code already in the loop.
- **`behavior_type_reference` is keyed by `schoolCode Int @default(0)`, not
  `householdConnectionId`** — it is school-level reference data, and two accounts at the
  same school must not duplicate it.

Needs numbered migration dirs (destructive index work):
`backend/prisma/migrations/20261120000000_connection_scoping/` (columns + backfill) and
`20261120010000_connection_unique_keys/`.

- `notification_event`: drop `…_upstreamNotificationId_key`, add
  `@@unique([householdConnectionId, upstreamNotificationId])`. Leave `fingerprint @unique`
  alone and instead **fold the connection id into the hash input** at
  `notifications.task.ts:121` — no index churn; legacy ID-less rows get re-created once,
  and nothing reads them.
- `school_activity`: → `@@unique([userId, householdConnectionId, schoolYear, activityId])`.
- `behavior_type_reference`: → `@@unique([schoolCode, code])`.
- `household_connection`: **add `@@unique([schoolCode, username])`.** The code already
  treats this as the identity key (`auth.service.ts:99`), and without the constraint
  adoption is racy. Not push-safe: migration `20261117000000_school_year_scoping`
  *deactivated* rather than deleted duplicates, so those rows still exist and would
  violate the index. The migration must, in order: re-point `sync_run.householdConnectionId`
  from each stale row to its keeper (there is no FK on that column, so they are danglers,
  but re-pointing keeps the history readable), delete the stale rows, then create the
  index. A **full** unique index, not a partial `WHERE active` one — Prisma can't express
  partial indexes, so `prisma db push` would drop it. The payoff: `auth.service.ts:236-272`
  collapses from find-then-branch into one `upsert`, which is what lets the login path
  capture the connection id it currently discards.

**Backfill**, in the first migration, guarded to refuse rather than guess, idempotent:

```sql
ALTER TABLE "student" ADD COLUMN IF NOT EXISTS "householdConnectionId" TEXT;
-- …same for mail_conversation, mail_message, notification_event,
--    school_activity, parent_profile; behavior_type_reference gets schoolCode INT
DO $$
DECLARE keeper_id TEXT; keeper_semel INTEGER; active_count INTEGER;
BEGIN
  SELECT count(*) INTO active_count FROM "household_connection" WHERE "active";
  IF active_count <> 1 THEN
    RAISE NOTICE 'Skipping ownership backfill: % active connections (expected 1)', active_count;
    RETURN;
  END IF;
  SELECT id, "schoolCode" INTO keeper_id, keeper_semel
    FROM "household_connection" WHERE "active" LIMIT 1;
  UPDATE "student" SET "householdConnectionId" = keeper_id WHERE "householdConnectionId" IS NULL;
  -- …repeat per table
  UPDATE "behavior_type_reference" SET "schoolCode" = keeper_semel WHERE "schoolCode" = 0;
END $$;
```

Inherited constraint: prior columns shipped via `prisma db push` (see `283c053`), so the
migration history may not replay cleanly. Use `IF NOT EXISTS` / `IF EXISTS` throughout as
`20261117000000` already does, and `prisma migrate resolve --applied` if needed.

### 3. Ownership resolution

New `backend/src/common/connection-scope/` with `ConnectionScopeService` +
`connection-scope.module.ts`, imported by `MailModule`, `ChildrenModule`, `SyncModule`,
`DashboardModule`, `SettingsModule`. Depends on `PrismaService` and `EncryptionService`
only — deliberately **not** on `MashovHttpClient`, so the transport stays schema-unaware.

```ts
interface ConnectionTarget {   // everything the transport needs, in one object
  id: string; schoolCode: number; schoolYear: number;
  username: string; password: string;   // decrypted here, never stored
  schoolName: string | null;
}
listTargets(userId?): Promise<ConnectionTarget[]>
targetFor(connectionId): Promise<ConnectionTarget>
targetForStudent(studentGuid): Promise<ConnectionTarget>
targetForConversation(conversationId) / targetForMessage(messageId)
groupConversationsByConnection(ids): Promise<Map<string, string[]>>
studentGuidsForUser(userId): Promise<string[]>
stampStudent(studentGuid, connectionId): Promise<void>
```

`targetForStudent` reads the stamp; on NULL it falls back to
`findFirst({ active: true }, orderBy lastLoginAt desc)` and logs at debug. No in-process
cache in the first cut — one indexed lookup per request is cheaper than a staleness bug.

**Stamping writers.** `persistRoster` gains a 4th arg `connectionId: string | null`; call
sites are `mashov-session.service.ts:208` (shared env login → `null`) and `:920`
(per-connection, id already in scope). Set `householdConnectionId` **only when non-null** —
a shared-session login must not blank an existing stamp — and log at `warn` when an
existing stamp changes, because that is a child who moved school and it is the only trace
of it. Scope that function's `inactiveChildren` sweep (`:612`) to
`{ OR: [{ householdConnectionId: connectionId }, { householdConnectionId: null }] }`. Also
stamp in: `auth.service.ts:285` (the login student upsert), both `mail-inbox.task.ts` walk
loops' **`create` and `update`** branches (the `update` branch is what makes the system
self-heal if the backfill never ran), `mail.service.ts:370`
`persistUpstreamConversationDetail`, and the `notifications` / `user-details` /
`school-activities` tasks' per-connection loops.

### 4. Read-path routing

Refactor the body of `getForConnection` (`mashov-http.client.ts:44`) into a private
`requestForConnection(method, url, data, target, config, isRetry)`, preserving the 401/403/
timeout single-retry and the deliberate non-matching of `axios.isCancel` (ADR-0023). Then
expose, alongside the **unchanged positional `getForConnection`** so the ~16 sync tasks
need no edit in this step:

```ts
getForTarget<T>(url, target, config?)
getResponseForTarget<T>(url, target, config?)   // arraybuffer attachment downloads
putForTarget<T>(url, data, target, config?)
deleteForTarget<T>(url, target, config?)
```

Do **not** add `getForStudent(url, studentGuid)` to the HTTP client — that drags Prisma
and the `Student` schema into the transport layer. `ConnectionTarget` gives the same
ergonomics: `getForTarget(url, await this.scope.targetForStudent(guid), { headers })`.

Convert, all resolving via `targetForStudent`: `children.service.ts:590` (`getLessonPlans`),
`:606` (`getLessonHistory`), `:621` (`getStudentReleases`), `:631` (`getSchoolActivities` —
the endpoint is household-scoped, but routing it through *that child's* school is exactly
right), `:641`/`:651` (`putForTarget`), `:660` (`deleteForTarget`), `:908`
(`getResponseForTarget`, threading a `target` param through `tryDownloadCandidates` at
`:881` from `:323`/`:358`).

In `mail.service.ts`: `:347` takes a `target` resolved once by `getConversationDetail`
(`:160`); `:607` threads `target` through `tryDownloadCandidates` (`:575`) from `:230`.
`markUnread` (`:743`), `archive` (`:773`) and `unarchive` (`:806`) change **semantically** —
an id list can span schools, so `groupConversationsByConnection` then one call per
connection with its own subset; per-connection failure stays warn-and-continue; in
`unarchive`, `markedUnreadUpstream` becomes per-connection and the local `updateMany` is
applied per subset so one school's failed call can't suppress the other's confirmed unread.
`:89` `cachedNewCount` → `aggregate({ _sum })` over the user's active connections; `:847`
`updateCachedNewCount(connectionIds[])` recomputes and writes per row; `:126`/`:457`
`getConversations`/`buildInboxWhere` accept an optional connection filter and
`include: { connection: { select: { schoolName: true, schoolCode: true } } }`.

**Fate of the env session: keep, demote, fence.** `MashovHttpClient.get/put/delete` and
`getAuthHeaders()` stay — they are load-bearing for boot, for `ensureStudentsAvailable`,
and for every task's `useSharedSession` branch, which is the only path on a fresh deploy
and in the integration tests. But no user-facing read service may touch them after this
step. Fence it with a unit test that injects a mock whose `get` throws and asserts
`MailService` and `ChildrenService` never call it, plus a comment at
`mashov-http.client.ts:20`. Full removal is a separate ticket gated on dropping
`MASHOV_SEMEL`/`USERNAME`/`PASSWORD` from `ops/`.

### 5. Sync tasks

**(a) Per-student fan-out → owner-first.** New `backend/src/sync/connection-fanout.ts`
with `orderConnectionsForStudent(student, connections)` and
`stampOwnershipIfChanged(prisma, student, conn, logger)`. Replace the loop *ordering* in
`homework.task.ts:104-141` and its clones (`behavior`, `timetable`, `groups`,
`message-board`, `releases`, `lessons-count`, `daily-behave`, `out-behave`,
`school-activities`, `history-backfill`). **Keep the loop structure** — only the order
changes, and a success on a non-owner re-stamps. An unstamped row behaves exactly as
today; a stamped row costs one upstream call instead of N.

This is a prerequisite, not an optimisation: without it, school B means one
guaranteed-403 call per student per run before the right one, across 10 tasks — plausible
Mashov rate-limit territory. Side benefit: `schoolYear = connYear` (`homework.task.ts:117`)
then stamps the *owner's* year, which is half of §6.

**(b) The `findFirst` per-household tasks.**

| Task | Verdict | Change |
|---|---|---|
| `notifications.task.ts` | per-account | convert to the `for (const conn of connectionList)` shape used by `mail-inbox.task.ts:84`; `source = 'notifications:' + conn.id`; stamp; fold `conn.id` into the fingerprint hash; move the `:94` upsert to the composite key |
| `user-details.task.ts` | per-account | per-connection loop; stamp `parent_profile`; two rows is the correct steady state |
| `achvas.task.ts` | **per-school, not global** | one run per distinct `schoolCode`; write `(schoolCode, code)`; `BehaviorClassifierService.isJustifiable(achvaCode)` → `isJustifiable(schoolCode, achvaCode)` (`behavior-classifier.service.ts:34`), caller in `behavior.task.ts` passing the school it fetched from (~30 lines) |
| `school-activities.task.ts` | already loops, but keys on `userId` alone (`:126`) | add `householdConnectionId` to the key and the `where` |
| `mail-counts.task.ts` | already loops | **`localUnreadCount` (~:115) must gain `householdConnectionId`** — without it each connection writes the *union* count into its own `cachedNewCount` and the summed badge doubles |

**(c) Re-enabling the mail sweep** — the highest-risk item, so precisely:

1. **`sweepSkipReason` (`:71-83`):** delete the `activeConnectionCount > 1` clause, the
   field, the count query (`:113-120`) and its comment. The four surviving gates —
   `failedCount > 0`, `pageCount === 0`, `pageCount >= maxPages`,
   `archivePageCount >= maxPages` — are already per-iteration locals, so they are already
   per connection. **`pageCount === 0` stays**: a 2xx empty walk is still
   indistinguishable from a referer-gated or expired session, and that gate is the
   production-incident guard.
2. **Two narrower gates replace it:**
   `conn === null && count({ householdConnectionId: { not: null } }) > 0` → skip,
   `'shared-session run on a connection-scoped mail table'`; and
   `conn !== null && count({ householdConnectionId: null }) > 0` → skip,
   `'unstamped mail rows present'`. The second is belt-and-braces against a backfill that
   never ran; it clears itself within one cycle because the upsert `update` branches
   re-stamp. One indexed `COUNT` each — keep both permanently.
3. **The sweep `updateMany` (~:393):**
   `{ householdConnectionId: conn ? conn.id : null, isUnread: true,
      lastFetchedAt: { lt: runStartedAt }, locallyMarkedUnreadAt: null }`.
   `lastFetchedAt < runStartedAt` is now safe *because the row sets are disjoint* — that is
   the whole point of the column. Every invariant the commit messages describe survives.
4. **`cachedNewCount` refresh (~:403):** scope to `householdConnectionId: conn.id`, drop
   the `findFirst({ active: true })` fallback except for `conn === null`.
5. **`describeDrift` (`mail-counts.task.ts:85-125`):** the exact-source match stays — it
   is the fix from `283c053` and load-bearing. The three counts inside (`archived`,
   `orphans`, `locallyOverridden`) each gain `householdConnectionId`. `upstreamCount` is
   already per connection. The `'success'`-never-`'partial'` decision stays.
6. `mail.service.updateCachedNewCount` (`:839`) becomes per-connection **in the same PR**,
   or a user action and the 7-minute cron fight over one number.
7. Ship behind `MAIL_SWEEP_ENABLED` (default `true`), documented in `ops/`, so a bad badge
   is one env var away from frozen rather than a rollback.

### 6. School-year scoping across two schools

Add to `school-year.scope.ts`, leaving `currentYearScope`, `schoolYearScope`,
`historyScope`, `schoolYearWindowFor`, `historyStartYear` **unchanged** (already correct
wherever a single student is known, so `school-year.scope.spec.ts` stays green):

```ts
schoolYearByConnection(prisma, userId?): Promise<Map<string, number>>
currentSchoolYearForStudent(prisma, studentGuid): Promise<number>
schoolYearWindowsFor(prisma, config, userId?): Promise<Map<string, SchoolYearWindow>>
yearScopeForStudents(prisma, userId?) / historyScopeForStudents(prisma, config, userId?)
```

The multi-school fragment is an **OR of (student-set, year) pairs** — the only honest shape
for student-keyed tables:

```ts
{ OR: [ { schoolYear: UNSCOPED_SCHOOL_YEAR },
        ...connections.map(c => ({ studentGuid: { in: guidsOwnedBy(c) }, schoolYear: c.schoolYear })) ] }
```

Cross-child readers switch to the new helpers (`children.service.ts:61`,
`dashboard.service.ts`'s threaded `yearScope`, the feed service); per-child endpoints pass
that child's year via `currentSchoolYearForStudent` (`children.service.ts:127,200,269,536,564,673`
and the digest). `freshness.service.ts:112` computes per connection and reports the worst
state — otherwise a second school with no data yet reads as a frozen year for the whole
household.

**Sync status/refresh.** The magic `TOTAL_SYNC_SOURCES = 16` stops meaning anything once
source names carry `:<connId>` and `:<studentGuid>` suffixes. Replace with
`SYNC_SOURCE_COUNT` exported from `sync.service.ts` and derived from the task list length,
plus a `normaliseSource(s)` that strips a `history:` prefix and any `:<suffix>`. Per
connection: `sourcesTotal = SYNC_SOURCE_COUNT * connections.length`,
`done = connections.every(...)`, plus a per-connection breakdown so the UI can say which
school is still syncing. `POST /sync/refresh` resolves all of the user's active connections
and calls `refreshAll({ connectionId })` **sequentially** (concurrency 1 — two simultaneous
Mashov logins from one household is asking for trouble); `refreshAll`'s dedupe key
(`sync.service.ts:50`) already keys on `connectionId`, so that is correct as-is.
`students.task.ts:92` deliberately skips the roster-presence sweep on connection-scoped
runs — that stays: a manual refresh is not whole-roster evidence. Both endpoints accept an
optional `schoolId`, 404 on a foreign id, aggregate when absent.

### 7. Scoped unlink

Rewrite `connection.service.ts:169-236` as `deleteConnection(userId, connectionId?)`.

- `studentGuids = student.findMany({ where: { householdConnectionId } })` — **not**
  `{ isActive: true }`, the current global bug. Include NULL-stamped students **only** when
  this is the user's last connection.
- Scoped deletes in FK order inside the existing `$transaction`: `mailMessage` **before**
  `mailConversation` (the relation is on `conversationId`); `notificationEvent`,
  `schoolActivity`, `parentProfile` by `householdConnectionId`; `homeworkItem`,
  `behaviorItem`, `messageBoardItem`, `timetableEntry`, `subjectEnrollment` and
  **`studentRelease`** by `studentGuid in studentGuids` (`studentRelease` and
  `schoolActivity` are missing from the current transaction entirely — fix here);
  `behaviorTypeReference` by `schoolCode` only if no other active connection shares it;
  `syncRun` by `householdConnectionId`; then **`student.deleteMany`** — new, because today
  the rows survive as orphans with `isActive: true` and the *other* school's per-student
  crons then 403 on every one of them every 12 minutes; then the connection.
- **Session-cache eviction**, currently missing entirely: add
  `MashovSessionService.invalidateConnection(connectionId)` deleting every
  `connectionSessions` / `lastLoginByConnection` / `lastRosterByConnection` entry whose key
  starts with `${connectionId}:` (key shape at `mashov-session.service.ts:99-103`).
- **`AppUser` and `AppSession` untouched.** Never revoke the session while a school
  remains — that signs a parent out of a household they still have. On the last
  connection, keep today's behaviour and let `getMe` return `schools: []` so the UI routes
  to the connect screen.
- `settings.service.ts:41` `getProfile` returns per-school profiles or accepts a
  connection id; `parentProfile.findFirst()` with two rows is a coin flip today.

### 8. API surface

Resource `school-links` (plural, kebab, noun, no verb, flat), per `.claude/rules/api.md`:

| Method | Path | Request | Response | Codes |
|---|---|---|---|---|
| GET | `/api/v1/school-links` | — | `{ data: SchoolLink[], pagination }` | 200, 401 |
| POST | `/api/v1/school-links` | `{ semel, username, password }` | `SchoolLink` | 201, 400, 401, 409, 422, 429, 502 |
| PUT | `/api/v1/school-links/:id` | `{ username?, password? }` | `SchoolLink` | 200, 400, 401, 404, 502 |
| DELETE | `/api/v1/school-links/:id` | — | — | 204, 401, 404 |
| DELETE | `/api/v1/school-links` | — | — | 204, 401 |

```ts
interface SchoolLink {
  id: string; semel: number; schoolName: string; shortLabel: string;
  schoolYear: number; username: string;          // never the password
  childrenCount: number; isPrimary: boolean;
  lastLoginAt: string | null; lastSyncAt: string | null;  // null ⇒ first sync unfinished
  active: boolean;
}
```

The list is paginated even though n ≤ 4 — `PaginatedResponse<T>` already exists in
`frontend/src/types/api.ts`, so conforming is free.

`shortLabel` comes from a new pure `backend/src/common/school-label.ts` →
`resolveSchoolLabels(connections)`: prefer `displayLabel`, else drop a trailing `" - …"`
segment and trim to ≤12 chars on a word boundary. **Resolved as a set** — if two
connections derive the same label, both fall back to the full `schoolName`. Server-side
only; deriving client-side would duplicate the collision rule in two languages.

`GET /auth/me` gains `schools: MeSchool[]` sorted by `lastLoginAt desc` (`[]` when none);
`connectedSchool` **stays for one release**, populated from `schools[0]`, marked
deprecated. That is what lets the backend ship ahead of the frontend and keeps all six
e2e `MOCK_ME` constants green untouched. Both `me.schools` and `GET /school-links` exist
because `me.schools` is the cheap read every page's badges need and `['me']` is already
fetched in `AppShell`, while `/school-links` carries the management-only fields; one
service method feeds both.

`PUT /connection` and `DELETE /connection` become **deprecated aliases** for one release
(`PUT → /school-links/:primaryId`, `DELETE → /school-links` collection), then the
controller is deleted in the cleanup step. `frontend/src/api/connection.ts` depends on the
latter and a hard break buys nothing.

Extract the validate-then-persist logic from `connection.service.ts:44-167` into
`backend/src/common/mashov-login/mashov-credential-validator.service.ts` exposing
`validate({ semel, year, username, password, uniqueId })`, preserving the
`isUpstreamUnreachable` → `UPSTREAM_ERROR` vs `INVALID_CREDENTIALS` split verbatim, and
have `auth.service.login`, `connection.service.updateConnection` and the new service all
call it — killing three copies of the `loginBody` literal and the `uniquId` cookie parsing.

**Rate-limit the link endpoint** (`.claude/rules/security.md`): it brute-forces upstream
credentials from an authenticated session. Key `ratelimit:school-link:<userId>`, 5 per
15 min, reusing the `checkRateLimit` shape at `auth.service.ts:78`.

Year resolution for the new school is independent: `resolveForSchool(semel)` plus the same
`reconcileFromLogin` one-retry dance as `login()` — it can legitimately differ from A's.

### 9. The linking flow

`/more` → "בתי ספר מחוברים" card → `settings-add-school-btn` → **route**
`/more/schools/new`, not a modal: real back-button behaviour on mobile, a shareable URL, a
simple page object, and no `phase1-routes.ts` change.

The request does **not** wait for a sync. On success the service persists the connection
plus the `children[]` upserts and `inactiveChildren` deactivation (the same code path as
`login()`), fires `syncService.refreshAll({ connectionId })` **without awaiting**, and
returns 201. The frontend invalidates (§11), then `router.replace('/auth/syncing?schoolId=<id>')`
— reusing `/auth/syncing` is right, the problem it solves is identical, with two changes to
`SyncingPageClient.tsx`: read `searchParams.get('schoolId')` and thread it into
`getSyncStatus`/`triggerSyncRefresh` with key `['sync-status', schoolId ?? 'all']`; and when
present, headline "מחברים את בית הספר…" with the skip button going to `/children`.

On `NO_CHILDREN_FOUND` / `NO_ACTIVE_CHILDREN` the connection is **not persisted** — a
childless connection shows up as a school with no children and a chip that matches
nothing, which a parent cannot diagnose.

| Code | HTTP | Hebrew |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | שם המשתמש או הסיסמה שגויים עבור בית הספר הזה |
| `UPSTREAM_ERROR` | 502 | לא הצלחנו להתחבר למשוב כרגע. נסו שוב בעוד כמה דקות |
| `SCHOOL_ALREADY_LINKED` | 409 | בית הספר הזה כבר מחובר לחשבון |
| `CONNECTION_ALREADY_LINKED` | 409 | החשבון הזה כבר מחובר |
| `NO_CHILDREN_FOUND` | 422 | לא נמצאו ילדים בחשבון הזה. בדקו שהזנתם את פרטי ההורה במשוב, ולא את פרטי התלמיד |
| `NO_ACTIVE_CHILDREN` | 422 | כל הילדים בחשבון הזה אינם פעילים בבית הספר |
| `LIMIT_REACHED` | 409 | ניתן לחבר עד 4 בתי ספר |
| `RATE_LIMITED` | 429 | יותר מדי ניסיונות. נסו שוב בעוד רבע שעה |
| fallback | — | אירעה שגיאה, נסו שוב מאוחר יותר |

### 10. Frontend

**Reuse.** Extract the autocomplete from `SignInPageClient.tsx:120-165` into
`frontend/src/components/auth/SchoolAutocomplete.tsx` with props
`{ value, onSelect, inputTestId, optionTestIdPrefix, disabledSemels?, disabledHint?, label? }`.
Keep `role="option"` on items so `tests/e2e/pages/AuthPage.ts:selectSchoolOption` keeps
working, **and** add `data-testid="school-option-{semel}"`. Already-linked schools render
disabled with "מחובר כבר" — preventing the error beats reporting it.

**`/more`** (`MorePageClient.tsx`): the single "בית ספר מחובר" card becomes a
`SchoolLinksCard` listing each school with year, `1 ילד` / `{n} ילדים`, "מסנכרן נתונים…"
while `lastSyncAt === null`, a per-row unlink, and an add row.

```
בתי ספר מחוברים
┌──────────────────────────────────────┐
│ 🏫  אורט רמון                         │
│     שנת לימודים 2026 · 2 ילדים        │
│                              ניתוק    │
├──────────────────────────────────────┤
│ 🏫  תיכון רמון                        │
│     שנת לימודים 2026 · 1 ילד          │
│     מסנכרן נתונים…           ניתוק    │
├──────────────────────────────────────┤
│ ＋  הוספת בית ספר                      │
└──────────────────────────────────────┘
```

Per-school confirm, blast radius explicit — today's "כל המידע יימחק" is now a lie:

> לנתק את "אורט רמון"? יימחקו כל הנתונים של 2 הילדים בבית הספר הזה — שיעורי בית,
> התנהגות, הודעות ודואר. הנתונים של "תיכון רמון" יישארו.

Last-school variant: *זה בית הספר היחיד המחובר. ניתוק שלו ימחק את כל המידע ויוציא אותך
מהחשבון.* → `queryClient.clear()` + `router.push('/auth/sign-in')`, today's behaviour.

The singular `settings-school-name` is **dropped** — it cannot honestly identify one of N,
and keeping a duplicate on the primary row is worse: two elements answering "which
school?". Testids: `settings-schools-card`, `settings-school-row-{semel}`,
`settings-school-name-{semel}`, `settings-school-children-count-{semel}`,
`settings-school-syncing-{semel}`, `settings-school-unlink-btn-{semel}`,
`settings-add-school-btn`, `settings-unlink-modal`, `settings-unlink-confirm-btn-{semel}`.
The bulk button keeps `settings-disconnect-btn` with count-aware copy
(`ניתוק מבית הספר` / `ניתוק מכל בתי הספר`).

**`SchoolBadge`** (`frontend/src/components/school/SchoolBadge.tsx`, new): wraps the
existing `Badge` with a `School` lucide icon, `title={schoolName}`,
`truncate max-w-[6rem]`. It calls `useMe()` itself and **returns `null` when
`me.schools.length < 2`** — self-hiding avoids prop-drilling a boolean through
`ChildrenPageClient → ChildCard`, `HomePageClient → ChildQuickCard` and
`InboxPageClient → ConversationItem`, and `['me']` is already cached. **Colour is not used
to distinguish schools**: the domain tokens `attention`/`positive`/`info` already carry
meaning and `.claude/rules/frontend.md` forbids colour-alone semantics. Icon + text,
neutral.

**`SchoolFilterChips`** (new): `role="group" aria-label="סינון לפי בית ספר"`, base `chip`
class from `globals.css:196`, `aria-pressed`, `overflow-x-auto scrollbar-hide` (long Mashov
names must not wrap a 360px row), and `null` below two schools.

**Filter state lives in a URL query param `?school=<semel>|all`**, per
`.claude/rules/frontend.md` ("query params for filterable/shareable state"), with
`?filter=` on `/inbox` as the in-repo precedent. Not context, not localStorage: a persisted
filter that silently hides one of a parent's children is the worst failure mode of this
feature, and a URL resets on a fresh visit, is back-button-able and visible in a support
screenshot. Keyed by `semel` (stable across unlink/re-link), set with `router.replace`. New
`frontend/src/lib/school-filter.ts` with `parseSchoolFilter` falling back to `'all'` on
anything unknown — **never** to an empty screen.

Filtering happens client-side over the already-fetched list first (instant, network-free,
works before server scoping); it moves into the hook and query key once the backend accepts
`?school=`. The component API is identical, so that is a hook-only change.

Filtered-empty is a **distinct** state from "no children at all", or the parent concludes
the school broke: *אין ילדים בבית הספר הזה* + a `school-filter-reset-btn` ("הצג הכל").

**Do not ship the `/home` chip row until feed items carry `schoolId`.** A chip that filters
the children rail but not the feed below it is worse than no chip. `/children` ships first.
And the chip row must never write to `localStorage['mashov.selectedChildGuid']`; the
auto-select effect at `HomePageClient.tsx:51-64` keeps operating on the **unfiltered**
list. The filter is render-only; child selection is a workspace concern.

**`ChildHeader.tsx:52-82`**: group the Radix `Select` by school with new `SelectGroup` /
`SelectLabel` wrappers in `frontend/src/components/ui/Select.tsx`, **only** when there is
more than one distinct school — with one school the markup is exactly today's flat list, so
`child-header-selector` and `children.spec.ts` are untouched. Add the school to the
subtitle (`child-header-school-label`) so the parent always knows whose school they are in.

**`/inbox`**: `SchoolBadge` on the conversation metadata line; the chip row above the
existing `all/new/archived` row, both params coexisting (`/inbox?filter=new&school=540175`).

**One school connected: every new surface renders `null` and the DOM is byte-identical to
today.** That gating rule (`schools.length >= 2 ⇒ render`) is the entire no-regression
story and why every single-school e2e spec stays green.

### 11. State and cache

New `['school-links']` (`staleTime: 60_000`, `/more` only); `['me']` same key, richer
payload; `['sync-status', schoolId ?? 'all']`. Once filtering is server-side:
`['children', { school }]`, `['dashboard', { school }]`, `['feed', { school }]`,
`['conversations', filter, { school }]` — object form so later facets don't reshuffle
positions, and existing prefix invalidations in `useMail.ts` keep matching.

**`useChild` keys must not gain a school segment** — a `studentGuid` is globally unique and
belongs to one school; adding school would only fragment the cache.

One shared `frontend/src/lib/query-invalidation.ts` →
`invalidateHouseholdScopedQueries(qc)` invalidating `me`, `school-links`, `children`,
`dashboard`, `feed`, `conversations`, `mail-summary`, `source-health`, `profile`,
`sync-status`, plus `removeQueries` by predicate for `child-*` (those keys carry no school,
so predicate removal is the only correct option, and it is cheap).

- **after link:** call it, then navigate to `/auth/syncing?schoolId=`. **Never**
  `queryClient.clear()` — that drops `['me']` and flashes the shell through its null state.
- **after unlink one:** capture the removed school's `studentGuid`s from the current
  `['children']` cache *before* invalidating; if `selectedChildGuid` is among them,
  `setSelectedChildGuid(null)`.
- **after unlink all:** `queryClient.clear()` + `/auth/sign-in`.
- `ChildWorkspacePage`'s error path needs a "חזרה לילדים" link for the mid-unlink 404 —
  verify it exists, add if not.

## Sequencing

**Prerequisite:** the tree is on `fix/sync-status-refresh-envelope` with uncommitted
changes. That branch's `POST /sync/refresh` (`sync.controller.ts:83`) and `GET /sync/status`
(`:121`) each resolve a *single* connection and `RefreshProgressService` is keyed by one
`connectionId`, so under two schools refresh would sync one school and the progress bar
report one school's work. Let it land, then branch off `master`; §6 extends it.

Steps 1-5 are behaviour-neutral in production (one connection ⇒ byte-identical). Steps 6
and 7 are each all-or-nothing.

| # | Content | Ships alone? |
|---|---|---|
| 1 | `*ForTarget` transport methods + `ConnectionTarget`. Pure addition. | yes |
| 2 | Both migration dirs (§2). No reader uses the columns yet. **Migration dirs, not `db push`** — push runs none of the backfill SQL and the four index swaps are destructive. | yes |
| 3 | Stamping writers + `ConnectionScopeService` (§3). | yes |
| 4 | Read-path routing in `children.service` / `mail.service` (§4) + the env-session fence test. Valuable alone: takes user-facing paths off the env session. | yes |
| 5 | Owner-first fan-out + the per-household task fixes (§5a, §5b). | yes |
| **6** | **Together:** sweep re-enable + per-connection `cachedNewCount` + `localCount` + `describeDrift` + `mail.service.updateCachedNewCount`. Any subset ⇒ a wrong badge. | no |
| **7** | **Together:** per-connection year scoping + call sites + `freshness` + sync status/refresh fan-out. Splitting puts reads and writes on different years — the exact bug class the `20261117` work fixed. | no |
| 8 | Household read scoping (`studentGuidsForUser` in `children.service.ts:53`, `dashboard.service.ts:102,:247`) + the `/children/:studentGuid` ownership guard → 404. **The isolation deliverable.** | yes |
| 9 | `me.schools[]`, `GET /school-links`, `useSchoolLinks`, `SchoolLinksCard` (list only, count-aware bulk disconnect, no add button, no per-school unlink). Renders one row, same information as today. | yes |
| 10 | `POST /school-links`, validator extraction, `SchoolAutocomplete` extraction, add-school screen, `?schoolId=` on sync, **and login adoption + `mergedIntoUserId` + `@@unique([schoolCode, username])`**. Adoption must be here: the moment a second school *can* be linked, a sign-in with B must not fork the household. | yes |
| 11 | `schoolId`/`schoolShortLabel` on children, dashboard children, feed and conversations; `SchoolBadge`; chips on `/children`, then `/home` + `/inbox` with the feed field; grouped `ChildHeader`. | yes (all gated on `>= 2`) |
| 12 | Scoped unlink (§7) + per-link `PUT` + the blast-radius confirms. **Cannot precede step 2** — today's unscoped deletes would wipe both schools. | yes |
| 13 | Link the second school for real, only once `SELECT count(*) FROM student WHERE "householdConnectionId" IS NULL` is 0 after a full cron cycle. | — |
| 14 | Cleanup: drop `connectedSchool` and `DashboardResponse.school`, delete `connection.controller.ts`, update the six `MOCK_ME`s, ADR 0028 + an ADR for per-connection scoping, contract table, and the PRD/architecture scope lines via the `/prd` skill (`.claude/rules/prd.md` — never edit `PRD-current.md` by hand). | — |

**Risks, ranked.** (1) The sweep — mitigated by the two narrower gates, the kept
`pageCount === 0` guard, and `MAIL_SWEEP_ENABLED`. (2) The backfill not running, given the
`db push` precedent — mitigated because every upsert's `update` branch re-stamps, so the
system self-heals within one cycle, and the transitional gate refuses to sweep until it
has. (3) `@@unique([schoolCode, username])` failing on the inactive duplicates from
`20261117` — mitigated by the collapse-then-index ordering. (4) Achva code collision
mislabelling `justifiable`. (5) Upstream call volume doubling if step 5 slips behind step
13. (6) `Student.studentGuid` is globally `@unique`, so **a child can belong to only one
linked school** — true in practice, but document the limitation in the ADR rather than
taking on a composite `studentGuid` key across six tables. (7) Two schools in different
years mid-rollover: `DashboardResponse.school` encodes the single-year assumption and is
deprecated with `connectedSchool`. (8) Adoption granting household access to whoever holds
either password — intentional, audited, reversible by unlink, kill-switched.

## Verification

Tests to add or change — `connection-scope.service.spec.ts`, `school-label.spec.ts`,
`school-links.service.spec.ts` (new); `mail-inbox.task.spec.ts` (**replace** the "skips the
sweep with N connections" case with: sweeps per connection touching only its own rows;
still skips on empty walk / page cap / item failure; skips on a shared-session run when
stamped rows exist; skips while unstamped rows exist); `mail-counts.task.spec.ts` (scoped
`localCount` and drift; two connections drift independently); `students.task.spec.ts`
(roster stamps; a shared-session login does not blank a stamp; a child moving school
re-stamps); `homework.task.spec.ts` (exactly one upstream call for a stamped student;
unstamped falls back; the year stamped is the owner's); `school-year.scope.spec.ts`
(two connections on different years; existing single-year cases unchanged);
`connection.service.spec.ts` (unlinking A leaves B intact; `studentRelease` and
`schoolActivity` now deleted; `AppUser` and session survive; A's session cache evicted);
`auth.service.spec.ts` (adoption; no adoption for an unlinked account; one-hop
`mergedIntoUserId`; cyclic pointer bails; kill-switch off ⇒ old behaviour);
`dashboard.service.spec.ts` (summed badge); `sync.controller.spec.ts` (`normaliseSource`;
`done` only when every connection is done); `notifications.task.spec.ts` (two connections
returning the same upstream id do not collide); plus the env-session fence test.

A new integration test under `tests/` (there is a `tsconfig.integration.json`) seeds two
connections, two students and two mailboxes, runs `refreshAll` for both, and asserts zero
cross-contamination in `student`, `mail_conversation`, `cachedNewCount` and the swept
unread set — the test that would have caught the original bug. Plus an isolation test:
household A cannot read household B's `studentGuid` (404).

E2E (`data-testid` only, page object model): new `tests/e2e/pages/MorePage.ts` and
`AddSchoolPage.ts`; `ChildrenPage`/`HomePage`/`InboxPage` gain `schoolFilterChip`,
`filterBySchool`, `schoolBadge`; new `school-links.spec.ts` (both rows listed; add-school
happy path → syncing → home; one test per error code asserting the exact Hebrew; linked
option disabled; unlink A with B remaining stays signed in; unlink the only school
redirects) and `school-filter.spec.ts` (chips **absent** with one school; present with two;
click writes `?school=`; deep-link applies; `?school=zzz` falls back to all; filtered-empty
plus working reset). `tests/e2e/auth.spec.ts:549` is **the only hard break** — swap
`settings-school-name` for `settings-schools-card` + `settings-school-name-{semel}`. Add
`schools: [one]` to the six `MOCK_ME` constants in the frontend commit.

End to end, against the real stack:

```bash
docker compose up --build
npm run lint && npm run typecheck
npm run test:unit && npm run test:integration && npm run test:e2e
```

Then in the running app, link the second school from `/more` and confirm:

- `/children` lists children from both schools, each with its school chip, and the chip row
  appears only now that there are two;
- the inbox badge equals the **sum** of both schools' Mashov `unreadConversations` — the
  metric `283c053` was measured on, so a regression shows here first;
- the mail task logs `swept=N` per connection rather than "sweep skipped";
- `SELECT count(*) FROM student WHERE "householdConnectionId" IS NULL` is 0, and
  `SELECT "householdConnectionId", count(*) FROM mail_conversation GROUP BY 1` shows both;
- a behaviour event at school B shows school B's Hebrew label and its own `justifiable`;
- `?school=<semel>` filters, deep-links, and an unknown value shows everything;
- unlinking school B leaves A's children, mail and read state intact, and does not sign out;
- signing out and back in with **either** school's credentials lands on the same merged
  household.
