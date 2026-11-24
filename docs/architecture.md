# Architecture: Mashov School Parent Command Center

**PRD source:** `docs/prd/PRD-current.md` (Phase 1: v1 2026-03-11 | Phase 2: v2 2026-03-16)

---

## Goal

Build a mobile-first household command center that syncs data from the Mashov school API into a local PostgreSQL database and serves a unified, cross-child dashboard to a parent — answering "anything important?" in a single glance.

---

## Scope

### In scope (Phase 1)
- Upstream Mashov session management (CSRF bootstrap, cookie maintenance, re-auth)
- Cron-based sync engine for all primary sources (notifications, mail, homework, behavior, groups, lessons, achvas, message board, user details)
- Internal REST API serving all frontend data from local DB
- Next.js frontend: Home, Children, Child Workspace, Inbox, Conversation Detail, More/Settings
- Local handled/read state (household-global)
- Per-source sync health and freshness status
- Docker Compose stack for local dev and production
- GitHub Actions CI pipeline
- Feature-flagged ingestion path for `dailyBehave` and `outBehave`

### Out of scope (Phase 1)
- App authentication / login UI (Phase 2)
- Grades, report cards, performance analytics
- Outbound messaging (compose, reply)
- Attachment download
- Justification submission
- Push notifications
- Multi-household support

> **Note:** Static weekly timetable (`GET /api/students/{guid}/timetable`) was originally out of scope but was implemented in Phase 1 as an extension — see ADR-0012. It is read-only, non-live, and does not imply scheduling or next-lesson logic.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       Client (Browser / Mobile)                  │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │              Next.js 15 App (App Router)                 │   │
│   │   React + TypeScript + Tailwind + shadcn/ui             │   │
│   │   TanStack Query (polling, cache, loading states)       │   │
│   │   RTL support (dir="rtl") + Hebrew typography           │   │
│   │   Pages: Home / Children / Inbox / More                 │   │
│   └──────────────────┬──────────────────────────────────────┘   │
└─────────────────────┼────────────────────────────────────────────┘
                      │ HTTP  /api/v1/...
                      │ (Next.js proxy or direct to backend)
┌─────────────────────▼────────────────────────────────────────────┐
│                       NestJS Backend                             │
│                                                                  │
│  ┌──────────────┐  ┌────────────────┐  ┌───────────────────┐   │
│  │  API Layer   │  │  Sync Engine   │  │  Session Manager  │   │
│  │  (Controllers│  │  (@nestjs/     │  │  (CSRF bootstrap, │   │
│  │   + Guards)  │  │   schedule)    │  │   cookie store,   │   │
│  └──────┬───────┘  └──────┬─────────┘  │   re-auth)        │   │
│         │                 │            └────────┬──────────┘   │
│  ┌──────▼─────────────────▼───────────────────▼──────────────┐  │
│  │                     Service Layer                          │  │
│  │  DashboardService / ChildService / MailService /           │  │
│  │  SyncService / NotificationService / ReadStateService      │  │
│  └──────────────────────┬─────────────────────────────────────┘  │
│                         │                                        │
│  ┌──────────────────────▼─────────────────────────────────────┐  │
│  │                  Prisma ORM                                 │  │
│  └──────────────────────┬─────────────────────────────────────┘  │
└─────────────────────────┼────────────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────────────┐
│                   PostgreSQL 16                                   │
│   16 tables: household_connection, parent_profile, student,      │
│   notification_event, mail_conversation, mail_message,           │
│   homework_item, behavior_item, subject_enrollment,              │
│   behavior_type_reference, message_board_item,                   │
│   timetable_entry, sync_run, recipient_directory                 │
│   (Note: read_state replaced by isNew/isArchived on item tables) │
└──────────────────────────────────────────────────────────────────┘
                          ▲
                (upstream proxy only — no direct client access)
┌─────────────────────────┴────────────────────────────────────────┐
│                  Mashov Upstream API                              │
│              https://web.mashov.info/api                         │
│   Session maintained in NestJS memory (cookie jar)               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Module Breakdown

### NestJS Backend Modules

| Module | Responsibility |
|--------|---------------|
| `SessionModule` | CSRF bootstrap, login, cookie jar, re-auth on 401/403 |
| `SyncModule` | Cron orchestrator, per-source sync tasks, `sync_run` logging |
| `DashboardModule` | Assemble home screen: summary, needs-attention, feed, child cards, freshness |
| `ChildrenModule` | Child list and workspace: homework, behavior, subjects, notices |
| `MailModule` | Mail summary, conversation list, conversation detail, mark-unread, archive |
| `NotificationModule` | Ingest and normalize `notification_event` records |
| `ReadStateModule` | Manage local handled/read state per item |
| `SettingsModule` | Source health report, parent profile |
| `HealthModule` | `GET /health` with DB ping |
| `PrismaModule` | Global Prisma client, injected everywhere |

### Next.js Frontend Pages / Routes

| Route | Page |
|-------|------|
| `/` | Home dashboard |
| `/children` | Children list |
| `/children/[studentGuid]` | Child workspace (overview + sections) |
| `/inbox` | Inbox conversation list |
| `/inbox/[conversationId]` | Conversation detail |
| `/more` | Settings, sync health, diagnostics |

---

## Sync Engine Design

### Session Management Flow

```
1. GET https://web.mashov.info/students/login
   → Extract X-Csrf-Token from response headers
2. POST /api/login with CSRF token + credentials
   → Receive cookies: Csrf-Token, MashovAuthToken, uniquId
   → Parse accessToken.children[] → upsert student records
   → Parse accessToken.schoolSettings → upsert household_connection
3. All subsequent requests include:
   → Cookie header with stored cookies
   → X-Csrf-Token header with session CSRF token
4. On 401/403 from any upstream call:
   → Discard current session
   → Repeat steps 1–2 before retrying
```

### In-app Mashov auth: when `POST /api/login` refuses

Added in Phase 2. A correct password is not enough — Mashov answers `403` with a
`Reason` header for five distinct situations, and each used to surface to the
parent as "wrong password" with nowhere to go. The full rationale is
[ADR-0042](adr/0042-in-app-mashov-auth-surface.md); the routes and their error
codes are in [`api-contract.md`](api-contract.md).

| `Reason` | What it means | In-app answer |
|---|---|---|
| `MfaRequired` | A one-time code is needed | `/auth/mfa` → `POST /auth/mfa-challenges/:id/{code,session}` |
| `ChangePass` | Password correct, must be replaced before entry | `/auth/complete-setup?mode=password` → `POST /auth/credentials` |
| `CreateUsername` / `SetUsernameAndPass` | A username must be set | `/auth/complete-setup?mode=credentials` → same route |
| `UserSuspended` | A captcha is wanted | A link out to Mashov's own page; we do not solve it |
| — (parent forgot it) | No usable password at all | `/auth/forgot-password` → `POST /auth/credential-recoveries` |

Three properties shape the design:

- **No route here may answer 401.** `apiFetch` hard-redirects on any 401 whose
  code is not `INVALID_CREDENTIALS`, which would throw the parent off the
  screen holding their one-time code. Everything is 400/409/422/429/502.
- **Every flow must end with a password we can store.** The sixteen sync crons
  re-login by decrypting a stored credential, so a sign-in that leaves us
  without one produces a working session and no background updates at all.
  That is why MFA verify takes a password Mashov itself rejects, and why the
  first sign-in per school cannot be passwordless.
- **Recovery must not become an ID-number oracle.** `POST /credential-recoveries`
  answers an identical 202 for an unknown national ID as for a real one and
  marks the fabricated handle `poisoned`. The response is indistinguishable;
  the server log is not, which is a distinction the first implementation got
  wrong in the other direction (ADR-0042 §11).

Passwordless sign-in by one-time code is built, served and switched off at the
UI (`frontend/src/lib/featureFlags.ts`): its upstream contract was read from
Mashov's Angular bundle rather than observed, and Mashov refuses it in
production.

### Cron Schedule

| Source | Cron Expression | Cadence |
|--------|----------------|---------|
| Notifications | `*/5 * * * *` | Every 5 min |
| Mail unread count | `*/5 * * * *` | Every 5 min |
| Inbox conversations | `*/7 * * * *` | Every 7 min |
| Per-child homework | `*/12 * * * *` | Every 12 min |
| Per-child behavior | `*/12 * * * *` | Every 12 min |
| Per-child groups | `0 6 * * *` | Daily at 06:00 |
| Per-child lessonsCount | `0 6 * * *` | Daily at 06:00 |
| Per-child messageBoard | `0 6 * * *` | Daily at 06:00 |
| Achvas reference | `0 6 * * *` | Daily at 06:00 |
| User details | `0 6 * * *` | Daily at 06:00 |
| Mail recipients | `0 7 * * *` | Daily at 07:00 |
| Per-child timetable | `0 3 * * 0` | Weekly on Sunday at 03:00 |

### Partial Failure Resilience

- Each source runs independently inside a try/catch
- `sync_run` record is written for every attempt: `success` | `failed` | `partial`
- A failing source does not abort other sources in the same cycle
- Retry: up to 3 exponential-backoff retries for transient network errors
- Session expiry (401/403) triggers re-auth before retry; counted as one retry

### Freshness Model

| Source group | Stale threshold |
|---|---|
| Notifications, mail count, inbox | 15 minutes |
| Homework, behavior | 24 hours |
| Groups, lessonsCount, achvas, user details, messageBoard | 7 days |

Freshness is computed from the latest successful `sync_run.endedAt` per source. App shell state: `fresh` / `syncing` / `stale` / `degraded`.

### Deduplication Keys

| Entity | Primary key | Fallback |
|---|---|---|
| homework_item | `(studentGuid, lessonId)` | `(studentGuid, groupId, lessonDate, lesson, homeworkText hash)` |
| behavior_item | `(studentGuid, lessonId, eventCode)` | `(studentGuid, lessonDate, lesson, subject, eventCode)` |
| notification_event (with id) | `upstreamNotificationId` | — |
| notification_event (eventType 16) | `fingerprint` = hash of `(userId, eventType, date(eventTime))` | — |
| mail_conversation | `conversationId` | — |
| mail_message | `messageId` | — |
| message_board_item | `(studentGuid, eventId)` | — |
| timetable_entry | `(studentGuid, day, lesson)` | — |

---

## Key Design Decisions

### 1. NestJS over Fastify
Chosen for this project because:
- Built-in DI container makes the multi-service sync architecture clean (SessionService injected into every sync task)
- `@nestjs/schedule` provides first-class cron support without an external process
- Modular structure maps 1:1 to the domain model (ChildrenModule, MailModule, etc.)
- Decorators for controllers keep route code concise
- Trade-off: slightly heavier than Fastify; acceptable at this data scale

### 2. Redis (Phase 2, conditional)
Phase 1 had no Redis (correct for that workload). Phase 2 justifies Redis on two concrete grounds:
- Session validation cache: every API request now validates a session cookie; frontend polls every 3s; Redis cache-aside (5 min TTL) eliminates DB round-trip on the hot path
- Rate-limit counters: failed login attempts stored as TTL-keyed Redis keys — survives restarts, no DB writes on each request
Redis is **not** a data cache. PostgreSQL remains source of truth. See ADR-0017.

### 3. Next.js 15 (App Router) over Vite
Justified by PRD spec and:
- SSR for initial page load speed on mobile (< 2s warm load)
- App Router layouts enable shared navigation shell without re-renders
- Built-in Image optimization for avatars/icons
- Easier to add Phase 2 server-side auth flows (middleware, server actions)

### 4. Prisma over raw SQL
Justified by schema complexity (15 tables, many jsonb columns, composite unique constraints) and TypeScript type safety. Generated types flow from schema to API responses without duplication.

### 5. Phase 1 = no app auth
Household deployment only. All API endpoints are unauthenticated in Phase 1. Backend credentials are env-var configured, never exposed to frontend.

---

## Task List

Tasks are ordered by dependency. Each task is scoped for a single agent session.

### Infrastructure [Pre-requisite]

1. **[MVP]** Create project structure: `backend/`, `frontend/`, `tests/`, `docs/`, `.github/workflows/`
2. **[MVP]** Write `docker-compose.yml` with services: `db` (postgres:16-alpine), `backend`, `frontend`; health checks on all services; named volume for DB
3. **[MVP]** Write `docker-compose.override.yml` with source volume mounts and hot-reload commands for backend (`tsx watch`) and frontend (`next dev`)
4. **[MVP]** Write `.env.example` with all required variables: `DATABASE_URL`, `MASHOV_SEMEL`, `MASHOV_USERNAME`, `MASHOV_PASSWORD`, `MASHOV_BASE_URL`, `NODE_ENV`, `PORT`. `MASHOV_YEAR` is optional and is *not* the year in scope — it is the earliest year to fetch; the current year is resolved from upstream ([ADR-0025](adr/0025-school-year-history-window.md)).
5. **[MVP]** Write `README.md` with: setup steps, env vars, `docker compose up`, test commands, hot reload instructions, port map

### Backend — Foundation

6. **[MVP]** Scaffold NestJS project in `backend/`: TypeScript strict mode, ESLint, `@nestjs/schedule`, `@nestjs/config`, `prisma`, `axios`
7. **[MVP]** Write `prisma/schema.prisma` with all 14 tables from PRD schema section (all field names, types, unique constraints, jsonb fields as `Json`)
8. **[MVP]** Run initial Prisma migration; confirm schema applies cleanly
9. **[MVP]** Create `PrismaModule` (global) and wire into `AppModule`
10. **[MVP]** Create `HealthModule`: `GET /health` — DB ping via `prisma.$queryRaw('SELECT 1')`, return `{ status: "ok" | "degraded" }`

### Backend — Session Management

11. **[MVP]** Create `SessionModule` / `MashovSessionService`:
    - `bootstrap()`: GET login page, extract `X-Csrf-Token` from response headers
    - `login()`: POST `/api/login` with credentials + CSRF token; store cookies in memory
    - `getAuthHeaders()`: return `{ Cookie, X-Csrf-Token }` for upstream requests
    - `refreshIfExpired()`: detect 401/403, re-run bootstrap + login
    - `parseAndPersistChildren()`: upsert `student` records from `accessToken.children[]`
    - `parseAndPersistHousehold()`: upsert `household_connection` + `parent_profile` basics from login response
12. **[MVP]** Create `MashovHttpClient`: axios instance that injects auth headers on every request; handles 401/403 by calling `SessionService.refreshIfExpired()` and retrying once

### Backend — Sync Engine

13. **[MVP]** Create `SyncModule` / `SyncRunService`: helpers to open/close `sync_run` records; `getSyncHealth()` per source
14. **[MVP]** Create `NotificationSyncTask` (cron `*/5 * * * *`): fetch `GET /api/user/notifications?skip=0&take=50`; upsert `notification_event` records with fingerprint logic for eventType 16
15. **[MVP]** Create `MailCountSyncTask` (cron `*/5 * * * *`): fetch `GET /api/mail/counts?$select=unreadConversations`; store in `mail_conversation` aggregate or a dedicated small table (consider `household_connection.cachedUnreadCount`)
16. **[MVP]** Create `InboxSyncTask` (cron `*/7 * * * *`): fetch `GET /api/mail/inbox/conversations?skip=0&take=50`; upsert `mail_conversation` + `mail_message` (preview, no body)
17. **[MVP]** Create `HomeworkSyncTask` (cron `*/12 * * * *`): for each active student, fetch `GET /api/students/{childGuid}/homework`; upsert `homework_item`
18. **[MVP]** Create `BehaviorSyncTask` (cron `*/12 * * * *`): for each active student, fetch `GET /api/students/{studentGuid}/behave`; upsert `behavior_item` using `(studentGuid, lessonId, eventCode)` key
19. **[MVP]** Create `DailyGroupsTask` (cron `0 6 * * *`): for each active student, fetch `GET /api/students/{studentId}/groups`; upsert `subject_enrollment` (groups side)
20. **[MVP]** Create `DailyLessonsCountTask` (cron `0 6 * * *`): for each active student, fetch `GET /api/students/{studentGuid}/lessonsCount`; merge `weeklyHours` + `lessonsCount` into `subject_enrollment`
21. **[MVP]** Create `DailyMessageBoardTask` (cron `0 6 * * *`): for each active student, fetch `GET /api/students/{childGuid}/messageBoard`; upsert `message_board_item`; sanitize `eventtext` HTML with `isomorphic-dompurify` or `sanitize-html`
22. **[MVP]** Create `DailyAchvasTask` (cron `0 6 * * *`): fetch `GET /api/achvas`; upsert `behavior_type_reference`
23. **[MVP]** Create `DailyUserDetailsTask` (cron `0 6 * * *`): fetch `GET /api/user/details`; upsert `parent_profile`
24. **[MVP]** Create `SyncModule.triggerManualSync()`: fan out all sync tasks sequentially; used by `POST /api/sync/refresh`
25. **[NICE]** Create `DailyBehaveSyncTask` (feature-flagged via `ENABLE_DAILY_BEHAVE=true` env var): same shape as BehaviorSyncTask but calls `/dailyBehave`
26. **[NICE]** Create `OutBehaveSyncTask` (feature-flagged): calls `/outBehave`

### Backend — API Controllers

27. **[MVP]** Create `DashboardController`: `GET /api/v1/dashboard` — assemble summary strip, needs-attention list, feed, child cards, freshness state
28. **[MVP]** Create `FeedController`: `GET /api/v1/feed` — paginated reverse-chron feed across all children
29. **[MVP]** Create `ChildrenController`:
    - `GET /api/v1/children`
    - `GET /api/v1/children/:studentGuid`
30. **[MVP]** Create `ChildrenController` sub-routes:
    - `GET /api/v1/children/:studentGuid/homework`
    - `GET /api/v1/children/:studentGuid/behavior`
    - `GET /api/v1/children/:studentGuid/subjects`
    - `GET /api/v1/children/:studentGuid/notices`
31. **[MVP]** Create `MailController`:
    - `GET /api/v1/mail/summary`
    - `GET /api/v1/mail/conversations`
    - `GET /api/v1/mail/conversations/:id` — lazily fetch full message from upstream if `bodyHtmlSanitized` is null
32. **[MVP]** Create `MailActionController`:
    - `PUT /api/v1/mail/conversations/mark-unread` — proxy to upstream `PUT /api/mail/conversations/markAsUnread`
    - `PUT /api/v1/mail/conversations/archive` — proxy to upstream `PUT /api/mail/conversations/move/archive`
33. **[MVP]** Create `SettingsController`:
    - `GET /api/v1/settings/source-health`
    - `GET /api/v1/settings/profile`
34. ~~**[MVP]** Create `ReadStateController`: `POST /api/v1/read-state`~~ — **Superseded:** Read/handled state is managed via `isNew`/`isArchived` mutation endpoints directly on homework and behavior items. No separate read_state table.
35. **[MVP]** Create `SyncController`: `POST /api/v1/sync/refresh` — trigger manual sync
36. **[MVP]** Create `TimetableTask` (cron `0 3 * * 0`): for each active student, fetch `GET /api/students/{studentGuid}/timetable`; upsert `timetable_entry` with `(studentGuid, day, lesson)` key — **Implemented (Phase 1 extension)**

### Backend — Services and Query Logic

36. **[MVP]** `DashboardService.getSummary()`: query counts — unread conversations (from latest mail_conversation), homework in last 7 days, behavior in last 7 days, active student count
37. **[MVP]** `DashboardService.getNeedsAttention()`: priority-ordered list — unread convos > recent negative behavior > recent unhandled homework > sync degradation
38. **[MVP]** `DashboardService.getFeed()`: join notification_event + mail_conversation + homework_item + behavior_item; sort by `eventAt` desc; enrich with read_state; limit 20
39. **[MVP]** `FreshnessService`: compute per-source freshness from latest `sync_run`; derive app-shell state
40. **[MVP]** `BehaviorClassificationService`: map `achvaCode` → bucket (Attention / Positive / Neutral) and priority using `behavior_type_reference`; configurable in code

### Frontend — Foundation

41. **[MVP]** Scaffold Next.js 15 project in `frontend/`: TypeScript strict mode, Tailwind CSS, shadcn/ui init, TanStack Query provider, `dir="rtl"` on `<html>`, Hebrew font (Assistant, self-hosted from `frontend/src/assets/fonts/` — see ADR-0043)
42. **[MVP]** Create `frontend/src/api/` layer: typed fetch wrappers for each internal API endpoint (one file per resource: `dashboard.ts`, `children.ts`, `mail.ts`, `settings.ts`, `readState.ts`, `sync.ts`)
43. **[MVP]** Create `frontend/src/types/api.ts`: TypeScript interfaces for all API response shapes
44. **[MVP]** Create shared layout: bottom navigation bar (Home / Children / Inbox / More), header strip with sync status; wrap each route in `ErrorBoundary`
45. **[MVP]** Create shared components: `FreshnessIndicator`, `LoadingState`, `ErrorState`, `EmptyState`, `StatusChip`, `CategoryBadge`

### Frontend — Home Screen

46. **[MVP]** Build `HomePage` (`/`): `useDashboard()` hook with TanStack Query; render header, summary strip, needs-attention section, feed, child quick cards
47. **[MVP]** Build `SummaryStrip`: 4 chips (unread mail, recent homework, recent behavior, children count); skeleton loader
48. **[MVP]** Build `NeedsAttentionSection`: max 5 cards with "See all" link; priority order from API; each card has title, child name, timestamp, tap target
49. **[MVP]** Build `LatestUpdatesFeed`: reverse-chron feed items; type badge, title, summary, child name, timestamp, visual state (new/handled/neutral); "Mark handled" quick action
50. **[MVP]** Build `ChildQuickCard`: name, class code/num, latest update time, recent count, one-line status, tap link to child workspace

### Frontend — Children Screen

51. **[MVP]** Build `ChildrenPage` (`/children`): list of `ChildCard` components; each shows name, class, counts, one-tap to workspace
52. **[MVP]** Build `ChildCard` component with data-testid attributes

### Frontend — Child Workspace

53. **[MVP]** Build `ChildWorkspacePage` (`/children/[studentGuid]`): fetch child overview; render header, overview chips, tabbed/anchored sections
54. **[MVP]** Build `HomeworkSection`: list of homework items; per-item: date, subject, text, remark, file indicator, handled toggle
55. **[MVP]** Build `BehaviorSection`: list of behavior items; tabs All/Attention/Positive/Other; per-item: achvaName, bucket badge, date, lesson, subject, reporter, remark (suppress "ללא הערות"); justifiable badge
56. **[MVP]** Build `SubjectsSection`: per row: subject name, group name, active teacher(s), weekly hours, lessons held
57. **[MVP]** Build `NoticesSection`: render sanitized HTML cards for non-expired message board items

### Frontend — Inbox

58. **[MVP]** Build `InboxPage` (`/inbox`): paginated conversation list; unread count badge; per item: sender, subject, time (relative + exact), unread styling, attachment indicator, reply-disabled indicator
59. **[MVP]** Build load-more pagination; optional unread-only filter
60. **[MVP]** Implement mark-unread action (checkbox + bulk action) and archive action per conversation

### Frontend — Conversation Detail

61. **[MVP]** Build `ConversationDetailPage` (`/inbox/[conversationId]`): lazy-fetch on open; render sanitized HTML body with DOMPurify; show sender, time, recipients summary; reply-disabled state; local handled toggle
62. **[MVP]** Integrate `isomorphic-dompurify` (or `dompurify` via CDN-free import) for client-side HTML sanitization before render

### Frontend — More / Settings

63. **[MVP]** Build `MorePage` (`/more`): last sync time by source, freshness status, school name + year, parent contact info (read-only), app version, clear read state action
64. **[MVP]** Build `SourceHealthTable` component: per source: name, last sync time, status badge (fresh/stale/failed)
65. **[NICE]** Build `SyncHistoryList`: last N sync_run records per source for diagnostics

### QA — Tests

66. **[MVP]** Write unit tests for `BehaviorClassificationService` (all bucket mappings, unknown code fallback)
67. **[MVP]** Write unit tests for `FreshnessService` (threshold logic for each source group)
68. **[MVP]** Write unit tests for deduplication fingerprint logic in notification sync
69. **[MVP]** Write integration tests for all API endpoints (use real Postgres in CI; mock upstream Mashov calls): 200 responses, pagination, empty states, 404 on missing child
70. **[MVP]** Write integration test for `POST /api/v1/sync/refresh` — verify sync_run records created
71. **[MVP]** Write E2E tests (Playwright) for: Home renders summary strip and feed; Child workspace opens from Home; Inbox loads and opens a conversation; mark handled persists; mark-unread/archive actions fire correctly
72. **[NICE]** Write E2E test for freshness indicator state transitions

### CI

73. **[MVP]** Write `.github/workflows/ci.yml`: lint → unit-test → integration-test → e2e → build (per CI rules)

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Upstream Mashov API changes (field names, auth flow) | Medium | High | Raw payload stored in `rawPayload` jsonb on every table; adapter layer isolated in sync tasks |
| CSRF token extraction changes (different header name) | Low | High | Isolate CSRF extraction in `SessionService.bootstrap()`; add logging for raw response headers on auth failure |
| Rate limiting from Mashov | Medium | Medium | Conservative cron cadence; single shared session; retry with exponential backoff; sync_run failure logged |
| Session cookie expiry mid-sync | Medium | Medium | `MashovHttpClient` detects 401/403 on every request, triggers re-auth, retries once |
| Large homework/behavior history payload performance | Low | Low | Full history returned per call; PostgreSQL upsert is fast; index on `(studentGuid, lessonId)` |
| HTML injection via upstream message bodies | High (certainty) | High | `sanitize-html` / `isomorphic-dompurify` applied server-side before storing `bodyHtmlSanitized`; never render raw body |
| NestJS process crash takes down cron | Low | Medium | Docker restart policy `unless-stopped`; health check triggers restart |
| Prisma connection pool exhaustion under sync load | Low | Medium | `prisma.$disconnect()` not needed with global singleton; configure `connection_limit` in DATABASE_URL |
| Docker build fails on ARM (Apple Silicon dev, AMD CI) | Medium | Low | Pin `node:22-alpine` images; use `--platform linux/amd64` in CI if needed |

---

## Open Questions

| # | Question | Impact | Owner |
|---|----------|--------|-------|
| 1 | Does `GET /api/mail/conversations/:id` fetch from DB or proxy upstream in real time? | Architecture of lazy-fetch path | Backend |
| 2 | Should `PUT mark-unread` and `PUT archive` also update local DB state immediately (optimistic) or only after next sync? | UX consistency | Backend/Frontend |
| 3 | Is `behavior_item.lessonId` reliably unique per `(studentGuid, eventCode)`, or can one lesson have multiple eventCode 2 entries? | Deduplication correctness | Backend |
| 4 | `mail_message` — the inbox list sync only provides message metadata (no body). When `GET /conversations/:id` is called, should the body be fetched from upstream and stored, or served fresh on every open? | Storage vs. freshness | Backend |
| 5 | Timezone handling for `notification_event.eventAt`: naive timestamps are school-local time. Is Israel always UTC+2 (standard) or UTC+3 (DST)? Need confirmed timezone identifier for correct ISO storage. | Data integrity | Backend |
| 6 | `household_connection.encryptedPassword` — what encryption scheme? AES-256-GCM with `ENCRYPTION_KEY` env var is the recommended approach, but needs confirmation before implementation. | Security | Backend |

---

---

# Phase 2: Authentication & Multi-Household

**PRD source:** `docs/prd/PRD-current.md` (v2, 2026-03-16)
**Phase scope:** Auth, per-user data scoping, multi-household isolation

---

## Phase 2 Scope

### In scope
- Parent authentication via direct Mashov credential login (school selected from list + username + password)
- Server-side DB session management (`app_session` table + httpOnly cookie + Redis cache-aside)
- Per-user read/archive state via normalized `user_item_state` table
- Multi-household sync isolation (each `sync_run` keyed to `householdConnectionId`)
- Phase 1 → Phase 2 data migration (migrate `isNew`/`isArchived` columns → `user_item_state`)
- Next.js middleware for route protection (redirect unauthenticated to `/auth/sign-in`)
- Settings page additions: show connected school, update/disconnect credentials, sign out

### Out of scope (Phase 2)
- OAuth / social sign-in
- Multiple school connections per user
- Admin user management UI
- Account deletion UI (only `DELETE /api/v1/connection` for data removal)

---

## Phase 2 Architecture Changes

### New NestJS Modules

| Module | Responsibility |
|--------|---------------|
| `AuthModule` | Mashov credential validation (`POST /api/login`), school list fetch, session creation on login |
| `AppSessionModule` | Session middleware (validate cookie on every request via Redis cache-aside + DB), `SessionGuard` for protected routes |
| `ConnectionModule` | School credential management: update, disconnect; AES-256-GCM encryption |
| `RedisModule` | Redis client (session cache, rate-limit counters); global singleton |

> **Rename**: existing `SessionModule` (Mashov upstream session) → `MashovSessionModule` to avoid naming conflict with the new app session module.

### New Frontend Routes / Pages

| Route | Page | Notes |
|-------|------|-------|
| `/auth/sign-in` | Mashov credential login | School selector (from `/api/schools`) + username + password; single generic error on failure |
| `/auth/syncing` | Sync progress screen | Polls `GET /api/v1/sync/status` every 2s; shown after first successful login. Three independent exits: `done` from the poll, the `POST /sync/refresh` promise resolving, and a 120s hard cap — it cannot hang on any one of them failing |

Next.js `middleware.ts` at root: reads session cookie, calls backend `/api/v1/auth/me` (or lightweight session-check), redirects unauthenticated requests to `/auth/sign-in?next=<original-path>`.

### Database Schema Changes

#### New Tables

```prisma
model AppUser {
  id            String   @id @default(uuid())
  mashovUserId  String   @unique   // credential.userId from Mashov login response
  semel         Int
  username      String
  displayName   String             // credential.displayName from Mashov response
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  sessions      AppSession[]
  connections   HouseholdConnection[]
}

model AppSession {
  id             String    @id @default(uuid())
  userId         String
  sessionToken   String    @unique  // crypto.randomBytes(32).toString('hex')
  expiresAt      DateTime
  lastActivityAt DateTime
  revokedAt      DateTime?
  createdAt      DateTime  @default(now())
  user           AppUser   @relation(fields: [userId], references: [id])
  @@index([sessionToken])
}

model UserItemState {
  id         String   @id @default(uuid())
  userId     String
  itemType   String   // "homework" | "behavior" | "mail_conversation"
  itemId     String
  isNew      Boolean  @default(true)
  isArchived Boolean  @default(false)
  updatedAt  DateTime @updatedAt
  @@unique([userId, itemType, itemId])
}
```

#### Modified Tables

- `HouseholdConnection`: add `userId String` FK → `AppUser.id` (nullable during migration, required after)
- `HomeworkItem`: drop `isNew`, `isArchived` columns
- `BehaviorItem`: drop `isNew`, `isArchived` columns
- `MailConversation`: drop `isNew` column

### Session Middleware Flow

```
Incoming request (Next.js middleware.ts)
  → Read session cookie
  → If no cookie: redirect to /auth/sign-in?next=<path>
  → Forward cookie to NestJS
NestJS AppSessionGuard (applied globally to all /api/v1/* routes)
  → Redis GET session:<token>
    HIT  → attach userId, continue (no DB hit)
    MISS → DB SELECT * FROM app_session WHERE sessionToken = $1 AND revokedAt IS NULL
             VALID   → Redis SET session:<token> EX 300 → attach userId, continue
             INVALID → Redis DEL session:<token> (if stale) → return 401
  → On valid request: Redis EXPIRE session:<token> 300 (rolling TTL)
    DB UPDATE lastActivityAt debounced to max once per 60s
  → On logout: DB UPDATE revokedAt + Redis DEL session:<token>
```

### Multi-Household Sync Changes

- All cron tasks loop over `SELECT * FROM household_connection WHERE userId IS NOT NULL`
- Each iteration runs the full source sync for that connection's credentials
- `sync_run` records include `householdConnectionId` FK
- `POST /api/v1/sync/refresh` triggers sync only for the authenticated user's connection
- `GET /api/v1/settings/source-health` scoped to authenticated user's connection

### Email Transport

Configurable at startup — exactly one of:
- SMTP via Nodemailer: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- Resend API: `RESEND_API_KEY`

`MagicLinkService.sendMagicLink(email, token)` dispatches via whichever transport is configured. Magic-link URL: `${APP_URL}/auth/verify?token=<raw_token>`.

---

## Phase 2 Task List

### Backend — Auth Foundation

1. **[MVP]** Rename `SessionModule` → `MashovSessionModule`; update all imports
2. **[MVP]** Add Prisma migration: create `app_user` (mashovUserId, semel, username, displayName), `app_session`, `user_item_state` tables; add `userId` FK to `household_connection`; no `magic_link_token` table
3. **[MVP]** Create `RedisModule`: global `ioredis` client; exposes `get`, `set`, `del`, `expire` helpers; configured via `REDIS_URL` env var
4. **[MVP]** Create `AppSessionModule`: `AppSessionService` with `createSession()`, `validateSession()` (Redis cache-aside + DB), `revokeSession()` (DB + Redis DEL), `revokeAllSessionsForUser()`, `cleanupExpiredSessions()`; `AppSessionGuard` applied globally; session cookie middleware; rolling TTL debounced to 60s DB writes
5. **[MVP]** Create `AuthModule` / `AuthController`: `POST /api/v1/auth/login` (validate against Mashov API, upsert `app_user`, create session, redirect to `/auth/syncing` on first login), `DELETE /api/v1/auth/session`, `GET /api/v1/auth/me`; rate limiting on login endpoint (5 failed attempts/IP/15min via Redis)
6. **[MVP]** Create `ConnectionModule` / `ConnectionController`: `PUT /api/v1/connection`, `DELETE /api/v1/connection`; AES-256-GCM credential encryption using `CREDENTIAL_ENCRYPTION_KEY` env var; `POST /api/v1/connection` is implicit at login (first-time connection created from Mashov login response)
7. **[MVP]** Update `SyncController`: `GET /api/v1/sync/status` (for polling from `/auth/syncing`, backed by the per-connection refresh envelope in Redis rather than a `sync_run` count); scope `POST /api/v1/sync/refresh` to authenticated user's connection
8. **[MVP]** Apply `AppSessionGuard` globally — all `/api/v1/*` routes require valid session cookie except `POST /api/v1/auth/login`, `/health`

### Backend — Data Migration

9. **[MVP]** Write Phase 2 migration script (`scripts/migrate-phase2.ts` or Prisma migration): on first login, reassign existing `household_connection` to the newly created `app_user`; copy `homework_item.isNew/isArchived`, `behavior_item.isNew/isArchived`, `mail_conversation.isNew` → `user_item_state` rows, drop source columns; register as `npm run migrate:phase2`
10. **[MVP]** Update all service layer methods that read/write `isNew`/`isArchived` to read from/write to `user_item_state` via `userId` from session context

### Backend — Multi-Household Sync

11. **[MVP]** Update all cron sync tasks to loop over active `household_connection` records; pass `householdConnectionId` and credentials to each sync invocation; ensure failure isolation per connection
12. **[MVP]** Add cleanup cron (`0 2 * * *`): purge `app_session` rows where `revokedAt IS NOT NULL AND revokedAt < NOW() - INTERVAL 7 days`; purge `magic_link_token` rows where `expiresAt < NOW() - INTERVAL 24 hours`

### Frontend — Auth Pages

13. **[MVP]** Create Next.js `middleware.ts`: read session cookie, call `GET /api/v1/auth/me`, redirect unauthenticated requests to `/auth/sign-in?next=<path>`; exclude `/auth/*` routes from protection
14. **[MVP]** Build `/auth/sign-in` page: fetch school list from Mashov `/api/schools` on load; render school selector (search/autocomplete) + username + password + submit → `POST /api/v1/auth/login`; on success redirect to `/auth/syncing` (first login) or Home (returning user); show single generic error message on failure ("Invalid credentials, please try again"); minimalistic design matching app style
15. **[MVP]** Build `/auth/syncing` page: "Setting up your account…" progress screen; poll `GET /api/v1/sync/status` every 2s; show "N / M sources complete" plus the task in flight; leave for Home on `done: true`, on the refresh request resolving, or at the hard cap; skip button after 10s
16. **[MVP]** Update Settings page (`/more`): add connected school name + year (read-only), "Update credentials" inline form, "Disconnect account" confirmation modal, "Sign out" button
17. **[MVP]** Add app shell auth UI: show user `displayName` or initials in header; handle 401 responses with toast "Session expired — sign in again" + redirect to `/auth/sign-in`

### QA — Phase 2 Tests

20. **[MVP]** Integration tests: login flow (valid credentials → session created; invalid credentials → 401; rate limit after 5 failures); session validation (valid/revoked/expired, Redis cache hit and miss paths); connection update/delete; user isolation (two users, same item, independent state)
21. **[MVP]** Integration test: Phase 1 → Phase 2 migration script — confirm `user_item_state` rows match original column values
22. **[MVP]** E2E (Playwright): full login → sync-progress → Home flow; sign-out; session-protected route redirect; credential update flow

---

## Phase 2 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Migration script data loss | Low | Critical | Test against Phase 1 DB snapshot; run in transaction; verify row counts before committing |
| Mashov API downtime blocks login | Low | High | Existing sessions remain valid (DB + Redis); only new logins blocked; display "School portal unavailable" error |
| Mashov changes login API shape | Low | High | Login adapter isolated in `AuthModule`; raw response logged for debugging |
| Session cookie not sent cross-origin | Medium | High | Confirm Next.js proxy config routes all `/api/v1/*` through backend; SameSite=Strict only safe with same-origin |
| Redis restart invalidates all session cache | Low | Low | All clients transparently re-validate against DB on next request; no data loss |
| AES key rotation breaks existing sessions | Low | Medium | `credentials:rotate` CLI script re-encrypts all connections atomically |
| Sync loop failure hides auth bugs | Low | Medium | Each cron task has explicit `try/catch` per connection; `sync_run` record logs failure |
