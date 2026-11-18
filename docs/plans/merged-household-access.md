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

---

# Implementation tasks

Tasks 1–12 of the Sequencing table, expanded. Each task names the files, the
change, the tests, and the verification command. The design sections above (§1–§11)
are the authority for *why*; these sections are the authority for *what to type*.

Global constraints for every task:

- `cd backend && npx jest <pattern>` is the unit-test command. Full suite:
  `cd backend && npx jest`. Baseline at task 0: **52 suites, 747 tests, all passing.**
- `cd backend && npx tsc --noEmit` must stay clean; `npm --prefix backend run lint`
  must stay at zero warnings.
- Tasks 1–5 and 8–12 must be behaviour-neutral on a single-connection deployment.
  Where a test asserts today's single-connection behaviour, it must still pass
  unchanged unless this plan explicitly says to replace it.
- TDD: write the failing test first, watch it fail, then implement.
- One commit per task minimum, conventional-commit subject, trailer
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

Pre-flight rulings (made before task 1, see the ledger):

- **R1 — where `ConnectionTarget` lives.** §1 assigns it to task 1 (transport) and §3
  describes it inside `ConnectionScopeService`. It goes in
  `backend/src/session/connection-target.ts` and `ConnectionScopeService` imports it.
  The transport must not import from `connection-scope/`, which depends on Prisma.
- **R2 — which migration carries which column.** §2's step-2 row says "both migration
  dirs", but step 10 also claims `@@unique([schoolCode, username])`. All DDL lands in
  task 2: every additive nullable column (§1's `linkedByUserId`, `linkedAt`,
  `displayLabel`, `AppUser.mergedIntoUserId`, plus §2's `householdConnectionId`
  columns and `BehaviorTypeReference.schoolCode`) in `20261120000000_connection_scoping`,
  and every index swap including `household_connection`'s in
  `20261120010000_connection_unique_keys`. Task 10 ships code only.
- **R3 — `TOTAL_SYNC_SOURCES` is already gone.** Commit `ce66ee2` replaced the
  source-count completion guess with `RefreshProgressService` envelopes, so §6's
  `SYNC_SOURCE_COUNT` / `normaliseSource` instruction describes code that no longer
  exists. Task 7 instead aggregates one `RefreshEnvelope` per connection.

## Task 1: per-connection transport methods

**Files:** `backend/src/session/connection-target.ts` (new),
`backend/src/session/mashov-http.client.ts`.

1. New `connection-target.ts` exporting `ConnectionTarget` exactly as §3 declares it:
   `{ id, schoolCode, schoolYear, username, password, schoolName }`. No imports — a
   plain interface, so both the transport and `connection-scope/` can depend on it.
2. In `mashov-http.client.ts`, extract the body of `getForConnection` into a private
   `requestForConnection<T>(method, url, data, target, config, isRetry)` returning
   `Promise<AxiosResponse<T>>`. Preserve verbatim: the 401/403/timeout single retry with
   `getAuthHeadersForConnection(..., true)`, the `ECONNABORTED` / `includes('timeout')`
   test, the comment forbidding `axios.isCancel` (ADR-0023), and the thrown message
   shape. The message's method must now come from the `method` argument, not the literal
   `GET`.
3. `getForConnection` keeps its exact positional signature and delegates. The ~16 sync
   tasks must need no edit in this task.
4. Add `getForTarget<T>(url, target, config?)`, `getResponseForTarget<T>(url, target,
   config?)`, `putForTarget<T>(url, data, target, config?)`,
   `deleteForTarget<T>(url, target, config?)`.

**Tests** — new `backend/src/session/mashov-http.client.spec.ts`, with a stub
`MashovSessionService` and the axios instance replaced on the private field:

- `getForTarget` sends the connection's auth headers and merges `config.headers`.
- `putForTarget` sends the body; `deleteForTarget` sends no body.
- `getResponseForTarget` returns the whole `AxiosResponse` (so `responseType:
  'arraybuffer'` callers can read `headers`), while `getForTarget` returns `.data`.
- A 403 on a `putForTarget` refreshes the session once and retries, and a second 403
  throws naming `PUT`.
- A cancellation (`{ code: 'ERR_CANCELED' }`) is **not** retried.
- `getForConnection` still works through the positional signature.

**Expected:** new spec passes; `npx jest` still reports 747 + the new cases, 0 failures.

**Commit:** `feat(session): add per-connection PUT, DELETE and raw-response transport`

## Task 2: the ownership discriminator — schema and migrations

**Files:** `backend/prisma/schema.prisma`,
`backend/prisma/migrations/20261120000000_connection_scoping/migration.sql` (new),
`backend/prisma/migrations/20261120010000_connection_unique_keys/migration.sql` (new).

Schema edits (see §2 and R2):

- `Student`, `MailConversation`, `MailMessage`, `NotificationEvent`, `SchoolActivity`,
  `ParentProfile`: add `householdConnectionId String?`. Add a `connection
  HouseholdConnection? @relation(fields: [householdConnectionId], references: [id],
  onDelete: SetNull)` with the back-relation named per model on `HouseholdConnection`.
- Indexes: `student @@index([householdConnectionId, isActive])`;
  `mail_conversation @@index([householdConnectionId, isUnread])` and
  `@@index([householdConnectionId, sendTime])`; `mail_message`,
  `notification_event`, `school_activity`, `parent_profile` each
  `@@index([householdConnectionId])`.
- `BehaviorTypeReference`: add `schoolCode Int @default(0)`; drop `code @unique`; add
  `@@unique([schoolCode, code])`.
- `NotificationEvent`: drop `upstreamNotificationId @unique`; add
  `@@unique([householdConnectionId, upstreamNotificationId])`. Leave `fingerprint
  @unique` alone.
- `SchoolActivity`: `@@unique([userId, schoolYear, activityId])` →
  `@@unique([userId, householdConnectionId, schoolYear, activityId])`.
- `HouseholdConnection`: add `linkedByUserId String?`, `linkedAt DateTime?`,
  `displayLabel String?`, and `@@unique([schoolCode, username])`.
- `AppUser`: add `mergedIntoUserId String?`. Replace the bare `semel Int` with the
  doc comment §1 requires: the origin school of the credential that created the row,
  never read for scoping.

`20261120000000_connection_scoping/migration.sql`: `ADD COLUMN IF NOT EXISTS` for every
column above, `CREATE INDEX IF NOT EXISTS` for every index, then the guarded `DO $$`
backfill from §2 verbatim in shape — refuse (RAISE NOTICE + RETURN) unless exactly one
`household_connection` row is `active`, then stamp every NULL in `student`,
`mail_conversation`, `mail_message`, `notification_event`, `school_activity`,
`parent_profile` with that connection's id and `behavior_type_reference.schoolCode = 0`
with its `schoolCode`. Idempotent: re-running changes nothing.

`20261120010000_connection_unique_keys/migration.sql`, in this order:

1. `UPDATE "sync_run" SET "householdConnectionId" = <keeper>` for each
   `(schoolCode, username)` group with more than one row, keeper = the `active` row if
   exactly one is active, else the newest `updatedAt`.
2. `DELETE FROM "household_connection"` for the non-keepers of those groups.
3. `DROP INDEX IF EXISTS "notification_event_upstreamNotificationId_key"`,
   `"behavior_type_reference_code_key"`, `"school_activity_userId_schoolYear_activityId_key"`.
4. `CREATE UNIQUE INDEX IF NOT EXISTS` for the four new composite keys and
   `household_connection_schoolCode_username_key`. A **full** index, not partial.

Use `IF NOT EXISTS` / `IF EXISTS` throughout; the history may not replay cleanly
because earlier columns shipped via `prisma db push` (see `283c053`).

**Tests** — new `backend/test/unit/connection-scoping-migration.spec.ts`, reading the
two `.sql` files as text (the pattern `boot-migrations.spec.ts` already uses):

- every `ALTER TABLE ... ADD COLUMN` in the first migration carries `IF NOT EXISTS`;
- the backfill is wrapped in a guard that returns unless exactly one connection is
  active, and names all six tables plus `behavior_type_reference`;
- in the second migration, the `sync_run` re-point appears before the
  `household_connection` delete, which appears before
  `CREATE UNIQUE INDEX ... household_connection`;
- no `CREATE UNIQUE INDEX` in either file carries a `WHERE` clause.

Then `npx prisma generate` and `npx tsc --noEmit`: the generated client must compile.

**Expected:** new spec passes; `npx prisma validate` clean; `npx tsc --noEmit` clean;
full suite still green (no reader uses the columns yet).

**Commit:** `feat(db): stamp household ownership on every per-school table`

## Task 3: `ConnectionScopeService` and the stamping writers

**Files:** `backend/src/common/connection-scope/connection-scope.service.ts`,
`connection-scope.module.ts` (new); `backend/src/session/mashov-session.service.ts`;
`backend/src/auth/auth.service.ts`.

1. `ConnectionScopeService`, depending on `PrismaService` and `EncryptionService` only,
   with exactly the surface §3 lists: `listTargets(userId?)`, `targetFor(connectionId)`,
   `targetForStudent(studentGuid)`, `targetForConversation(conversationId)`,
   `targetForMessage(messageId)`, `groupConversationsByConnection(ids)`,
   `studentGuidsForUser(userId)`, `stampStudent(studentGuid, connectionId)`.
   `targetForStudent` reads the stamp and, on NULL, falls back to
   `findFirst({ active: true }, orderBy: { lastLoginAt: 'desc' })`, logging at debug.
   `targetFor` on an unknown or inactive id throws. No in-process cache.
2. `persistRoster(data, semel, year, connectionId: string | null)` — a 4th parameter.
   Set `householdConnectionId` in the upsert's `create` and `update` **only when
   non-null**; when an existing non-null stamp differs from `connectionId`, log at
   `warn` (a child who moved school). Scope the `inactiveChildren` `updateMany` to
   `{ OR: [{ householdConnectionId: connectionId }, { householdConnectionId: null }] }`
   when `connectionId` is non-null.
3. Call sites: the shared-env login passes `null`; `loginWithCredentials` passes
   `connectionId ?? null`.
4. `auth.service.ts`'s login student upsert stamps the connection it just wrote.
   Capture the connection id from the update/create branches so the stamp is available.

**Tests** — new `backend/src/common/connection-scope/connection-scope.service.spec.ts`:

- `targetForStudent` returns the stamped connection's target with the password
  decrypted;
- an unstamped student falls back to the most recently used active connection;
- `targetForStudent` for a student whose stamped connection is gone falls back rather
  than throwing;
- `groupConversationsByConnection` splits a mixed id list into one entry per
  connection and drops ids with no row;
- `studentGuidsForUser` returns only that user's connections' students;
- `listTargets(userId)` excludes inactive connections and other users'.

Extend `backend/src/sync/tasks/students.task.spec.ts` (or a new
`mashov-session.roster.spec.ts` if `persistRoster` is not reachable from there) with:
roster persistence stamps the connection; a `null` connectionId does **not** blank an
existing stamp; a child appearing under a different connection re-stamps and warns.

**Expected:** new specs pass; full suite green.

**Commit:** `feat(sync): resolve and stamp per-connection ownership`

## Task 4: route the read paths through connections

**Files:** `backend/src/children/children.service.ts`, `backend/src/mail/mail.service.ts`,
their modules, and a new fence spec.

Per §4, convert every listed call site to `*ForTarget`, resolving through
`ConnectionScopeService`:

- `children.service.ts`: `getLessonPlans`, `getLessonHistory`, `getStudentReleases`,
  `getSchoolActivities` (via that child's school), the two `putForTarget` sites, the
  `deleteForTarget` site, and the attachment download — threading a `target` parameter
  through `tryDownloadCandidates` from both of its callers.
- `mail.service.ts`: `getConversationDetail` resolves a target once and passes it to
  `persistUpstreamConversationDetail`; the attachment path threads `target` through its
  `tryDownloadCandidates`. **`markUnread`, `archive` and `unarchive` change semantically**
  — `groupConversationsByConnection`, then one upstream call per connection with its own
  subset, per-connection failure staying warn-and-continue, and in `unarchive`
  `markedUnreadUpstream` and the local `updateMany` applied **per subset**.

`MailModule` and `ChildrenModule` import `ConnectionScopeModule`.

**Tests:**

- New `backend/src/session/env-session-fence.spec.ts`: construct `MailService` and
  `ChildrenService` with a `MashovHttpClient` mock whose `get`, `getResponse`, `put`
  and `delete` all throw `new Error('env session is fenced off')`, exercise each
  converted method, and assert none of the four was called.
- `mail.service.spec.ts`: `archive` over ids spanning two connections issues one
  upstream call per connection with only that connection's ids; a failure on one
  connection still archives the other's locally; `unarchive`'s confirmed-unread write
  is scoped to the connection whose call succeeded.
- `children.service.spec.ts`: each converted read resolves the target from the child's
  own stamp.

**Expected:** fence spec fails before the conversion (proving the env session was in
use) and passes after; full suite green.

**Commit:** `refactor(reads): take user-facing reads off the shared env session`

## Task 5: owner-first fan-out and the per-household tasks

**Files:** `backend/src/sync/connection-fanout.ts` (new); the per-student tasks;
`notifications.task.ts`, `user-details.task.ts`, `achvas.task.ts`,
`school-activities.task.ts`, `mail-counts.task.ts`;
`backend/src/sync/behavior-classifier.service.ts`.

1. `connection-fanout.ts` exporting `orderConnectionsForStudent(student, connections)`
   (the stamped owner first, the rest in their existing order) and
   `stampOwnershipIfChanged(prisma, student, conn, logger)`.
2. Apply the ordering — **not a new loop shape** — in `homework.task.ts` and its clones
   (`behavior`, `timetable`, `groups`, `message-board`, `releases`, `lessons-count`,
   `daily-behave`, `out-behave`, `school-activities`, `history-backfill`), and re-stamp
   on a success from a non-owner.
3. §5b, one row at a time:
   - `notifications.task.ts` → per-connection loop in `mail-inbox.task.ts`'s shape,
     `source = 'notifications:' + conn.id`, stamp the rows, fold `conn.id` into the
     fingerprint hash input, and move the upsert to the composite key.
   - `user-details.task.ts` → per-connection loop, stamping `parent_profile`.
   - `achvas.task.ts` → one run per distinct `schoolCode`, writing `(schoolCode, code)`;
     `BehaviorClassifierService.isJustifiable(achvaCode)` becomes
     `isJustifiable(schoolCode, achvaCode)` and `behavior.task.ts` passes the school it
     fetched from.
   - `school-activities.task.ts` → add `householdConnectionId` to the upsert key and
     its `where`.
   - `mail-counts.task.ts` → `localUnreadCount` gains `householdConnectionId`.

**Tests:**

- New `backend/src/sync/connection-fanout.spec.ts`: a stamped student orders its owner
  first; an unstamped student preserves the input order; `stampOwnershipIfChanged`
  writes only on a change.
- `homework.task.spec.ts`: exactly one upstream call for a stamped student; an
  unstamped student falls back across connections as today; the `schoolYear` written is
  the **owner's** year.
- `notifications.task.spec.ts`: two connections returning the same
  `upstreamNotificationId` produce two rows, not a collision; the fingerprints differ.
- New `achvas.task.spec.ts`: two schools' identical `code` produce two rows;
  `isJustifiable` answers per school.
- `mail-counts.task.spec.ts`: each connection's `localCount` counts only its own rows.

**Expected:** new and changed specs pass; full suite green.

**Commit:** `fix(sync): fan out per-student work owner-first and scope per-household tasks`

## Task 6: re-enable the mail sweep, per connection (all-or-nothing)

**Files:** `backend/src/sync/tasks/mail-inbox.task.ts`,
`backend/src/sync/tasks/mail-counts.task.ts`, `backend/src/mail/mail.service.ts`,
`ops/` docs.

Exactly §5c, all in this one commit:

1. Delete the `activeConnectionCount > 1` clause from `sweepSkipReason`, the field, the
   `activeConnectionCount` count query and its comment. Keep `failedCount > 0`,
   `pageCount === 0`, `pageCount >= maxPages`, `archivePageCount >= maxPages`.
2. Add two narrower gates: a shared-session run (`conn === null`) skips when any
   `mail_conversation` has a non-null `householdConnectionId`; a connection-scoped run
   skips while any row has a NULL one. Both permanent.
3. Both walk loops stamp `householdConnectionId` in **`create` and `update`** on
   `mail_conversation` and `mail_message`.
4. The sweep `updateMany` gains `householdConnectionId: conn ? conn.id : null`.
5. The post-sweep `cachedNewCount` refresh scopes its count to
   `householdConnectionId: conn.id`, keeping the `findFirst` fallback only for
   `conn === null`.
6. `describeDrift`'s `archived`, `orphans` and `locallyOverridden` counts each gain
   `householdConnectionId`. The exact-source match and the `'success'`-never-`'partial'`
   decision stay.
7. `mail.service.updateCachedNewCount` becomes
   `updateCachedNewCount(connectionIds: string[])`, recomputing and writing per row;
   `cachedNewCount` reads become `aggregate({ _sum })` over the user's active
   connections.
8. Gate the sweep on `MAIL_SWEEP_ENABLED` (default `true`) and document it in `ops/`.

**Tests** — `mail-inbox.task.spec.ts`: **replace** the "skips the sweep with N
connections" case with

- sweeps per connection, touching only that connection's rows;
- still skips on an empty walk, the page cap, and an item failure;
- skips a shared-session run when stamped rows exist;
- skips a connection-scoped run while unstamped rows exist;
- `MAIL_SWEEP_ENABLED=false` skips with that reason.

`mail-counts.task.spec.ts`: scoped `localCount`; two connections drift independently.
`mail.service.spec.ts`: `cachedNewCount` is the sum across the user's connections.

**Expected:** the replaced spec file passes; full suite green.

**Commit:** `fix(mail): reconcile unread per connection instead of refusing to sweep`

## Task 7: per-connection school-year scoping and sync fan-out (all-or-nothing)

**Files:** `backend/src/common/school-year/school-year.scope.ts`,
`children.service.ts`, `dashboard.service.ts`, the feed service,
`freshness.service.ts`, `sync.controller.ts`, the digest.

1. Add to `school-year.scope.ts`, leaving every existing export untouched:
   `schoolYearByConnection`, `currentSchoolYearForStudent`, `schoolYearWindowsFor`,
   `yearScopeForStudents`, `historyScopeForStudents`. The multi-school fragment is the
   OR-of-(student-set, year)-pairs from §6.
2. Cross-child readers switch to the new helpers; per-child endpoints pass that child's
   year via `currentSchoolYearForStudent`.
3. `freshness.service.ts` computes per connection and reports the **worst** state.
4. Per **R3**, the sync work is envelope aggregation, not a source count:
   `POST /sync/refresh` resolves every active connection for the user and calls
   `refreshAll({ connectionId })` **sequentially**, concurrency 1; `GET /sync/status`
   reads one `RefreshEnvelope` per connection and aggregates — summed `tasksTotal`,
   `tasksSettled`, `tasksFailed`; `done` only when every connection's phase is
   terminal; a per-connection breakdown on the response. Both accept an optional
   `schoolId`, 404 on a foreign id, aggregate when absent.
   `students.task.ts`'s skip of the roster-presence sweep on connection-scoped runs
   stays.

**Tests:** `school-year.scope.spec.ts` gains two connections on different years, with
every existing single-year case unchanged. `sync.controller.spec.ts` (new if absent):
`done` is false while any connection is still running; `schoolId` for another user's
connection is a 404; no `schoolId` aggregates. `freshness.service.spec.ts`: a second
connection with no data reports the worst state, not a frozen year for the household.

**Expected:** all four spec files pass; full suite green.

**Commit:** `fix(scope): read each school at its own year and aggregate refresh per connection`

## Task 8: household read scoping — the isolation deliverable

**Files:** `children.service.ts`, `dashboard.service.ts`, `children.controller.ts`.

`ChildrenService.getChildren` and the two `dashboard.service.ts` read paths scope to
`ConnectionScopeService.studentGuidsForUser(userId)`. `GET /children/:studentGuid` and
every per-child endpoint under it return **404** for a guid outside the caller's
household — not 403, which would confirm the guid exists.

**Tests:** `children.service.spec.ts` — household A's `getChildren` excludes B's
children; A reading B's `studentGuid` throws `NotFoundException`; a user with no
connection gets an empty list, not every student. `dashboard.service.spec.ts` — the
summary counts only the caller's children.

**Expected:** these cases fail before the change and pass after; full suite green.

**Commit:** `fix(children): scope every read to the caller's household`

## Task 9: `me.schools[]`, `GET /school-links`, and the list UI

**Files:** `backend/src/common/school-label.ts` (new),
`backend/src/school-links/` (new module, service, controller),
`auth.service.ts` (`getMe`), `frontend/src/api/schoolLinks.ts`,
`frontend/src/hooks/useSchoolLinks.ts`,
`frontend/src/components/settings/SchoolLinksCard.tsx`, `MorePageClient.tsx`,
`frontend/src/types/api.ts`.

Backend: `resolveSchoolLabels(connections)` per §8, resolved as a set with the
full-name collision fallback. `GET /api/v1/school-links` returning
`{ data: SchoolLink[], pagination }` with the `SchoolLink` shape from §8 and **never**
the password. `getMe` gains `schools: MeSchool[]` sorted by `lastLoginAt desc`, `[]`
when none; `connectedSchool` stays, populated from `schools[0]`, marked deprecated. One
service method feeds both.

Frontend: `useSchoolLinks` on key `['school-links']`, `staleTime: 60_000`.
`SchoolLinksCard` — **list only** in this task: one row per school with year and
`1 ילד` / `{n} ילדים`, "מסנכרן נתונים…" while `lastSyncAt === null`, the count-aware
bulk disconnect (`ניתוק מבית הספר` / `ניתוק מכל בתי הספר`) keeping
`settings-disconnect-btn`. No add button, no per-school unlink — those are tasks 10
and 12. Testids `settings-schools-card`, `settings-school-row-{semel}`,
`settings-school-name-{semel}`, `settings-school-children-count-{semel}`,
`settings-school-syncing-{semel}`. Drop the singular `settings-school-name`.

**Tests:** new `backend/src/common/school-label.spec.ts` — `displayLabel` wins; a
trailing `" - …"` segment is dropped; the result is trimmed to ≤12 chars on a word
boundary; two connections deriving the same label both fall back to the full
`schoolName`. New `backend/src/school-links/school-links.service.spec.ts` — the list
excludes other users' and inactive connections, carries the right `childrenCount`,
`lastSyncAt` is null before the first successful run, and no response field holds a
password. `auth.service.spec.ts` — `getMe().schools` is sorted and `connectedSchool`
equals `schools[0]`.

E2E: `tests/e2e/auth.spec.ts:549` swaps `settings-school-name` for
`settings-schools-card` + `settings-school-name-{semel}` — **the plan's one hard
break**. Add `schools: [one]` to the six `MOCK_ME` constants. New
`tests/e2e/pages/MorePage.ts`.

**Expected:** backend specs pass; `npm --prefix frontend run lint` clean;
`npm run test:e2e` green.

**Commit:** `feat(settings): list every connected school`

## Task 10: `POST /school-links`, the add-school screen, and login adoption

**Files:** `backend/src/common/mashov-login/mashov-credential-validator.service.ts`
(new); `school-links.service.ts`; `auth.service.ts`; `connection.service.ts`;
`frontend/src/components/auth/SchoolAutocomplete.tsx` (new);
`frontend/src/app/more/schools/new/` (new); `SyncingPageClient.tsx`;
`frontend/src/lib/query-invalidation.ts` (new).

1. Extract the validate-then-persist logic from `connection.service.ts` into
   `MashovCredentialValidatorService.validate({ semel, year, username, password,
   uniqueId })`, preserving the `isUpstreamUnreachable` → `UPSTREAM_ERROR` vs
   `INVALID_CREDENTIALS` split verbatim. `auth.service.login`,
   `connection.service.updateConnection` and the new service all call it.
2. `POST /api/v1/school-links`: rate-limited on `ratelimit:school-link:<userId>`, 5 per
   15 min, reusing the `checkRateLimit` shape. Validates, resolves the year
   independently via `resolveForSchool(semel)` plus the one-retry `reconcileFromLogin`
   dance, persists the connection and the `children[]` upserts and `inactiveChildren`
   deactivation through the same path as `login()`, fires
   `syncService.refreshAll({ connectionId })` **without awaiting**, returns **201**.
   Every error code and HTTP status from §9's table, with `NO_CHILDREN_FOUND` /
   `NO_ACTIVE_CHILDREN` **not** persisting the connection. Cap at 4 active →
   `LIMIT_REACHED`. Same `(semel, username)` → `CONNECTION_ALREADY_LINKED`; same
   `semel`, different username → `SCHOOL_ALREADY_LINKED`.
3. **Adoption** in `AuthService.login`, exactly §1's four steps: after the Mashov
   response and before the `appUser.upsert`, look up
   `householdConnection.findUnique({ schoolCode_username })`; if its `userId` is set,
   that AppUser owns the session — refresh the connection row and create the session
   for `conn.userId`, creating no AppUser for `credential.userId`; otherwise upsert as
   today and then follow `mergedIntoUserId` **one hop**, bailing to the original on a
   self or cyclic pointer. `isFirstLogin` is `false` on an adopted login. Behind
   `MASHOV_ENABLE_SCHOOL_LINK_ADOPTION`.
4. Household merging per §1: one transaction re-parenting the connection, setting
   `mergedIntoUserId`, revoking every orphan `AppSession` **including the Redis
   `session:<token>` mirrors**, re-pointing `DigestRecipient`, and copying
   non-conflicting `UserItemState` rows. Keep the orphan `AppUser` row.
5. Frontend: extract `SchoolAutocomplete` from `SignInPageClient.tsx` with §10's props,
   keeping `role="option"` **and** adding `data-testid="school-option-{semel}"`, and
   rendering already-linked schools disabled with "מחובר כבר". The
   `/more/schools/new` route. `invalidateHouseholdScopedQueries(qc)` per §11 — never
   `queryClient.clear()` after a link. `SyncingPageClient` reads
   `searchParams.get('schoolId')`, threads it into `getSyncStatus` /
   `triggerSyncRefresh` on key `['sync-status', schoolId ?? 'all']`, and with it
   present shows "מחברים את בית הספר…" with the skip button going to `/children`.

**Tests:** `auth.service.spec.ts` — adoption attaches to the existing household and
creates no second AppUser; no adoption for an unlinked account; a one-hop
`mergedIntoUserId` resolves; a self-pointer and a cycle bail to the original; the kill
switch off reproduces today's behaviour exactly. `school-links.service.spec.ts` — one
case per error code in §9's table; `NO_CHILDREN_FOUND` leaves no connection row; the
5-per-15-min limit; the 4-connection cap; the refresh is **not** awaited. New
`mashov-credential-validator.service.spec.ts` — the `UPSTREAM_ERROR` vs
`INVALID_CREDENTIALS` split, unchanged from `connection.service.spec.ts`'s cases.

E2E: new `tests/e2e/pages/AddSchoolPage.ts` and `tests/e2e/school-links.spec.ts` — the
add-school happy path to syncing, one test per error code asserting the **exact
Hebrew** from §9, and a linked school's option disabled.

**Expected:** all specs pass; `npm run test:e2e` green.

**Commit:** `feat(school-links): link a second school and adopt either account at sign-in`

## Task 11: school identity on the data, badges, chips, grouped child header

**Files:** backend `children.service.ts`, `dashboard.service.ts`, the feed service,
`mail.service.ts`; frontend `types/api.ts`,
`components/school/SchoolBadge.tsx`, `components/school/SchoolFilterChips.tsx`,
`lib/school-filter.ts` (all new), `components/ui/Select.tsx`, `ChildHeader.tsx`,
`ChildrenPageClient.tsx`, `HomePageClient.tsx`, `InboxPageClient.tsx`.

Backend: `schoolId` and `schoolShortLabel` on children, dashboard children, feed items
and conversations. `getConversations` / `buildInboxWhere` accept an optional connection
filter and include the connection's `schoolName` and `schoolCode`.

Frontend, every new surface gated on `me.schools.length >= 2` and otherwise rendering
`null`, so a one-school DOM is byte-identical to today:

- `SchoolBadge` — the existing `Badge` plus a `School` lucide icon,
  `title={schoolName}`, `truncate max-w-[6rem]`, calling `useMe()` itself. Icon + text,
  **no colour semantics**.
- `SchoolFilterChips` — `role="group" aria-label="סינון לפי בית ספר"`, the `chip` class
  from `globals.css`, `aria-pressed`, `overflow-x-auto scrollbar-hide`.
- `school-filter.ts` — `parseSchoolFilter` falling back to `'all'` on anything unknown.
  State in `?school=<semel>|all`, set with `router.replace`, keyed by `semel`.
  Filtering is client-side over the fetched list.
- Filtered-empty is its own state: *אין ילדים בבית הספר הזה* plus
  `school-filter-reset-btn`.
- `/children` first. `/home` and `/inbox` chips only now that feed items and
  conversations carry `schoolId`. The chip row must never write
  `localStorage['mashov.selectedChildGuid']`, and `HomePageClient`'s auto-select effect
  keeps operating on the **unfiltered** list.
- `ChildHeader` groups the Radix `Select` by school with new `SelectGroup` /
  `SelectLabel` wrappers **only** above one distinct school, and adds
  `child-header-school-label` to the subtitle.

**Tests:** new `tests/e2e/school-filter.spec.ts` — chips **absent** with one school;
present with two; a click writes `?school=`; a deep link applies; `?school=zzz` falls
back to all; filtered-empty with a working reset. `ChildrenPage`, `HomePage` and
`InboxPage` page objects gain `schoolFilterChip`, `filterBySchool`, `schoolBadge`.
Backend specs assert `schoolId` and `schoolShortLabel` on each response shape.

**Expected:** e2e green, including every existing single-school spec unchanged.

**Commit:** `feat(ui): label each child's school and filter by it`

## Task 12: scoped unlink

**Files:** `backend/src/connection/connection.service.ts`,
`backend/src/session/mashov-session.service.ts`, `settings.service.ts`,
`school-links.controller.ts`, `SchoolLinksCard.tsx`.

Rewrite `deleteConnection(userId, connectionId?)` exactly as §7 specifies: student
guids from `householdConnectionId` (**not** `isActive: true`), NULL-stamped students
included **only** on the user's last connection; the scoped deletes in FK order with
`mailMessage` before `mailConversation` and with `studentRelease` and `schoolActivity`
added (both missing today); `behaviorTypeReference` by `schoolCode` only when no other
active connection shares it; `student.deleteMany` as a new step; then the connection.
`AppUser` and `AppSession` untouched. Add
`MashovSessionService.invalidateConnection(connectionId)` clearing every
`connectionSessions` / `lastLoginByConnection` / `lastRosterByConnection` entry whose
key starts with `${connectionId}:`. `settings.service.getProfile` stops coin-flipping
between two `parentProfile` rows. `DELETE /school-links/:id` and `DELETE /school-links`;
`PUT /school-links/:id`. `PUT /connection` and `DELETE /connection` become deprecated
aliases.

Frontend: the per-school unlink row, the add row, and §10's blast-radius confirms —
per-school ("…הנתונים של \"X\" יישארו") and the last-school variant. After unlinking
one, capture the removed school's guids from the `['children']` cache **before**
invalidating and clear `selectedChildGuid` if it is among them; after unlinking all,
`queryClient.clear()` and `/auth/sign-in`. Verify `ChildWorkspacePage`'s error path has
a "חזרה לילדים" link; add it if not.

**Tests:** `connection.service.spec.ts` — unlinking A leaves B's children, mail and
read state intact; `studentRelease` and `schoolActivity` are now deleted; `student`
rows are deleted rather than orphaned; `AppUser` and the session survive; A's session
cache is evicted; the last connection also takes the NULL-stamped students.
E2E in `school-links.spec.ts` — unlink A with B remaining stays signed in; unlinking
the only school redirects to sign-in.

**Expected:** all specs pass; full suite green; e2e green.

**Commit:** `fix(school-links): delete only the unlinked school's data`
