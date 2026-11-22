# API Contract: Mashov School Parent Command Center

**Version:** Phase 1 (implemented) + Phase 2 (planned)
**PRD source:** `docs/prd/PRD-current.md` (v2 active)
**Status:** Phase 1 endpoints `implemented`; Phase 2 endpoints `planned`
**Auth:** Phase 1 = no auth. Phase 2 = all `/api/v1/*` require session cookie except auth endpoints and `/health`

> This table is the source of truth for backend and frontend agents. Update it when routes change. All paths use the `/api/v1` prefix. All IDs are UUIDs (strings). All timestamps are ISO 8601 UTC. Pagination uses `page` + `limit` with the standard envelope.

---

## Standard Response Envelopes

### Success (list with pagination)
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 143,
    "totalPages": 8
  }
}
```

### Error
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Student not found",
    "details": []
  }
}
```

---

## Endpoints

| Method | Path | Auth? | Request Body / Query Params | Response Body | Status Codes | Status |
|--------|------|-------|----------------------------|---------------|-------------|--------|
**Phase 2 auth note:** All Phase 1 endpoints below change from `Auth: No` → `Auth: Yes` in Phase 2. Status changes to `changed`. The `/health` endpoint remains unauthenticated.

### Phase 2 — New Auth & Connection Endpoints

| Method | Path | Auth? | Request Body / Query Params | Response Body | Status Codes | Status |
|--------|------|-------|----------------------------|---------------|-------------|--------|
| GET | `/api/v1/auth/schools` | No | — | `Array<{ semel: number, name: string, years: number[] }>` | 200, 502 | planned |
| POST | `/api/v1/auth/login` | No | `{ semel: number, username: string, password: string }` | `{ ok: true, isFirstLogin: boolean }` (sets httpOnly session cookie) | 200, 400, 401, 429 | planned |
| DELETE | `/api/v1/auth/session` | Yes | — | `{ ok: true }` | 200, 401 | planned |
| GET | `/api/v1/auth/me` | Yes | — | `{ mashovUserId: string, username: string, displayName: string, childrenCount: number, schools: MeSchool[] }` | 200, 401 | planned |

### School identity on the data

Every cross-child response carries the school each item belongs to, so the UI can label and
filter it. `schoolId` is the owning connection; `schoolShortLabel` is resolved **server-side as
a set**, so two schools in one cluster can never present the same chip (deriving it in the
client would put that collision rule in two languages).

| Response | Added fields |
|---|---|
| `GET /children` → `ChildListItem` | `schoolId`, `schoolName`, `schoolShortLabel`, `semel` |
| `GET /dashboard` → `children[]` | `schoolId`, `schoolShortLabel` |
| `GET /dashboard` → `feed[]`, `GET /feed` → `data[]` | `schoolId`, `schoolShortLabel` |
| `GET /mail/conversations` → `data[]` | `schoolId`, `schoolShortLabel` |

`schoolId` is always one of the **caller's own** connections, on every one of these responses:
a child two parents at one school share resolves to whichever connection belongs to the caller
asking, never to the other parent's, so the id is always resolvable against `me.schools`.

All four are `string \| null`. `null` is a real value and means **no badge**: an unstamped child,
whose ownership is not yet known, and mail, which is household-wide and genuinely has no child.
Clients must treat it as "unknown", never as a school named "null". Such an item stays
**visible** under every school filter — hiding it behind a chip it can never match would make it
unreachable — and for the inbox the **server** guarantees that, because `?schoolId=` is the
filter the chip sends.

`GET /mail/conversations` also accepts `?schoolId=` (a `HouseholdConnection.id`) to narrow to one
mailbox. It matches that connection's conversations **plus the unattributed ones**, and 404s a
connection belonging to another household.

Every school-aware UI surface renders nothing while `me.schools.length < 2`, so a one-school
household's markup is unchanged by all of the above.

### Connected schools

A household holds up to **4** school connections (see ADR-0029). `me.schools` is the cheap read
every page's school badge needs — `['me']` is already cached by the app shell — while
`/school-links` carries the management-only fields. One service method feeds both, so they
cannot disagree about which schools a household has.

**Removed in T14**, and recorded here because a client written against an older copy of this
table will have read them:

- `me.connectedSchool` was `schools[0]` under a singular name, so it could not describe a
  household with two schools. Use `me.schools`; `isPrimary` on `/school-links` is the only
  remaining "most recently used" hint, and it is a display hint.
- `DashboardResponse.school` was the household's most recently used connection, with the same
  problem. Every school label on that response is per-item now (`schoolId`,
  `schoolShortLabel`), resolved per child.
- `PUT`/`DELETE /api/v1/connection` were aliases over the same service methods as
  `/school-links`; `PUT` meant "the most recently used school" and `DELETE` meant "every
  school", the only things they could mean since both predate a household having more than
  one. Use `PUT /api/v1/school-links/:id` and `DELETE /api/v1/school-links` — note the latter
  answers **204 with no body** where the alias answered `200 { ok: true }`. Both paths now
  404.

| Method | Path | Auth | Request | Response | Codes |
|---|---|---|---|---|---|
| GET | `/api/v1/school-links` | Yes | — | `{ data: SchoolLink[], pagination }` | 200, 401 |
| POST | `/api/v1/school-links` | Yes | `{ semel, username, password }` | `SchoolLink` | 201, 400, 401, 409, 422, 429, 502 |
| PUT | `/api/v1/school-links/:id` | Yes | `{ username?, password? }` | `SchoolLink` | 200, 400, 401, 404, 409, 502 |
| DELETE | `/api/v1/school-links/:id` | Yes | — | — | 204, 401, 404 |
| DELETE | `/api/v1/school-links` | Yes | — | — | 204, 401 |

```ts
interface MeSchool {
  id: string; semel: number; schoolName: string;
  shortLabel: string;   // resolved server-side as a SET, so two schools never share one
  schoolYear: number;
}

interface SchoolLink extends MeSchool {
  username: string;     // never the password, in any form
  childrenCount: number;
  isPrimary: boolean;   // the most recently used school; a display hint, never a scope
  lastLoginAt: string | null;
  lastSyncAt: string | null;   // null => the first sync has not SUCCEEDED yet
  active: boolean;
}
```

`POST /api/v1/school-links` is rate-limited to **5 attempts per 15 minutes per user** — not per
IP: it brute-forces upstream Mashov credentials from inside an authenticated session, which
sign-in's IP limit does not cover. It does **not** wait for a sync; the children arrive in the
login response and the rest is fired in the background.

Its failures, each with the message the UI shows:

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Mashov rejected the school's username or password. **Not** an expired session — `apiFetch` skips its sign-in redirect for this code specifically. |
| `UPSTREAM_ERROR` | 502 | Mashov unreachable. Never reported as bad credentials. |
| `SCHOOL_ALREADY_LINKED` | 409 | A second account at an already-linked school. Refused: it would duplicate every child. |
| `CONNECTION_ALREADY_LINKED` | 409 | This exact account is already linked, here or to another household. |
| `NO_CHILDREN_FOUND` | 422 | No children in the account — usually a student's credentials rather than a parent's. **Nothing is persisted.** |
| `NO_ACTIVE_CHILDREN` | 422 | Every child in the account is inactive. **Nothing is persisted.** |
| `LIMIT_REACHED` | 409 | Already at 4 active connections. |
| `RATE_LIMITED` | 429 | More than 5 attempts in 15 minutes. |

A `404` — never a `403` — is returned for a `:id` belonging to another household, on every verb.
A `403` would confirm the id names a real connection.
| GET | `/api/v1/sync/status` | Yes | — | `{ done: boolean, sourcesCompleted: number, sourcesTotal: number, phase: "idle" \| "running" \| "stale" \| "success" \| "partial" \| "failed" \| "unknown", refreshId: string \| null, startedAt: string \| null, endedAt: string \| null, tasksTotal: number, tasksSettled: number, tasksFailed: number, currentTask: string \| null, tasks: Array<{ task: string, status: "running" \| "success" \| "failed" }> }` | 200, 401 | implemented |

Both `GET /api/v1/sync/status` and `POST /api/v1/sync/refresh` accept an optional
`?schoolId=<connectionId>`, and `404` on one belonging to another household. Omitted, they
cover **every** active connection: refresh runs them sequentially (concurrency 1 — two
simultaneous Mashov logins from one household invites a rate limit), and status aggregates one
envelope per connection.

The aggregation is worst-wins, so `done` means **every** school has stopped rather than
whichever one finished first — releasing the first-login screen early would land the parent on a
Home page missing half their children. `tasksTotal`, `tasksSettled` and `tasksFailed` are summed,
and a `schools: SyncStatusSchool[]` breakdown lets the UI name the school it is waiting on:

```ts
interface SyncStatusSchool {
  schoolId: string; semel: number; schoolName: string | null;
  phase: SyncStatusPhase;
  tasksTotal: number; tasksSettled: number; tasksFailed: number;
  currentTask: string | null;
}
```

### `GET /api/v1/sync/status` — completion semantics

`done` is the refresh's own report, read from the per-connection refresh envelope in Redis
(`sync:refresh:<connectionId>`). It is **not** derived from `sync_run` rows, and this endpoint
does not read that table at all.

| Situation | `phase` | `done` |
|---|---|---|
| No active connection, or no envelope | `idle` | `false` |
| Envelope `running` and fresh | `running` | `false` |
| Envelope `running` but `updatedAt` older than 5 minutes | `stale` | `true` |
| Every task succeeded | `success` | `true` |
| At least one task failed | `partial` | `true` |
| The refresh threw outside a task | `failed` | `true` |
| Redis unreachable | `unknown` | `false` (never a 500) |

`partial` is `done` on purpose: a failed source is per-source health, reported by
`GET /api/v1/settings/source-health`, and never a reason to hold a user on the first-login
screen. `stale` is `done` for the same reason in reverse — a backend killed mid-refresh must
release every waiting client, not just one that happens to have its own timeout.

`sourcesCompleted` and `sourcesTotal` are preserved aliases of `tasksSettled` and `tasksTotal`
so clients written against the previous payload keep working. The previous implementation
compared a count of distinct successful `sync_run` sources inside a 30-minute window against a
hardcoded `TOTAL_SYNC_SOURCES = 16`; source keys are per-student and per-connection, so that
target was unreachable for any household with a failing source and already passed for any
household with two children.

`sourcesCompleted`/`sourcesTotal` now carry *task* counts under *source* names. The task count is
the wired task list (16 today) and does not vary with the number of children or connections —
that independence is the fix. The UI string ("N / M מקורות הושלמו") is unchanged for
compatibility.

### `GET /api/v1/settings/source-health` — scoping

Scoped to the caller's active household connection; a user with no connection gets an empty
`sources` array and no database read. Two deliberate details:

- **Runs with a NULL connection are included.** Every `@Cron` entrypoint calls its task's
  `execute()` with no context, so `openRun` stores `householdConnectionId = null` for all
  scheduled runs. Excluding those would report `never_synced` for a dozen sources whose crons
  succeed every twelve minutes — turning the one page that answers "is syncing working" into a
  page that always says no.
- **Per-student source keys come from the caller's own snapshot**, not from
  `student.findMany`. `FreshnessService.getAllSourceHealth` emits one `<source>:<guid>` entry per
  guid it is handed whether or not a run exists, so passing every active child listed every
  household's child identifiers regardless of how the `sync_run` reads were filtered.

**Known residual.** `Student` has no household column, so per-student tasks iterate every child
in the database and stamp those runs with whichever connection triggered the refresh (cron runs
with none). A caller whose refresh has run can therefore still see a guid that is not theirs.
Closing that needs `Student` scoped to a household — a schema change with its own ADR. What is
gone is the unconditional enumeration, which leaked every child to every user regardless of sync
activity.

**Also unscoped, and not fixed here:** `overallState` and `contentFreshness` in the same response
come from `computeContentFreshness()`, which reads *any* active connection and aggregates over
every student. One household parked on an old school year therefore degrades everyone's
`overallState`. That predates this change and needs its own fix.

### `GET /api/v1/settings/profile` — scoping

Requires a session (401 without one) and returns only the caller's own profile. It previously
used `parentProfile.findFirst()` and `householdConnection.findFirst({ active: true })`, neither
filtered by user, so any signed-in parent received *a* profile — some arbitrary household's
`displayName`, `email` and `cellphone`, plus their school.

`ParentProfile` has no `userId`. It is keyed on `upstreamUserId`, which is Mashov's
`credential.userId` — the same value stored as `AppUser.mashovUserId` at login — so the caller's
app-user row is the hop from a session to a profile. The household is filtered on `userId`
directly.

`displayName` falls back to `AppUser.displayName` when the profile row has none.
`user-details.task` never writes `ParentProfile.displayName`, so for most callers it is null;
unscoped, the page happened to show whichever profile came back first, and scoping it without the
fallback would have left the name blank. Returns `null` (an empty body) when the caller has no
profile row, rather than someone else's.

**The name is stripped of its trailing `[...]` group** (`common/parent-name.ts`), on this route
and on `/auth/me`. `credential.displayName` is per-school and arrives as the parent's name plus
ONE of that school's children — `"קורס דמיטרי [מיקה ז8]"` — and the single global
`AppUser.displayName` holds whichever credential created the user, so every card named that one
child under every school. The stored value stays raw; the children come from `StudentConnection`
instead, as `children` per entry here and as `childrenCount` on `/auth/me`. Both reads use the
predicates their neighbours use — `listLinks`' count query here, `visibleStudentWhere` there —
so a card cannot disagree with the school row beneath it, nor the header with `/children`.

### Phase 1 Endpoints (all require Auth: Yes in Phase 2)

| Method | Path | Auth? | Request Body / Query Params | Response Body | Status Codes | Status |
|--------|------|-------|----------------------------|---------------|-------------|--------|
| GET | `/health` | No | — | `{ status: "ok" \| "degraded", db: "connected" \| "error" }` | 200 | implemented |
| GET | `/api/v1/dashboard` | **Yes** (Phase 2) | — | See [Dashboard Response](#get-apiv1dashboard) | 200, 401 | changed |
| GET | `/api/v1/feed` | **Yes** (Phase 2) | `?page=1&limit=20` | See [Feed Response](#get-apiv1feed) | 200, 401 | changed |
| GET | `/api/v1/children` | **Yes** (Phase 2) | — | See [Children List Response](#get-apiv1children) | 200, 401 | changed |
| GET | `/api/v1/children/:studentGuid` | **Yes** (Phase 2) | — | See [Child Workspace Response](#get-apiv1childrenstudentguid) | 200, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/homework` | **Yes** (Phase 2) | `?page=1&limit=50&status=all\|new\|archived` (`all` excludes archived) | See [Homework Response](#get-apiv1childrenstudentguidhomework) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/homework/:homeworkId/is-new` | **Yes** (Phase 2) | `{ isNew: boolean }` | See [Homework Item](#homework-item-shape) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/homework/:homeworkId/archive` | **Yes** (Phase 2) | `{ isArchived: boolean }` | See [Homework Item](#homework-item-shape) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/homework/is-new` | **Yes** (Phase 2) | `{ homeworkIds: string[], isNew: boolean }` | `{ updated: number }` | 200, 400, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/homework/archive` | **Yes** (Phase 2) | `{ homeworkIds: string[], isArchived: boolean }` | `{ updated: number }` | 200, 400, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/behavior` | **Yes** (Phase 2) | `?page=1&limit=50&bucket=all\|attention\|positive\|neutral&status=all\|new\|archived` (`all` excludes archived) | See [Behavior Response](#get-apiv1childrenstudentguidbehavior) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/behavior/:behaviorId/is-new` | **Yes** (Phase 2) | `{ isNew: boolean }` | See [Behavior Item](#behavior-item-shape) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/behavior/:behaviorId/archive` | **Yes** (Phase 2) | `{ isArchived: boolean }` | See [Behavior Item](#behavior-item-shape) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/behavior/is-new` | **Yes** (Phase 2) | `{ behaviorIds: string[], isNew: boolean }` | `{ updated: number }` | 200, 400, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/behavior/archive` | **Yes** (Phase 2) | `{ behaviorIds: string[], isArchived: boolean }` | `{ updated: number }` | 200, 400, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/subjects` | **Yes** (Phase 2) | — | See [Subjects Response](#get-apiv1childrenstudentguidsubjects) | 200, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/notices` | **Yes** (Phase 2) | — | See [Notices Response](#get-apiv1childrenstudentguidnotices) | 200, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/timetable` | **Yes** (Phase 2) | — | See [Timetable Response](#get-apiv1childrenstudentguidtimetable) | 200, 401, 404 | changed |
| GET | `/api/v1/mail/summary` | **Yes** (Phase 2) | — | See [Mail Summary Response](#get-apiv1mailsummary) | 200, 401 | changed |
| GET | `/api/v1/mail/conversations` | **Yes** (Phase 2) | `?page=1&limit=20&filter=all\|new\|archived` | See [Conversations List Response](#get-apiv1mailconversations) | 200, 401 | changed |
| GET | `/api/v1/mail/conversations/:id` | **Yes** (Phase 2) | — | See [Conversation Detail Response](#get-apiv1mailconversationsid) | 200, 401, 404 | changed |
| PUT | `/api/v1/mail/conversations/mark-read` | **Yes** (Phase 2) | `{ conversationIds: string[] }` | `{ updated: number }` | 200, 400, 401 | changed |
| PUT | `/api/v1/mail/conversations/mark-unread` | **Yes** (Phase 2) | `{ conversationIds: string[] }` | `{ updated: number }` | 200, 400, 401 | changed |
| PUT | `/api/v1/mail/conversations/archive` | **Yes** (Phase 2) | `{ conversationIds: string[] }` | `{ updated: number }` | 200, 400, 401 | changed |
| PUT | `/api/v1/mail/conversations/unarchive` | **Yes** (Phase 2) | `{ conversationIds: string[] }` | `{ updated: number }` | 200, 400, 401 | changed |
| GET | `/api/v1/settings/source-health` | **Yes** (Phase 2) | — | See [Source Health Response](#get-apiv1settingssource-health) | 200, 401 | changed |
| GET | `/api/v1/settings/profile` | **Yes** (Phase 2) | — | See [Profile Response](#get-apiv1settingsprofile) | 200, 401 | changed |
| POST | `/api/v1/sync/refresh` | **Yes** (Phase 2) | — | `{ started: true, message: string }` | 202, 401 | changed |

### Digest — per-child daily activity briefing

Delivery is strictly opt-in: a child receives a digest only if an enabled recipient row exists
for it. See ADR-0026 (delivery and LLM egress), ADR-0027 (derived deadlines) and ADR-0035
(per-user isolation).

A run is one **(child, subscribing parent)**, not one child: both parents of a shared child get
their own message, their own dedup ledger and their own delivery row, and each message carries
only that parent's unanswered consent forms.

| Method | Path | Auth | Request Body | Response Body | Status | State |
|--------|------|------|--------------|---------------|--------|-------|
| GET | `/api/v1/digest/recipients?studentGuid=&page=&limit=` | **Yes** | — | Paginated `DigestRecipient[]` | 200, 400, 401 | changed |
| POST | `/api/v1/digest/recipients` | **Yes** | `{ studentGuid, channel, address, displayName? }` | `{ data: DigestRecipient }` | 201, 400, 401, 403 | new |
| PATCH | `/api/v1/digest/recipients/:id` | **Yes** | `{ enabled?, displayName? }` | `{ data: DigestRecipient }` | 200, 401, 404 | new |
| DELETE | `/api/v1/digest/recipients/:id` | **Yes** | — | — | 204, 401, 403, 404 | new |
| POST | `/api/v1/digest/runs` | **Yes** | `{ studentGuid?, dryRun? }` | `{ data: DigestRunResult[] }` | 201, 401, 429 | new |
| GET | `/api/v1/digest/deliveries?studentGuid=&page=&limit=` | **Yes** | — | Paginated `DigestDelivery[]` | 200, 401 | changed |
| POST | `/api/v1/digest/telegram-links` | **Yes** | `{ studentGuids: string[] }` | `{ data: TelegramLink }` | 201, 400, 401, 403, 429, 503 | new |
| GET | `/api/v1/digest/telegram-links/:code` | **Yes** | — | `{ data: TelegramLinkState }` | 200, 401, 404 | new |
| DELETE | `/api/v1/digest/telegram-links` | **Yes** | — | — | 204, 401 | new |

`studentGuid` on `GET /digest/recipients` is **optional**. Omitted, it answers every recipient
row the caller owns, which is what the `/more` Telegram card asks for: "what am I subscribed
to". Child names, classes and school labels are joined client-side from the already-cached
children list, so there is no new read route and no server-side join.

The route is paginated like `GET /digest/deliveries` (default `page=1`, `limit=20`, max `limit=100`),
because `.claude/rules/api.md` allows no unbounded list route. The `/more` card is not a paged
list -- its question is "everything" -- so it sends `limit=100` explicitly rather than relying on
a household never outgrowing the default page.

---

## Response Body Schemas

### GET /api/v1/dashboard

```typescript
{
  freshness: {
    state: "fresh" | "syncing" | "stale" | "degraded";
    lastSyncAt: string | null;           // ISO 8601, most recent successful sync across all sources
    staleSources: string[];              // source names that are past their stale threshold
  };
  summary: {
    unreadConversations: number;         // from mail_conversation.isUnread count
    recentHomeworkCount: number;         // homework_item in last 7 days
    recentBehaviorCount: number;         // behavior_item in last 7 days
    childrenCount: number;               // active student count
  };
  feed: Array<{                          // max 20 items; full feed via GET /api/v1/feed
    id: string;
    sourceType: "homework" | "behavior" | "mail" | "positive";
    sourceId: string;
    studentGuid: string | null;
    studentName: string | null;
    title: string;
    summary: string;
    category: string;
    priority: "high" | "medium" | "low";
    isPositive: boolean;
    isUnread: boolean;
    isHandled: boolean;
    eventAt: string;                     // ISO 8601
    syncedAt: string;                    // ISO 8601
    linkPath: string;
  }>;
  children: Array<{
    studentGuid: string;
    privateName: string;
    familyName: string;
    fullName: string;
    classCode: string;
    classNum: number;
    recentHomeworkCount: number;
    recentBehaviorCount: number;
    latestUpdateAt: string | null;       // ISO 8601
    oneLineStatus: string;               // e.g. "3 homework items, 1 behavior event"
  }>;
  school: {
    schoolName: string;
    schoolYear: number;
  };
}
```

### GET /api/v1/feed

```typescript
{
  data: Array<{
    id: string;
    sourceType: "homework" | "behavior" | "mail" | "positive";
    sourceId: string;
    studentGuid: string | null;
    studentName: string | null;
    title: string;
    summary: string;
    category: string;
    priority: "high" | "medium" | "low";
    isPositive: boolean;
    isUnread: boolean;
    isHandled: boolean;
    eventAt: string;                     // ISO 8601
    syncedAt: string;                    // ISO 8601
    linkPath: string;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

### GET /api/v1/children

```typescript
{
  data: Array<{
    studentGuid: string;
    privateName: string;
    familyName: string;
    fullName: string;
    classCode: string;                   // Hebrew letter, e.g. "ג"
    classNum: number;
    gender: string;                      // "נ" | "ז"
    isActive: boolean;
    recentHomeworkCount: number;         // last 7 days
    recentBehaviorCount: number;         // last 7 days
    subjectCount: number;
    latestUpdateAt: string | null;       // ISO 8601
  }>;
}
```

### GET /api/v1/children/:studentGuid

```typescript
{
  student: {
    studentGuid: string;
    privateName: string;
    familyName: string;
    fullName: string;
    classCode: string;
    classNum: number;
    gender: string;
    isActive: boolean;
  };
  summary: {
    recentHomeworkCount: number;         // last 7 days
    recentBehaviorCount: number;         // last 7 days
    subjectCount: number;
    totalWeeklyHours: number;            // sum of subject_enrollment.weeklyHours
    attentionBehaviorCount: number;      // behavior items in Attention bucket, last 7 days
  };
  lastSyncAt: string | null;            // ISO 8601, latest sync_run.endedAt for this child's sources
}
```

### GET /api/v1/children/:studentGuid/homework

Query param semantics for `status`:
- `new` → `isNew=true` and `isArchived=false`
- `all` → all non-archived items (`isArchived=false`), regardless of `isNew`
- `archived` → archived items only (`isArchived=true`)

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    lessonId: number;
    groupId: number;
    lessonDate: string;                  // ISO 8601 date, e.g. "2026-03-05T00:00:00Z"
    lesson: number;                      // period number
    subjectName: string;                 // Hebrew
    homeworkText: string;                // Hebrew
    remark: string | null;               // lesson topic / teacher remark
    files: Array<{
      fileId: string;
      fileName: string;
    }>;
    isNew: boolean;                      // true until explicitly dismissed
    isArchived: boolean;                 // soft-archived by the parent
    updatedAt: string;                   // ISO 8601
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

#### Homework Item Shape

Used in both list and mutation responses:

```typescript
{
  id: string;
  studentGuid: string;
  lessonId: number;
  groupId: number;
  lessonDate: string;
  lesson: number;
  subjectName: string;
  homeworkText: string;
  remark: string | null;
  files: Array<{ fileId: string; fileName: string; }>;
  isNew: boolean;
  isArchived: boolean;
  updatedAt: string;
}
```

### PUT /api/v1/children/:studentGuid/homework/is-new

```typescript
// Request
{
  homeworkIds: string[];
  isNew: boolean;
}

// Response
{
  updated: number;
}
```

### PUT /api/v1/children/:studentGuid/homework/archive

```typescript
// Request
{
  homeworkIds: string[];
  isArchived: boolean;
}

// Response
{
  updated: number;
}
```

### GET /api/v1/children/:studentGuid/behavior

Query param semantics for `status`:
- `new` → `isNew=true` and `isArchived=false`
- `all` → all non-archived items (`isArchived=false`), regardless of `isNew`
- `archived` → archived items only (`isArchived=true`)

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    lessonId: number;
    groupId: number;
    eventCode: number;
    achvaCode: number;
    achvaName: string;                   // Hebrew label
    bucket: "attention" | "positive" | "neutral";
    priority: "high" | "medium" | "low";
    justifiable: boolean;
    lessonDate: string;                  // ISO 8601
    lesson: number | null;               // period number
    subject: string;                     // Hebrew
    reporter: string;                    // teacher name
    remark: string | null;               // null if "ללא הערות" or empty
    justification: string | null;        // null if "ללא הערות" or empty
    eventAt: string;                     // ISO 8601
    isNew: boolean;                      // true until explicitly dismissed
    isArchived: boolean;                 // soft-archived by the parent
    updatedAt: string;                   // ISO 8601
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

#### Behavior Item Shape

Used in both list and mutation responses:

```typescript
{
  id: string;
  studentGuid: string;
  lessonId: number;
  groupId: number;
  eventCode: number;
  achvaCode: number;
  achvaName: string;
  bucket: "attention" | "positive" | "neutral";
  priority: "high" | "medium" | "low";
  justifiable: boolean;
  lessonDate: string;
  lesson: number | null;
  subject: string;
  reporter: string;
  remark: string | null;
  justification: string | null;
  eventAt: string;
  isNew: boolean;
  isArchived: boolean;
  updatedAt: string;
}
```

### PUT /api/v1/children/:studentGuid/behavior/is-new

```typescript
// Request
{
  behaviorIds: string[];
  isNew: boolean;
}

// Response
{
  updated: number;
}
```

### PUT /api/v1/children/:studentGuid/behavior/archive

```typescript
// Request
{
  behaviorIds: string[];
  isArchived: boolean;
}

// Response
{
  updated: number;
}
```

### GET /api/v1/children/:studentGuid/subjects

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    groupId: number;
    groupName: string;                   // e.g. "מתמטיקה ג3"
    subjectName: string;                 // Hebrew
    teachers: Array<{
      teacherGuid: string;
      teacherName: string;
    }>;
    inactiveTeachers: Array<{
      teacherGuid: string;
      teacherName: string;
    }>;
    weeklyHours: number;
    lessonsCount: number;                // lessons held so far
    updatedAt: string;                   // ISO 8601
  }>;
}
```

### GET /api/v1/children/:studentGuid/notices

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    eventId: number;
    eventText: string;                   // sanitized HTML (DOMPurify applied before storage)
    expirationDate: string;              // ISO 8601 — only non-expired items returned
    inSite: boolean;
    updatedAt: string;                   // ISO 8601
  }>;
}
```

### GET /api/v1/children/:studentGuid/timetable

Returns the student's weekly timetable. Synced weekly (Sunday 03:00). Returns an empty array when no data has been synced yet.

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    groupId: number;
    day: number;                         // 1=Sunday … 6=Friday (Israeli school week)
    lesson: number;                      // period number within the day
    roomNum: string;                     // empty string if not set
    weeks: number;                       // -1 = all weeks; positive = specific week mask
    groupName: string;                   // e.g. "מתמטיקה ג3"
    subjectName: string;                 // Hebrew subject name
    teachers: Array<{
      teacherGuid: string;
      teacherName: string;
    }>;
    updatedAt: string;                   // ISO 8601
  }>;
}
```

### GET /api/v1/mail/summary

```typescript
{
  newCount: number;                      // authoritative from mail_conversation.isNew count
  recentConversations: Array<{           // top 3 most recent new/unread, for home screen preview
    conversationId: string;
    subject: string;
    senderNamePreview: string;
    sendTime: string;                    // ISO 8601
    isNew: boolean;
    hasAttachments: boolean;
    preventReply: boolean;
  }>;
  lastSyncAt: string | null;            // ISO 8601
}
```

### GET /api/v1/mail/conversations

Query params: `page=1`, `limit=20`, `filter=all|new|archived`

```typescript
{
  data: Array<{
    conversationId: string;
    subject: string;
    senderNamePreview: string;           // from messages[0].senderName
    sendTime: string;                    // ISO 8601
    isNew: boolean;                      // matches upstream isNew / unread state
    hasDrafts: boolean;
    hasAttachments: boolean;
    preventReply: boolean;
    labels: string[];
    lastFetchedAt: string;               // ISO 8601
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

### GET /api/v1/mail/conversations/:id

Note: If `bodyHtmlSanitized` is null in DB (not yet fetched), backend lazily fetches from upstream, sanitizes, stores, and returns.

```typescript
{
  conversationId: string;
  subject: string;
  sendTime: string;                      // ISO 8601
  isNew: boolean;                        // matches upstream isNew / unread state
  hasDrafts: boolean;
  hasAttachments: boolean;
  preventReply: boolean;
  labels: string[];
  messages: Array<{
    messageId: string;
    conversationId: string;
    senderId: string;
    senderName: string;                  // e.g. "מורים/מעיינה סגל"
    subject: string;
    bodyHtmlSanitized: string;           // DOMPurify-sanitized HTML
    bodyTextPreview: string;             // first 200 chars of stripped HTML
    sendTime: string;                    // ISO 8601
    isNew: boolean;
    recipients: Array<{
      displayOrder: number;
      displayName: string;               // Hebrew label, e.g. "שכבה/ו/כל הורי השכבה"
      valueType: string;                 // "ClassCode" | ...
      targetType: string;                // "Educators" | "Contacts" | ...
      isGroup: boolean;
    }>;
    preventReply: boolean;
    sentViaEmail: boolean;
    sentViaSms: boolean;
  }>;
  lastFetchedAt: string;                 // ISO 8601
}
```

### GET /api/v1/settings/source-health

```typescript
{
  sources: Array<{
    source: string;                      // e.g. "notifications", "homework:studentGuid", "mail_inbox"
    status: "fresh" | "stale" | "failed" | "never_synced";
    lastSuccessAt: string | null;        // ISO 8601
    lastAttemptAt: string | null;        // ISO 8601
    lastErrorMessage: string | null;
    fetchedCount: number | null;
    staleThresholdMinutes: number;
  }>;
  overallState: "fresh" | "syncing" | "stale" | "degraded";
  lastFullSyncAt: string | null;         // ISO 8601
}
```

### GET /api/v1/settings/profile

Scoped to the caller — see [the scoping note](#get-apiv1settingsprofile--scoping). `null` (an
empty body) when the caller has no profile row.

```typescript
{
  householdConnectionId: string;         // which linked school these details are from
  upstreamUserId: string;                // Mashov credential.userId
  displayName: string;                   // profile name, else the app user's; `[...]` stripped
  email: string;
  cellphone: string;
  schoolName: string;
  schoolYear: number;
  schoolCode: number;
  detailsState: number;
  // The children THIS school lists; `[]` while its first roster sync is pending.
  children: Array<{
    studentGuid: string;
    fullName: string;
    classCode: string;
    classNum: number;
  }>;
  updatedAt: string;                     // ISO 8601
}
```

---

## Upstream Mashov API Reference (Backend Internal Use Only)

These are the upstream API calls made by the NestJS sync engine. The frontend never calls these.

| Method | Upstream Path | Used By |
|--------|--------------|---------|
| GET | `https://web.mashov.info/api/schools` | AuthController — school list for login form (proxied to frontend, no auth required) |
| GET | `https://web.mashov.info/students/login` | MashovSessionService — CSRF bootstrap |
| POST | `/api/login` | MashovSessionService — authenticate; also called by AuthController on user login |
| GET | `/api/user/notifications?skip=0&take=50` | NotificationSyncTask |
| GET | `/api/mail/counts?$select=unreadConversations` | MailCountSyncTask |
| GET | `/api/mail/inbox/conversations?skip=0&take=50` | InboxSyncTask |
| GET | `/api/students/{childGuid}/homework` | HomeworkSyncTask (per child) |
| GET | `/api/students/{studentGuid}/behave` | BehaviorSyncTask (per child) |
| GET | `/api/students/{studentId}/groups` | DailyGroupsTask (per child) |
| GET | `/api/students/{studentGuid}/lessonsCount` | DailyLessonsCountTask (per child) |
| GET | `/api/students/{childGuid}/messageBoard` | DailyMessageBoardTask (per child) |
| GET | `/api/achvas` | DailyAchvasTask |
| GET | `/api/user/details` | DailyUserDetailsTask |
| GET | `/api/mail/recipients` | DailyMailRecipientsTask (optional) |
| GET | `/api/mail/conversations/{conversationId}` | MailController — lazy detail fetch |
| PUT | `/api/mail/conversations/markAsUnread` | MailActionController — mark-unread proxy |
| PUT | `/api/mail/conversations/move/archive` | MailActionController — archive proxy |
| GET | `/api/students/{childGuid}/dailyBehave` | DailyBehaveSyncTask (feature-flagged) |
| GET | `/api/students/{studentId}/outBehave` | OutBehaveSyncTask (feature-flagged) |

### Telegram link — POST /api/v1/digest/telegram-links

A parent cannot be messaged by a Telegram bot that they have not pressed START on, so the
START is unavoidable; what this route avoids is making them *also* find their chat id and
retype it. It mints a one-time code and returns the deep link that carries it. The parent taps
it, presses START, and the backend's long poller reads `message.chat.id` out of that update.
See ADR-0033.

```json
{
  "data": {
    "code": "32 hex chars",
    "deepLink": "https://t.me/<bot>?start=<code>",
    "botUsername": "string",
    "expiresAt": "2026-11-21T10:15:00Z"
  }
}
```

`botUsername` comes from Telegram's own `getMe`, cached in memory, rather than from
configuration: `NEXT_PUBLIC_*` is inlined at build time by Next, so a bot username set as a
runtime compose variable would never reach the browser — and asking the bot means the username
cannot drift from whatever token is deployed.

**The code is a credential.** A guessed code binds the guesser's own chat to a victim's
account, and they would then receive that family's children's behaviour reports. It is 16
random bytes, single-use, expires after `TELEGRAM_LINK_CODE_TTL_MINUTES` (15), and this route
is rate-limited to 10/min.

`400` for a `studentGuid` that is not on the active roster, `403` for one the caller's own
connections do not list — including a child no connection lists at all, which the read side
admits and this path does not (note 9). `503 TELEGRAM_NOT_CONFIGURED` when the server
has no `TELEGRAM_BOT_TOKEN` — rather than returning a `t.me/undefined` link that would send the
parent to Telegram to be told the bot does not exist.

### GET /api/v1/digest/telegram-links/:code

What the wizard polls while it waits for the START. Scoped to the caller's `userId` as well as
the code, so a code is never a bearer token for another user's link status.

```json
{
  "data": {
    "status": "pending | linked | expired",
    "linkedAt": "2026-11-21T10:05:00Z",
    "recipientCount": 1,
    "subscribedGuids": ["string"],
    "confirmationSent": true,
    "confirmationPending": false,
    "confirmationError": null,
    "deliveryEnabled": false
  }
}
```

A consumed code reads `linked` permanently, not `expired` once its TTL passes — the wizard polls
after the link already worked.

`confirmationSent` is the real proof: the confirmation message is sent server-side at the
instant the chat is proven reachable, by the link path and not by the digest cron.
`confirmationPending` is the third state between those two — the code is marked consumed before
the send is attempted, so a poll can legitimately land on neither sent nor failed, and the
client must wait there rather than report a failure. `deliveryEnabled` reflects `DIGEST_ENABLED`
**and** `DIGEST_DRY_RUN`, so the wizard's last step can say sending is turned off on this server
rather than promise briefings that will never arrive.

`subscribedGuids` is the children the server actually registered, scoped to this code's own
choice and to rows still switched on. It is **not** always what the parent ticked: a child whose
roster links moved between minting and START is skipped, and the client must name these rather
than its own selection or it will contradict the Telegram message the same link just sent.

Only a **private** chat is bound. A `/start` from a group or channel — which a forwarded deep
link reaches — is refused with a note and leaves the code unspent, because binding there would
send every future digest, naming a child, to everyone in that group.

### DELETE /api/v1/digest/telegram-links

Removes every `telegram` recipient row the caller owns, and their link codes. A parent's chat
id is personal data, so "disconnect" means it stops being stored, not that it is disabled.
Turning off one child stays `PATCH /api/v1/digest/recipients/:id`.

### POST /api/v1/digest/runs

Rate-limited to 5/min, tighter than the global 50/min, because it spends model tokens and
sends real messages. It is also listed in the frontend proxy's `SLOW_PATH_PREFIXES`, so it
gets the longer timeout rather than the 15 s default.

```json
{
  "data": [
    {
      "studentGuid": "string",
      "userId": "string (whose run this was)",
      "status": "sent | skipped_empty | skipped_stale | skipped_unowned | failed | dry_run",
      "itemCount": 2,
      "recipientCount": 1,
      "usedLlm": true,
      "error": "string (only when status is failed)"
    }
  ]
}
```

One element per (child, subscribing parent). A manual run is already scoped to the caller, so
`userId` is theirs on every element; the cron produces one per subscriber.

`dryRun` renders and logs the message without sending it, and marks nothing as reported, so a
later real run still has something to say. It defaults to the `DIGEST_DRY_RUN` env var, which
itself defaults to `true`.

### GET /api/v1/digest/deliveries

```json
{
  "data": [
    {
      "id": "string",
      "userId": "string",
      "studentGuid": "string",
      "reportFor": "2026-11-17",
      "runAt": "2026-11-17T13:00:04Z",
      "status": "sent | skipped_empty | skipped_stale | skipped_unowned | failed | dry_run",
      "itemCount": 2,
      "recipientCount": 1,
      "channel": "telegram",
      "messageText": "string (what was actually sent)",
      "usedLlm": true,
      "errorMessage": null
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 7, "totalPages": 1 }
}
```

`recipientCount` is the number of chats actually reached. When two accounts link the same chat for
the same child, the second run of that pass suppresses the byte-identical resend: its row is
`status: "sent"` with `recipientCount: 0` and the suppression named in `errorMessage`.

**Scoped by user, not by subscribed child** (ADR-0035). It used to answer every row for every
child the caller held a recipient for, which in a two-parent household meant each parent could
read the other's `messageText` -- and that text now contains the other parent's own unanswered
consent forms. A run records whose it was, so that is the scope. `studentGuid` narrows it
further, within the caller's own rows.

`skipped_unowned` is the third: the run was refused at send time because that account no longer
owns that child -- the school it was connected through is gone, or the child has left the active
roster. The reason is in `errorMessage`. Nothing is deleted when this happens (revocation belongs
to the unlink path, and a transient roster gap must not drop a subscription), and the row is
written once per school day however many times the cron runs.

Every run writes a row, `status: "skipped_empty"` included. That is deliberate: without it a
quiet child is indistinguishable from a broken job. `skipped_stale` is the stronger version of
that — no items *and* the school data has not synced successfully for hours, so "nothing
happened today" would be a wrong thing to imply. Digest runs are **not** recorded in `sync_run`
— the freshness and source-health reads treat every row there as a sync source, so digest rows
would skew what the dashboard reports. (`GET /sync/status` no longer reads `sync_run` at all;
it reads the refresh envelope. The reason to keep digest rows out stands regardless.)

Scoped to the caller: a delivery row holds `messageText`, the rendered behavior remarks that
were sent to a parent, so the history returns only children the caller has recipient rows for.
`PATCH` and `DELETE` on a recipient are likewise restricted to the user who created it and
return 403 otherwise.


---

## Notes

1. **`PUT /api/v1/mail/conversations/mark-unread` and `PUT archive`** — these are proxy actions that call the upstream Mashov API directly and also update local `mail_conversation.isNew` state in DB. `mark-read`, `unarchive` are local-only operations.
2. **`GET /api/v1/mail/conversations/:id`** — the response includes sanitized HTML body. The first call for a conversation that has not been detail-fetched will be slightly slower (upstream proxy + sanitize + store). Subsequent calls return from DB.
3. **Notices** — only non-expired items are returned. `expirationDate` comparison is done server-side.
4. **Behavior `remark` and `justification` fields** — the backend suppresses the upstream default value `"ללא הערות"` and returns `null` instead. Frontend should treat `null` as "no comment".
5. **`POST /api/v1/sync/refresh`** — returns `202 Accepted` immediately. Sync runs asynchronously. Frontend should poll `GET /api/v1/settings/source-health` to observe progress.
6. **All list endpoints** — default limit 20, max limit 100. Exception: `/children/subjects`, `/children/notices`, and `/children/timetable` return full lists (no pagination needed at current data scale).
7. **Read/handled state** — implemented directly on items (`isNew`, `isArchived` fields on `homework_item` and `behavior_item`; `isNew` on `mail_conversation`). There is no separate `read_state` table in Phase 1. State is household-global.
8. **Digest deadlines** — the `צפי הגשה` date in a digest message is an *estimate*, never a due date. Mashov exposes no homework due-date field; the estimate comes from an explicit deadline written in the Hebrew text when there is one, else the group's next lesson from the timetable. ADR-0027 records this departure from the requirement not to promise due-soon logic.
9. **Digest ownership** — `digest_recipient` rows are the de-facto child → parent mapping, because `student` has no `userId` FK. Every route that creates one validates that `studentGuid` is on the **active** roster and that the caller's own connections list the child (`ownsStudentForDelivery`, the ADR-0031 link set), answering `400` and `403 FORBIDDEN` respectively; the creating `userId` is recorded and scopes every mutation and the delivery history. That check is deliberately **stricter than the read side**: `canSeeStudent` admits a child no connection lists, because on a read "ownership unknown" must not empty the app, but a write that starts pushing a child's conduct record to a messaging app refuses it — otherwise any authenticated parent could claim an unattributed child. The cost is that on a roster that has never been attributed, a parent must wait for a successful roster sync before subscribing. ADR-0033 closed the cross-household hole ADR-0026 had accepted.
10. **Timetable** — synced weekly (Sunday 03:00). The `day` field uses Israeli school week: 1=Sunday, 2=Monday, …, 6=Friday. Frontend should handle the case where `data` is empty (sync not yet run or source returned no data).
