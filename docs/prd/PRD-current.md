# PRD: Mashov School Parent Command Center — v2 (Phase 2: Authentication & Multi-Household)

**Date:** 2026-03-16
**Status:** Active
**Supersedes:** v1 (Phase 1 baseline)
**Phase scope:** Phase 2 only — Auth, per-user data scoping, multi-household

---

## Overview

Phase 2 adds proper parent authentication to the Mashov household command center built in Phase 1. It converts the app from a single-household private deployment into a secure, multi-tenant system where multiple parents can independently sign in and view only their own children's data. Authentication uses the parent's existing Mashov school credentials (school selector + username + password) — no separate account or email address required. Local read/handled state that was household-global in Phase 1 becomes user-scoped. The sync engine runs independently per household. Everything else — the dashboard, child workspace, inbox, timetable, behavior classification — carries forward from Phase 1 unchanged in UX.

---

## Problem Statement

Phase 1 works for a single household with no app-level login. It is unsuitable for shared deployments and lacks privacy isolation between users. A family member logging in sees another member's handled/read state. There is no way to add a second parent or school account without redeploying. Phase 2 fixes these limitations so the app can be safely shared within a household or deployed for multiple families.

---

## Users & Roles

### Phase 2

| Role | Description | Capabilities |
|------|-------------|--------------|
| **Parent (authenticated)** | Signed-in user with a connected school account | Full access to their own children's data; manage their own school connection; sign out |
| **Unauthenticated visitor** | Any request without a valid session cookie | Can reach sign-in page only; all `/api/v1/*` and app pages except `/auth/*` redirect to sign-in |

No admin role in Phase 2. Multi-household is supported by having multiple parent accounts; there is no super-admin or household manager role.

### Phase 1 compatibility

Phase 1 had no auth. Phase 2 is a breaking change — all API endpoints become protected. The existing household data in the DB is migrated to the first user who logs in, preserving Phase 1 data.

---

## Functional Requirements

### Authentication — Direct Mashov Credential Login

- **FR-1:** A parent navigates to `/auth/sign-in`. The page loads a school selector (search/autocomplete) populated from the Mashov `/api/schools` list, plus username and password fields.
- **FR-2:** The school list is fetched via `GET /api/v1/auth/schools` (backend proxy to `https://web.mashov.info/api/schools`) on page load. The list is filtered client-side on keystroke — no per-keystroke network calls.
- **FR-3:** The parent selects their school, enters their Mashov username and password, and submits. The school year is auto-derived from `Math.max(...school.years)` for the selected school — the parent does not enter a year.
- **FR-4:** Backend validates the credentials against the Mashov upstream API (`POST /api/login`). On success: upsert `app_user` keyed by `mashovUserId` (`credential.userId`), create an `app_session`, encrypt and store credentials in `household_connection`, parse children and school settings from the login response. On failure: return HTTP 401 with generic message "Invalid credentials, please try again" — no detail about which field was wrong.
- **FR-5:** Session cookie lifetime: 30 days, rolling (extend on each authenticated request). Configurable via `SESSION_LIFETIME_DAYS` env var. Cookie attributes: `HttpOnly; Secure; SameSite=Strict; Path=/`.
- **FR-6:** A parent can sign out. Session cookie is cleared; session record is revoked in DB and deleted from Redis cache.
- **FR-7:** Rate limit: maximum 5 failed login attempts per IP per 15 minutes. Counter stored in Redis with TTL key. On limit exceeded return 429 with a generic message.
- **FR-8:** All existing `/api/v1/*` endpoints and all app pages except `/auth/*` require a valid session. Unauthenticated requests to API endpoints return `401`. Unauthenticated browser requests redirect to `/auth/sign-in?next=<original-path>`.
- **FR-9:** First login redirects to `/auth/syncing` (initial sync in progress). Returning users (session created, connection already exists) redirect directly to Home.

### School Account Connection

- **FR-10:** School connection is created automatically on first login — no separate connect-school form. The `household_connection` record is created from the Mashov login response (`accessToken.children[]`, `accessToken.schoolSettings`).
- **FR-11:** Credentials are encrypted (AES-256-GCM, key from `CREDENTIAL_ENCRYPTION_KEY` env var) before storage. Raw credentials are never logged or returned in API responses.
- **FR-12:** After first login, the initial sync starts immediately. The parent is shown the sync progress screen (`/auth/syncing`) which polls `GET /api/v1/sync/status` every 3 seconds. Once the first successful sync cycle completes, redirect to Home.
- **FR-13:** Skip button on sync screen: goes to Home immediately after 10 seconds without waiting for sync to complete.

### School Account Management — Settings

- **FR-14:** In More/Settings, an authenticated parent can view their connected school account details (school name, year, username — never the raw password).
- **FR-15:** Parent can update their school credentials (re-enter username and/or password). Backend re-validates with Mashov upstream before saving. On failure, keep old credentials.
- **FR-16:** Parent can disconnect their school account. This removes the `household_connection` record and all associated data (students, homework, behavior, mail, sync runs, timetable) after a confirmation prompt. Session remains active; parent is redirected to sign-in.
- **FR-17:** Credential encryption key rotation: when `CREDENTIAL_ENCRYPTION_KEY` is rotated, an admin CLI command (`npm run credentials:rotate`) re-encrypts all stored credentials. This is an ops concern, not a UI feature.

### Per-User Data Scoping

- **FR-18:** All student, homework, behavior, mail, timetable, and sync data is associated with a `userId` (via `householdConnectionId`). Queries in all controllers include a user-scope filter derived from the session.
- **FR-19:** `isNew`/`isArchived` state on `homework_item` and `behavior_item`, and `isNew` on `mail_conversation`, is migrated from item-level columns to a `user_item_state` table keyed by `(userId, itemType, itemId)`. Items themselves are neutral; user state is overlaid at query time.
- **FR-20:** A parent's read/handled state changes do not affect any other parent's view of the same items (if two users ever share a school connection — which Phase 2 does not support in the UI, but the data model must not corrupt cross-user).
- **FR-21:** The `POST /api/v1/sync/refresh` endpoint triggers sync only for the authenticated user's household connection.

### Multi-Household Sync Isolation

- **FR-22:** The sync engine associates each `sync_run` record with a `householdConnectionId`. Cron tasks iterate over all active household connections and sync each independently.
- **FR-23:** A failure in one household's sync does not affect other households' cron runs.
- **FR-24:** Freshness state (`GET /api/v1/settings/source-health`) returns health for the authenticated user's connection only.

### Session Management

- **FR-25:** Session validation uses Redis cache-aside: check Redis first (TTL 5 min); on cache miss, check DB; on valid session populate Redis. This eliminates a DB round-trip on the hot path (frontend polls every 3s).
- **FR-26:** `GET /api/v1/auth/me` returns the current user's profile: `{ mashovUserId, username, displayName, connectedSchool: { schoolName, schoolYear } | null }`.
- **FR-27:** Backend middleware validates the session cookie on every request: checks existence, expiry, and that the session is not revoked. Revoked sessions return `401` and remove Redis cache entry.
- **FR-28:** When `SESSION_LIFETIME_DAYS` elapses since last activity, the session expires. The parent is redirected to sign-in with a `?reason=expired` param.

### Data Migration — Phase 1 → Phase 2

- **FR-29:** A migration script (`npm run migrate:phase2`) runs once during upgrade. It:
  1. Awaits the first successful login — the `app_user` record is created at that point.
  2. Reassigns all existing `household_connection`, `student`, `sync_run` records to that user.
  3. Migrates `homework_item.isNew`, `homework_item.isArchived`, `behavior_item.isNew`, `behavior_item.isArchived`, and `mail_conversation.isNew` to `user_item_state` rows for that user.
  4. Removes the now-redundant columns from the item tables.
- **FR-30:** After migration, the app behaves as if the first user had always been authenticated. No data loss.

---

## Non-Functional Requirements

- **Auth latency:** Sign-in → dashboard in < 3 seconds (Mashov upstream login + session creation + redirect).
- **Session security:** Sessions stored server-side in DB (source of truth) + Redis cache (performance). Cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`. No JWT in cookies.
- **Credential security:** School passwords never logged, never returned in any API response, never stored in plaintext. AES-256-GCM with random IV per encryption. Key loaded from `CREDENTIAL_ENCRYPTION_KEY` env var only.
- **Rate limiting:** Login attempts: 5 failed/IP/15min (Redis TTL keys). API endpoints: 100 requests/session/minute.
- **Multi-user isolation:** No query anywhere returns data from a different user's household connection. Enforced at service layer, not just controller.
- **HTTPS:** Enforced in production. `SESSION_SECURE_COOKIE=false` allowed only in local development (`NODE_ENV=development`).
- **Performance:** Auth middleware must not add more than 5ms to p95 API response time. Redis cache-aside keeps session lookup to < 0.5ms on cache hit.
- **Data retention:** Revoked sessions purged after 7 days. Batch cleanup cron: daily at 02:00.

---

## Tech Constraints

- **Backend:** NestJS (existing). Add `AuthModule`, `AppSessionModule`, `ConnectionModule`, `RedisModule`; rename existing `SessionModule` → `MashovSessionModule`.
- **Frontend:** Next.js 15 App Router (existing). Add `/auth/sign-in` (school selector + credentials), `/auth/syncing` pages. Add Next.js middleware for session-based route protection. No `/auth/verify` or `/auth/connect-school` pages.
- **Database:** PostgreSQL + Prisma (existing). New tables: `app_user`, `app_session`, `user_item_state`. Modified tables: `homework_item` (drop `isNew`, `isArchived`), `behavior_item` (drop `isNew`, `isArchived`), `mail_conversation` (drop `isNew`), `household_connection` (add `userId` FK). No `magic_link_token` table.
- **Cache:** Redis (new in Phase 2). `ioredis` client. Used for: session token validation cache (TTL 5 min) and login rate-limit counters (TTL 15 min). `maxmemory 256mb`, `maxmemory-policy allkeys-lru`, no RDB persistence.
- **Crypto:** Node.js built-in `crypto` module for AES-256-GCM. No external encryption library required.
- **Session:** Custom implementation using `app_session` DB table + Redis cache-aside + httpOnly cookie. No Passport.js, no NextAuth in Phase 2.
- **Auth middleware (Next.js):** `middleware.ts` at project root reads the session cookie, calls a lightweight session-check endpoint (or reads DB via API call to backend), and redirects unauthenticated requests.

---

## Existing Codebase

**Phase 1 is the baseline.** All of the following must be preserved and extended:

| Layer | Current state |
|-------|--------------|
| NestJS backend | 9 modules: Session (Mashov), Sync, Dashboard, Children, Mail, Feed, Settings, Health, Prisma |
| Next.js frontend | 6 routes: Home, Children, Child Workspace, Inbox, Conversation Detail, More |
| Prisma schema | 16 tables including `timetable_entry` added in Phase 1 extension |
| Item-level state | `homework_item.isNew/isArchived`, `behavior_item.isNew/isArchived`, `mail_conversation.isNew` — must migrate to `user_item_state` |
| Sync engine | 13 cron tasks including timetable. Must become multi-household aware. |
| API contract | All `/api/v1/*` endpoints currently unauthenticated — all must be guarded in Phase 2 |

**Breaking changes from Phase 1 → Phase 2:**
1. All API endpoints require auth cookie.
2. `isNew`/`isArchived` mutation endpoints now write to `user_item_state`.
3. `household_connection` gets a `userId` FK.
4. Sync cron tasks loop over all active connections, not just the one.

---

## New API Endpoints (Phase 2)

| Method | Path | Request | Response | Notes |
|--------|------|---------|----------|-------|
| GET | `/api/v1/auth/schools` | — | `Array<{ semel: number, name: string, years: number[] }>` | Proxy to Mashov `/api/schools`. No auth required. |
| POST | `/api/v1/auth/login` | `{ semel: number, username: string, password: string }` | `{ ok: true, isFirstLogin: boolean }` | Sets session cookie. Rate-limited. |
| DELETE | `/api/v1/auth/session` | — | `{ ok: true }` | Sign out — clears cookie, revokes session |
| GET | `/api/v1/auth/me` | — | `{ mashovUserId, username, displayName, connectedSchool: { schoolName, schoolYear } \| null }` | Requires auth |
| PUT | `/api/v1/connection` | `{ username?, password? }` | `{ ok: true }` | Update credentials |
| DELETE | `/api/v1/connection` | — | `{ ok: true }` | Disconnect + delete all associated data |
| GET | `/api/v1/sync/status` | — | `{ done: boolean, sourcesCompleted: number, sourcesTotal: number }` | Used by sync progress screen |

---

## New Database Schema

### `app_user`
Fields: `id` (UUID PK), `mashovUserId` (unique — `credential.userId` from Mashov login), `semel` (Int), `username` (String), `displayName` (String), `createdAt`, `updatedAt`

### `app_session`
Fields: `id`, `userId` (FK → app_user), `sessionToken` (unique, random 32-byte hex), `expiresAt`, `lastActivityAt`, `revokedAt` (nullable), `createdAt`
Index: `sessionToken` (unique, for fast DB lookup on Redis cache miss)

### `user_item_state`
Fields: `id`, `userId` (FK → app_user), `itemType` (`homework | behavior | mail_conversation`), `itemId` (string — item UUID), `isNew`, `isArchived`, `updatedAt`
Unique constraint: `(userId, itemType, itemId)`

### Modified: `household_connection`
Add: `userId` (FK → app_user, nullable during migration, required after)

### Removed columns (via migration):
- `homework_item.isNew`, `homework_item.isArchived`
- `behavior_item.isNew`, `behavior_item.isArchived`
- `mail_conversation.isNew`

---

## New UI Pages / Flows

### `/auth/sign-in`
- School selector (search/autocomplete from `/api/v1/auth/schools`) + username field + password field + submit button
- Minimalistic design matching app style — no decorative elements
- Single inline error message on failure: "Invalid credentials, please try again" (no field-level errors)
- On success: redirect to `/auth/syncing` (first login) or Home (returning user)
- No email field. No OAuth buttons. No magic-link.

### `/auth/syncing`
- Progress screen: "Setting up your account…" with animated indicator
- Polls `GET /api/v1/sync/status` every 3 seconds
- Shows progress: "3 / 10 sources complete"
- On done: redirect to Home
- Skip button: goes to Home immediately (available after 10 seconds)

### Settings page additions
- Show connected school name + year (read-only)
- "Update credentials" button → inline form with username/password fields
- "Disconnect account" button → confirmation modal → `DELETE /api/v1/connection`
- Sign out button → `DELETE /api/v1/auth/session` → redirect to `/auth/sign-in`

### App shell additions
- Show current user's `displayName` or initials in header (tap → sign-out confirmation or settings link)
- Session expiry: show a toast "Session expired — sign in again" when API returns `401`

---

## Out of Scope (Phase 2)

- Multiple school connections per user (one user = one school account in Phase 2)
- OAuth / social sign-in
- Email-based or passwordless authentication (magic-link, OTP)
- Admin user management UI
- Account deletion (supported only via `DELETE /api/v1/connection` which removes data; user record persists)
- Grade reports, performance analytics
- Outbound messaging (compose, reply)
- Attachment download
- Justification submission
- Push/email notifications for school events
- Timetable live/rolling schedule (static weekly timetable already in Phase 1)
- Grades or report cards

---

## Open Questions

| # | Question | Impact | Default if unresolved |
|---|----------|--------|----------------------|
| 1 | Should `DELETE /api/v1/connection` also delete the `app_user` record, or just disconnect? | Data retention | Keep user record, delete all school data |
| 2 | What happens if two parents share the same Mashov credentials (same school account)? | Multi-user isolation | Not a Phase 2 supported scenario; each user creates their own connection; same `mashovUserId` would collide on upsert — return 409 |
| 3 | Should the sync progress screen block or allow skip? | Onboarding UX | Allow skip after 10 seconds |
| 4 | Migration script: should it run automatically on first login or require explicit `npm run migrate:phase2`? | Ops simplicity | Explicit script; safer for production upgrades |

---

## Definition of Done

### Phase 2

1. An unauthenticated request to any `/api/v1/*` endpoint returns `401` (except `/api/v1/auth/login`, `/api/v1/auth/schools`, `/health`).
2. An unauthenticated browser request to any app page (except `/auth/*`) redirects to `/auth/sign-in`.
3. A parent can complete the full sign-in → sync progress → Home flow end-to-end using Mashov credentials.
4. A parent can update their school credentials and see the change reflected immediately.
5. A parent can disconnect their school account; all their data is removed; they are redirected to sign-in.
6. Two parent accounts with different school connections cannot see each other's data (verified by integration test).
7. `isNew`/`isArchived` mutations on homework and behavior items persist per-user (two users toggling the same item see independent state).
8. Login rate limiting: 6th failed attempt from same IP within 15 min returns 429.
9. Session cookie has `HttpOnly; Secure; SameSite=Strict` flags (verified by integration test header inspection).
10. Credentials are never returned in any API response (automated test: grep for password-like fields in all API fixtures).
11. All unit and integration tests pass. Coverage ≥ 80%.
12. `docker compose up --build` succeeds. Auth flow demonstrable against the Dockerized stack.
13. E2E suite passes for: sign-in flow, sync-progress, sign-out, session-protected route redirect.
14. Phase 1 data migration script runs successfully and preserves all existing data.
15. README updated with Phase 2 env vars: `CREDENTIAL_ENCRYPTION_KEY`, `SESSION_LIFETIME_DAYS`, `REDIS_URL`.
