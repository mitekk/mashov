# PRD: School Parent Command Center (Mashov) — v1

**Date:** 2026-03-11
**Status:** Active
**Supersedes:** v0 placeholder

---

## Overview

A modern, mobile-first household command center built on top of the Mashov school API (`web.mashov.info`). It gives a busy Israeli parent one clear, calming briefing screen: what changed across all their children, which child needs attention, and what school messages are waiting. The app is a **summary-and-triage layer**, not a rebuild of the school portal. Value is created through cross-child aggregation, strong prioritization, and low-friction reading. Phase 1 is a private household deployment with no app-level authentication. Phase 2 adds proper parent sign-in and multi-household support.

---

## Problem Statement

Parents with children in Israeli schools using the Mashov system must repeatedly log in to a complex legacy web portal, navigate between sections, switch child context manually, and mentally assemble "what changed" from multiple separate screens. The cognitive cost of staying informed is disproportionately high for what is usually a 30-second check. This app removes that burden.

---

## Users & Roles

### Phase 1

- **Household user (implicit):** Single server-configured credential set. No login UI. The backend holds the upstream school credentials and syncs data into PostgreSQL. All read/handled state is household-global.
- Deployment is private/internal only. Not for public access.

### Phase 2

- **Parent (authenticated):** Signs in via email magic-link, connects their school account, views their own children's data. State is user-scoped.
- Multiple households can safely coexist in the same deployment.

---

## Functional Requirements

### Authentication & Bootstrap

- FR-1: Backend authenticates against `POST /api/login` using server-configured credentials (`semel`, `year`, `username`, `password`).
- FR-2: CSRF token is acquired by making an initial GET request to the Mashov web app (e.g. the login page). The `X-Csrf-Token` value is returned in the response headers of that request. This token is then included in the `X-Csrf-Token` header of `POST /api/login`.
- FR-3: After successful login, the upstream server sets three cookies: `Csrf-Token`, `MashovAuthToken`, `uniquId`. All subsequent authenticated requests must include the `X-Csrf-Token` header (using the session token) and carry these cookies.
- FR-4: Backend maintains session cookies and re-authenticates on session expiry, repeating the CSRF bootstrap flow.
- FR-5: Children are discovered from `accessToken.children[]` in the login response and persisted. Each child record includes `childGuid`, `familyName`, `privateName`, `classCode`, `classNum`, `gender`, `groups[]`, `isActive`.
- FR-6: School name, year, and settings are stored from `accessToken.schoolSettings` in the login response.
- FR-7: Backend **never** exposes upstream tokens, cookies, or credentials to the frontend or to logs.

### Sync Engine

- FR-8: Backend syncs data on a scheduled cadence and serves cached data immediately to the frontend. Sync order and cadence:

| Source | Endpoint | Cadence |
|--------|----------|---------|
| Notifications | `GET /api/user/notifications?skip=0&take=50` | Every 5 min |
| Unread mail count | `GET /api/mail/counts?$select=unreadConversations` | Every 5 min |
| Inbox list | `GET /api/mail/inbox/conversations?skip=0&take=50` | Every 5–10 min |
| Per-child homework | `GET /api/students/{childGuid}/homework` | Every 10–15 min |
| Per-child behavior | `GET /api/students/{childGuid}/behave` | Every 10–15 min |
| Per-child groups | `GET /api/students/{studentId}/groups` | Daily |
| Per-child lessons count | `GET /api/students/{studentGuid}/lessonsCount` | Daily |
| Per-child message board | `GET /api/students/{childGuid}/messageBoard` | Daily |
| Achvas reference | `GET /api/achvas` | Daily |
| User details | `GET /api/user/details` | Daily |
| Mail recipients (optional) | `GET /api/mail/recipients` | Daily |
| Daily behavior (feature-flagged) | `GET /api/students/{childGuid}/dailyBehave` | Low-frequency |
| Out-of-school behavior (feature-flagged) | `GET /api/students/{studentId}/outBehave` | Low-frequency |

- FR-9: Homework and behavior endpoints return full history on every call — no pagination needed. Store with upsert semantics.
- FR-10: One source failing must not break the rest of the dashboard. Partial failures are tracked per source.
- FR-11: Manual refresh is available globally and triggers a full sync cycle.
- FR-12: Each sync attempt is logged in a `sync_run` table: `source`, `status`, `startedAt`, `endedAt`, `fetchedCount`, `errorMessage`.

### Freshness Model

- FR-13: Freshness thresholds:
  - Primary sources (notifications, mail count, inbox): stale after 15 minutes
  - Child history (homework, behavior): stale after 24 hours
  - Reference data (achvas, groups, lessonsCount, user details): stale after 7 days
- FR-14: When stale, the app still renders cached data. The UI shows a calm, non-alarming freshness indicator.
- FR-15: App shell always shows one of four states: `fresh` / `syncing` / `stale` / `degraded`.

### Notifications & Feed Normalization

- FR-16: All sources are normalized into a canonical internal update model with fields:
  - `id`, `sourceType`, `sourceId`, `studentGuid` (nullable), `studentName` (nullable), `title`, `summary`, `bodyHtml` (nullable), `category`, `subcategory`, `priority`, `isPositive`, `isUnread`, `isHandledLocally`, `eventAt`, `syncedAt`, `rawPayload`
- FR-17: Notification `eventData` field (JSON string) is parsed and stored as structured data.
- FR-18: Deduplication rules:
  - **Homework:** `studentGuid + lessonId` as primary key; fallback `studentGuid + groupId + lessonDate + lesson + homework hash`
  - **Behavior:** `studentGuid + lessonId + eventCode` as primary key; fallback `studentGuid + lessonDate + lesson + subject + eventCode`
  - **Mail summary (eventType 16):** Treat as metadata signal, not a repeating feed item. Source of truth for unread count is `mail/counts`.
  - **Conversations:** Deduplicate by `conversationId`; messages by `messageId`
- FR-19: Notifications without a stable numeric `id` (e.g. eventType 16) use a composite fingerprint for deduplication.
- FR-20: All timestamps are normalized to a single timezone-aware representation. Naive/local timestamps (confirmed to be consistent) are treated using the school/user timezone. Timezone-offset timestamps (`+02:00`) are stored as UTC.

### Home Screen

- FR-21: Home is the first screen. It answers "anything important?" without switching tabs or choosing a child first.
- FR-22: **Header strip** — shows: household/product title, current date, last successful sync time, refresh action, subtle freshness status indicator.
- FR-23: **Summary strip** — compact chips showing:
  - Unread conversations count (source: `mail/counts` — authoritative)
  - Recent homework count (last 7 days)
  - Recent behavior/attendance count (last 7 days)
  - Number of children in the household
- FR-24: **Needs-attention section** — max 3–5 cards before "See all", prioritized:
  1. Unread school conversations
  2. Recent negative behavior/attendance events (last 7 days)
  3. Recent homework not locally handled (last 7 days)
  4. Sync degradation (only when it affects trust in freshness)

  Each card shows: title, child name (when applicable), timestamp, one clear tap target. Positive updates must not crowd out urgent items.
- FR-25: **Latest-updates feed** — reverse-chronological mixed feed across all children:
  - Homework notifications (eventType 102)
  - Behavior notifications (eventType 101)
  - Unread conversation activity
  - Positive reinforcement events
  - Optional sync/degradation events when relevant

  Each item shows: type badge, short title, one-line summary, child name (if applicable), timestamp, visual state (new / handled / neutral), optional quick action (open, mark handled).
- FR-26: **Child quick cards** — one card per child showing: name, class code + class number, latest update time, recent update count, concise one-line status, one-tap link to child workspace.
- FR-27: On a common phone viewport, the parent sees the header, summary strip, and first needs-attention items without scrolling.
- FR-28: No horizontal carousels for critical information. No tab switching required before seeing status.

### Children Screen

- FR-29: Lists all children. Each card shows: name, class code/number, latest update time, recent homework count, recent behavior count, optional subject count, one-tap to child workspace.
- FR-30: Cards are easy to compare; urgency lives on Home, not here.

### Child Workspace

- FR-31: Opens in one tap from Home or Children.
- FR-32: **Child header** — name, class code/number, last sync time for this child's data, compact activity summary chips.
- FR-33: **Overview chips** — recent homework count, recent behavior count, subject count, total weekly hours (from `lessonsCount`).
- FR-34: **Child latest timeline** — mixed child-scoped reverse-chronological feed: homework events, behavior events, positive reinforcement. Mail references shown only if a safe child link can be confirmed.
- FR-35: **Recent homework section** — per item: lesson date, subject, homework text, remark/topic (if present), attachment file names (indicator only — no download). Local handled toggle per item.
  - Labels: "Recent homework" or "Latest homework". Never due-date language.
- FR-36: **Behavior and attendance section** — per item: event label (`achvaName`), attention/positive/neutral bucket, lesson date, lesson number (if available), subject, teacher/reporter name, justification text (if meaningful — suppress "ללא הערות" default), optional teacher remark.
  - UI grouping tabs/chips: All / Attention / Positive / Other
  - Show a subtle "Justifiable" badge when `achvas.justifiable = true`
  - Unknown event codes must render safely with original Hebrew label
- FR-37: **Subjects and teachers section** — derived from `groups` (source of truth for subject list) joined with `lessonsCount` by `groupId`. Per row: subject name, group name (if useful), active teacher name(s), weekly hours, lessons held so far. Must not imply a timetable, next lesson, grade, or attendance percentage.
- FR-38: **School notices section** — from `GET /api/students/{childGuid}/messageBoard`. Renders non-expired announcements as read-only HTML cards (sanitized). Fetched per childGuid. Expired announcements (past `expirationDate`) are not shown.
- FR-39: Interaction model: anchored scroll sections or compact segmented control. No deep nested tabs, no sub-pages that hide the overview.
- FR-40: Local mark-handled state is available per homework and behavior item.

### Inbox

- FR-41: Unread count displayed prominently (source: `mail/counts`).
- FR-42: Conversation list sorted by `sendTime` descending. Per item: sender name, subject, time (relative + exact), unread styling, attachment indicator (`hasAttachments`), reply-disabled indicator (`preventReply`).
- FR-43: Load-more pagination using `skip`/`take` against `GET /api/mail/inbox/conversations`.
- FR-44: Optional filter: unread only.
- FR-45: Mailbox scope defaults to **household/school messages** — no faked child mapping.
- FR-46: Parent can **mark a conversation as unread** via `PUT /api/mail/conversations/markAsUnread` (array of conversation UUIDs).
- FR-47: Parent can **archive a conversation** via `PUT /api/mail/conversations/move/archive` (array of conversation UUIDs).

### Conversation Detail

- FR-48: Opens in one tap from Home or Inbox.
- FR-49: Full conversation body fetched **lazily on open** — not pre-fetched during dashboard load.
- FR-50: Message HTML body (`messages[].body`) is sanitized (DOMPurify or equivalent) before rendering.
- FR-51: Shows: sender name, sent time, recipients summary (from `messages[].recipients[].displayName`), attachment presence indicator.
- FR-52: Shows reply-disabled state if `preventReply = true`.
- FR-53: Local handled/read state per conversation.

### Behavior Classification

- FR-54: `achvas` reference is ingested daily and used to classify all behavior events into buckets.
- FR-55: Default classification mapping (configurable in code, not hardcoded in UI):

| Event code | Hebrew label | Default bucket | Default priority |
|---|---|---|---|
| 1 | איחור | Attention | Medium |
| 2 | חיסור | Attention | High |
| 4 | חיזוק חיובי | Positive | Low |
| 5 | אי הכנת ש.ב. | Attention | High |
| 6 | אי הבאת ציוד | Attention | Medium |
| 10 | לא השלים משימה בכיתה | Attention | Medium |
| 11 | חיסור בשל פעילות בית-ספרית | Neutral | Low |
| unknown | original label | Neutral | Low |

- FR-56: `dailyBehave` schema confirmed to mirror `/behave` response shape. Ingestion path must be designed so these sources can be added later without redesign (feature-flagged).

### Local Read/Handled State

- FR-57: Upstream mail `isNew` / unread count drives the badge — stored and respected separately from local state.
- FR-58: Feed handled, homework handled, behavior handled are all local to this app (stored in `read_state` table).
- FR-59: Handled items are visually quieter, not hidden. New items stand out clearly.
- FR-60: "Clear all local handled/read state" action available in More/Settings.
- FR-61: Phase 1: state is household-global. Phase 2: state is user-scoped.

### More / Settings Screen

- FR-62: Shows last successful sync time by source (or global summary).
- FR-63: Shows current freshness/degraded status.
- FR-64: Shows school name and current year (from `schoolSettings`).
- FR-65: Shows parent contact info from `GET /api/user/details` in read-only form (email, cellphone).
- FR-66: Shows app version/build info.
- FR-67: Clear local handled/read state action.
- FR-68: Optional lightweight diagnostics area for internal/private use (sync run history, source health).

### Phase 2 — App Authentication

- FR-69: Parent signs in via email magic-link or equivalent passwordless flow. Session stored in httpOnly, Secure, SameSite=Strict cookie.
- FR-70: Connect-school-account onboarding: parent enters `semel`, `year`, `username`, `password` → backend validates upstream login → stores encrypted credentials.
- FR-71: Data and local state are scoped per authenticated user.
- FR-72: Session management and revocation.
- FR-73: Multiple households safely coexist in the same deployment.
- FR-74: Phase 2 onboarding screens: sign-in → magic-link confirmation → connect-school-account → initial sync progress → dashboard.

---

## Non-Functional Requirements

- **Performance:** Warm dashboard load from cached DB data in < 2 seconds. Refresh must not blank or block existing content. Inbox list stays fast with lazy conversation detail loading.
- **Reliability:** One upstream source failing does not break the app. Last known good data is always shown. Partial failure is visible but calm. Retry logic for transient upstream failures.
- **RTL:** Layouts work naturally in RTL. Hebrew and mixed Hebrew/English text renders correctly everywhere, including long message bodies.
- **Accessibility:** Strong contrast, focus states, keyboard navigation on desktop, screen-reader labels for primary actions, status not conveyed by color alone, touch targets sized for mobile.
- **Observability:** Structured logs, sync history per source in DB, visible last sync timestamps, error monitoring hooks. No secrets or tokens in logs.
- **Privacy:** No secrets in client storage. No upstream credentials in analytics or logs. Minimal PII in logs.
- **Security (Phase 1 baseline):**
  - Upstream credentials stored server-side only, encrypted at rest
  - No credentials or tokens in frontend bundles, localStorage, or logs
  - HTTPS in deployed environments
  - Optional host-layer protection (basic auth or IP allowlist) for private deployment
  - Phase 1 is acceptable for local/household/prototype use — NOT for open public deployment

---

## Tech Constraints

- **Frontend:** React + Next.js + TypeScript + Tailwind CSS + TanStack Query
- **Backend:** NestJS or Fastify-based TypeScript service
- **Database:** PostgreSQL with Prisma ORM
- **Background jobs:** Cron or queue worker for sync cadence
- **Infrastructure:** Docker Compose (dev + production)
- **HTML sanitization:** DOMPurify or equivalent — required before rendering any upstream HTML content (mail bodies, message board)
- **Auth (Phase 2):** Email magic-link or passkey; httpOnly session cookies; never localStorage
- **Upstream API base:** `https://web.mashov.info/api`
- **Frontend must never call upstream APIs directly** — all data fetched through internal backend API
- **Identifier normalization:** Some endpoints use `studentId`, some `studentGuid` — adapter layer must normalize. Field values are GUIDs in both cases.

### Internal API shape (backend → frontend)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard` | Home screen data: summary, needs-attention, feed, child cards, freshness |
| GET | `/api/feed` | Full latest-updates feed with pagination |
| GET | `/api/children` | All children |
| GET | `/api/children/:studentGuid` | Single child workspace data |
| GET | `/api/children/:studentGuid/homework` | Child homework history |
| GET | `/api/children/:studentGuid/behavior` | Child behavior history |
| GET | `/api/children/:studentGuid/subjects` | Child subjects + teachers |
| GET | `/api/children/:studentGuid/notices` | Child message board notices |
| GET | `/api/mail/summary` | Unread count + inbox preview |
| GET | `/api/mail/conversations` | Paginated inbox list |
| GET | `/api/mail/conversations/:id` | Conversation detail (lazy) |
| PUT | `/api/mail/conversations/mark-unread` | Mark conversations unread |
| PUT | `/api/mail/conversations/archive` | Archive conversations |
| GET | `/api/settings/source-health` | Per-source sync health |
| POST | `/api/read-state` | Update local handled/read state |
| POST | `/api/sync/refresh` | Trigger manual sync |
| GET | `/api/settings/profile` | Parent contact info |

---

## Database Schema (Core Tables)

### `household_connection`
Phase 1 single household. Fields: `id`, `schoolCode`, `schoolYear`, `username`, `encryptedPassword`, `schoolName`, `upstreamUserId`, `lastLoginAt`, `active`, `createdAt`, `updatedAt`

### `parent_profile`
Fields: `id`, `upstreamUserId`, `displayName`, `email`, `cellphone`, `detailsState`, `rawPayload`, `updatedAt`

### `student`
Fields: `id`, `studentGuid` (unique), `privateName`, `familyName`, `fullName`, `classCode`, `classNum`, `gender`, `groupsRaw` (jsonb), `isActive`, `rawPayload`, `updatedAt`

### `notification_event`
Fields: `id`, `upstreamNotificationId` (nullable), `fingerprint` (for ID-less events), `eventType`, `eventText`, `eventKey`, `eventKey2`, `studentGuid` (nullable), `eventAt`, `addTime`, `readTime`, `parsedEventData` (jsonb), `rawPayload`, `updatedAt`

### `mail_conversation`
Fields: `id`, `conversationId` (unique), `subject`, `senderNamePreview`, `sendTime`, `isUnread`, `hasAttachments`, `preventReply`, `labels` (jsonb), `rawPayload`, `lastFetchedAt`

### `mail_message`
Fields: `id`, `messageId` (unique), `conversationId`, `senderId`, `senderName`, `subject`, `bodyHtmlSanitized`, `bodyTextPreview`, `sendTime`, `isUnread`, `recipients` (jsonb), `rawPayload`

### `homework_item`
Fields: `id`, `studentGuid`, `lessonId`, `groupId`, `lessonDate`, `lesson`, `subjectName`, `homeworkText`, `remark`, `files` (jsonb), `rawPayload`, `updatedAt`
Unique constraint: `(studentGuid, lessonId)`

### `behavior_item`
Fields: `id`, `studentGuid`, `lessonId`, `groupId`, `eventCode`, `achvaCode`, `achvaName`, `classification`, `justifiable`, `lessonDate`, `lesson`, `subject`, `reporter`, `remark`, `justification`, `eventAt`, `rawPayload`, `updatedAt`
Unique constraint: `(studentGuid, lessonId, eventCode)`

### `subject_enrollment`
Fields: `id`, `studentGuid`, `groupId`, `groupName`, `subjectName`, `teachers` (jsonb), `inactiveTeachers` (jsonb), `weeklyHours`, `lessonsCount`, `rawPayload`, `updatedAt`
Unique constraint: `(studentGuid, groupId)`

### `behavior_type_reference`
Fields: `id`, `code` (unique), `name`, `displayOrder`, `justifiable`, `hidden`, `showInBehave`, `hideFromStudents`, `rawPayload`, `updatedAt`

### `message_board_item`
Fields: `id`, `studentGuid`, `eventId`, `eventText` (sanitized HTML), `expirationDate`, `inSite`, `rawPayload`, `updatedAt`
Unique constraint: `(studentGuid, eventId)`

### `read_state`
Fields: `id`, `itemType`, `itemId`, `scopeType`, `scopeId`, `isRead`, `isHandled`, `updatedAt`

### `sync_run`
Fields: `id`, `source`, `status`, `startedAt`, `endedAt`, `fetchedCount`, `createdCount`, `updatedCount`, `errorMessage`

### `recipient_directory` (optional Phase 1)
Fields: `id`, `value`, `valueType`, `targetType`, `displayName`, `comment`, `rawPayload`, `updatedAt`

---

## UX & Design Requirements

### Design system
- 8px spacing rhythm, card-based surfaces, rounded corners, soft elevation
- Strong typography hierarchy, chip/badge system
- Reusable empty / loading / error / stale states
- Compact list items optimized for mobile scan speed
- One accent color + restrained status colors (not color-only for status)

### Visual tone
Minimalistic, modern, calm, reliable, parent-friendly. Not childish. Not institutional.

### Navigation (mobile-first)
- **Home** — answers the parent's main question
- **Children** — child-specific drill-down
- **Inbox** — school communications
- **More** — low-frequency items, settings, diagnostics

Desktop: same IA; side rail or top nav acceptable.

### RTL & localization
- RTL layouts from day one
- Hebrew, mixed Hebrew/English rendering
- Natural date/time formatting (relative + exact)
- Safe rendering of long Hebrew HTML bodies
- Original Hebrew labels preserved in detail views; parent-friendly labels in summaries

### Anti-patterns (explicitly banned)
- Homepage that is mostly navigation chrome
- Requiring tab switches before showing meaningful updates
- Dense mobile tables as primary information pattern
- Horizontal carousels for critical information
- Requiring child selection before seeing anything useful
- Duplicate updates across modules without dedupe
- Disabled placeholder features for unsupported capabilities
- Alarming red-banner UX for routine sync lag

---

## Out of Scope (Phase 1)

- App sign-up or sign-in (Phase 2)
- Grades, averages, report cards, performance analytics
- Timetable / live daily schedule (Phase 2 — API is proven but feature deferred)
- Outbound messaging (compose, reply, forward) — no send endpoint exists
- Attachment downloading/opening — no retrieval endpoint exists
- Justification submission — no submit endpoint exists
- Push notifications
- Role management
- Multi-household public SaaS deployment

---

## Open Questions (Resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | How is X-Csrf-Token acquired? | GET initial page → token in response headers → use in POST /login |
| 2 | What cookies are set after login? | `Csrf-Token`, `MashovAuthToken`, `uniquId` — must be maintained per session |
| 3 | Rate limits? | Not known; use standard respectful cadence |
| 4 | Homework/behavior pagination? | Full history returned every call — upsert on sync |
| 5 | Child mapping for mail? | Not possible — default to household scope |
| 6 | dailyBehave schema? | Confirmed mirrors `/behave` shape |
| 7 | Timestamps consistent timezone? | Yes — all naive timestamps are in the same local timezone |
| 8 | Folder numeric values stable? | Treat as non-authoritative; do not rely on magic constants |
| 9 | Timetable — static or rolling? | Unknown; deferred to Phase 2 |
| 10 | messageBoard per child or school-wide? | Per childGuid — fetched using `childGuid` from login response |

---

## Definition of Done

### Phase 1

1. Backend authenticates against Mashov, solves CSRF bootstrap, and maintains session with cookie management.
2. All primary sync sources are working: notifications, mail count, inbox conversations, per-child homework, behavior, groups, lessons count, achvas, user details, message board.
3. Feature-flagged ingestion path exists for `dailyBehave` and `outBehave`.
4. Home screen shows: summary strip, needs-attention cards, latest-updates feed, child quick cards, last sync time, freshness status.
5. Parent can open child workspace in one tap and see: homework history, classified behavior history (using achvas), subjects/teachers, and school notices.
6. Parent can read full inbox and open a sanitized conversation detail (lazy-loaded).
7. Parent can mark conversations as unread and archive them.
8. Local handled/read state works and persists across page reloads.
9. Cached data is visible during refresh; partial source failure does not blank the screen.
10. `docker compose up --build` succeeds and stack is healthy.
11. All unit and integration tests pass (≥80% coverage).
12. E2E suite passes against Dockerized stack.
13. UI is clearly simpler and more modern than the upstream Mashov portal.
14. No unsupported capabilities (grades, timetable, compose, attachments) are implied in the UI.
15. No credentials, tokens, or sensitive data in frontend bundles, localStorage, or logs.
16. `.env.example` provided; no `.env` committed.
17. README has setup steps, env vars, and how to run tests.

### Phase 2

1. Parent can sign in to the app securely via magic-link or passkey.
2. Parent can connect and manage their school account.
3. Data and local state are scoped to the authenticated user.
4. Sessions are secure and revocable.
5. Multiple households coexist safely in the same deployment.
6. Timetable static weekly view available per child.
