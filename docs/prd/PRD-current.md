# PRD: Mashov School Parent Command Center — v2 (Phase 2: Authentication & Multi-Household)

**Date:** 2026-03-16
**Status:** Active
**Supersedes:** v1 (Phase 1 baseline)
**Phase scope:** Phase 2 only — Auth, per-user data scoping, multi-household

---

## Overview

Phase 2 adds proper parent authentication to the Mashov household command center built in Phase 1. It converts the app from a single-household private deployment into a secure, multi-tenant system where multiple parents can independently sign in, connect their own school accounts, and view only their own children's data. Authentication uses an email magic-link flow (passwordless). Local read/handled state that was household-global in Phase 1 becomes user-scoped. The sync engine runs independently per household. Everything else — the dashboard, child workspace, inbox, timetable, behavior classification — carries forward from Phase 1 unchanged in UX.

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

Phase 1 had no auth. Phase 2 is a breaking change — all API endpoints become protected. The existing household data in the DB is migrated to the first user created, preserving Phase 1 data.

---

## Functional Requirements

### Authentication — Magic-Link Flow

- **FR-1:** A parent navigates to `/auth/sign-in` and enters their email address.
- **FR-2:** Backend sends a magic-link email with a time-limited single-use token (expiry: 15 minutes). The token is stored hashed in the DB.
- **FR-3:** Parent clicks the link → backend verifies token → creates or resumes session → issues httpOnly, Secure, SameSite=Strict session cookie. Token is marked used.
- **FR-4:** Session cookie lifetime: 30 days, rolling (refresh on each authenticated request). Configurable via `SESSION_LIFETIME_DAYS` env var.
- **FR-5:** A parent can sign out. Session cookie is cleared; session record is invalidated in DB.
- **FR-6:** Expired or used magic-link tokens return a clear error page with a "Request a new link" action.
- **FR-7:** Rate limit: maximum 3 magic-link requests per email per 15 minutes. Returns a generic "check your inbox" message regardless of whether the email exists (don't reveal existence).
- **FR-8:** Magic-link email is sent via configurable transport: SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) or Resend API (`RESEND_API_KEY`). Exactly one must be configured.
- **FR-9:** All existing `/api/v1/*` endpoints and all app pages except `/auth/*` require a valid session. Unauthenticated requests to API endpoints return `401`. Unauthenticated browser requests redirect to `/auth/sign-in?next=<original-path>`.

### School Account Connection — Onboarding

- **FR-10:** After first sign-in (no school account connected), the parent is redirected to `/auth/connect-school`.
- **FR-11:** The connect-school form collects: school code (`semel`), school year (`year`), username, password. All fields required.
- **FR-12:** Backend submits credentials to Mashov upstream API (`POST /api/login` flow) to validate. If upstream login fails, return a clear field-level error — do not store the credentials.
- **FR-13:** On success: encrypt credentials (AES-256-GCM, key from `CREDENTIAL_ENCRYPTION_KEY` env var) and store in `household_connection` record linked to the user. Parse and persist children from `accessToken.children[]` and school settings. Start initial sync.
- **FR-14:** Parent is shown a sync progress screen (`/auth/syncing`) while initial sync runs. The screen polls `GET /api/v1/sync/status` every 3 seconds. Once the first successful sync cycle completes, redirect to Home.
- **FR-15:** A connected parent who navigates to `/auth/connect-school` is redirected to Settings instead (account already connected).

### School Account Management — Settings

- **FR-16:** In More/Settings, an authenticated parent can view their connected school account details (school name, year, username — never the raw password).
- **FR-17:** Parent can update their school credentials (re-enter username and/or password). Backend re-validates with upstream before saving. On failure, keep old credentials.
- **FR-18:** Parent can disconnect their school account. This removes the `household_connection` record and all associated data (students, homework, behavior, mail, sync runs, timetable) after a confirmation prompt. Session remains active; parent is redirected to `/auth/connect-school`.
- **FR-19:** Credential encryption key rotation: when `CREDENTIAL_ENCRYPTION_KEY` is rotated, an admin CLI command (`npm run credentials:rotate`) re-encrypts all stored credentials. This is an ops concern, not a UI feature.

### Per-User Data Scoping

- **FR-20:** All student, homework, behavior, mail, timetable, and sync data is associated with a `userId` (via `householdConnectionId`). Queries in all controllers include a user-scope filter derived from the session.
- **FR-21:** `isNew`/`isArchived` state on `homework_item` and `behavior_item`, and `isNew` on `mail_conversation`, is migrated from item-level columns to a `user_item_state` table keyed by `(userId, itemType, itemId)`. Items themselves are neutral; user state is overlaid at query time.
- **FR-22:** A parent's read/handled state changes do not affect any other parent's view of the same items (if two users ever share a school connection — which Phase 2 does not support in the UI, but the data model must not corrupt cross-user).
- **FR-23:** The `POST /api/v1/sync/refresh` endpoint triggers sync only for the authenticated user's household connection.

### Multi-Household Sync Isolation

- **FR-24:** The sync engine associates each `sync_run` record with a `householdConnectionId`. Cron tasks iterate over all active household connections and sync each independently.
- **FR-25:** A failure in one household's sync does not affect other households' cron runs.
- **FR-26:** Freshness state (`GET /api/v1/settings/source-health`) returns health for the authenticated user's connection only.

### Session Management

- **FR-27:** The DB stores all active sessions. `GET /api/v1/auth/me` returns the current user's profile (email, connected school name/year if any).
- **FR-28:** Backend middleware validates the session cookie on every request: checks existence, expiry, and that the session is not revoked. Revoked sessions return `401`.
- **FR-29:** When `SESSION_LIFETIME_DAYS` elapses since last activity, the session expires. The parent is redirected to sign-in with a `?reason=expired` param.

### Data Migration — Phase 1 → Phase 2

- **FR-30:** A migration script (`npm run migrate:phase2`) runs once during upgrade. It:
  1. Creates the first `app_user` record (email from `BOOTSTRAP_ADMIN_EMAIL` env var).
  2. Reassigns all `household_connection`, `student`, `sync_run` records to that user.
  3. Migrates `homework_item.isNew`, `homework_item.isArchived`, `behavior_item.isNew`, `behavior_item.isArchived`, and `mail_conversation.isNew` to `user_item_state` rows for that user.
  4. Removes the now-redundant columns from the item tables.
- **FR-31:** After migration, the app behaves as if the first user had always been authenticated. No data loss.

---

## Non-Functional Requirements

- **Auth latency:** Magic-link email delivered within 30 seconds in 95th percentile. Sign-in → dashboard in < 3 seconds (includes session validation + DB round trip, not email wait).
- **Session security:** Sessions stored server-side in DB. Cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`. No JWT in cookies (server-side session only).
- **Credential security:** School passwords never logged, never returned in any API response, never stored in plaintext. AES-256-GCM with random IV per encryption. Key loaded from `CREDENTIAL_ENCRYPTION_KEY` env var only.
- **Rate limiting:** Magic-link request: 3/email/15min. Sign-in page: 10 requests/IP/minute. API endpoints: 100 requests/session/minute (existing behavior, now per-session).
- **Multi-user isolation:** No query anywhere returns data from a different user's household connection. Enforced at service layer, not just controller.
- **HTTPS:** Enforced in production. `SESSION_SECURE_COOKIE=false` allowed only in local development (`NODE_ENV=development`).
- **Performance:** Adding auth middleware must not add more than 5ms to p95 API response time (session lookup by indexed session token).
- **Data retention:** Revoked sessions purged after 7 days. Expired magic-link tokens purged after 24 hours. Batch cleanup cron: daily at 02:00.

---

## Tech Constraints

- **Backend:** NestJS (existing). Add `AuthModule`, `MagicLinkModule`, `SessionModule` (rename existing session → `MashovSessionModule` to avoid naming conflict).
- **Frontend:** Next.js 15 App Router (existing). Add `/auth/sign-in`, `/auth/verify`, `/auth/connect-school`, `/auth/syncing` pages. Add Next.js middleware for session-based route protection.
- **Database:** PostgreSQL + Prisma (existing). New tables: `app_user`, `magic_link_token`, `app_session`, `user_item_state`. Modified tables: `homework_item` (drop `isNew`, `isArchived`), `behavior_item` (drop `isNew`, `isArchived`), `mail_conversation` (drop `isNew`), `household_connection` (add `userId` FK).
- **Email:** Nodemailer for SMTP; `resend` npm package for Resend API. Exactly one transport configured via env vars. Template: minimal HTML with magic-link button + plain-text fallback.
- **Crypto:** Node.js built-in `crypto` module for AES-256-GCM. No external encryption library required.
- **Session:** Custom implementation using a `app_session` DB table + httpOnly cookie. No Passport.js, no NextAuth in Phase 2. Keep it simple.
- **Auth middleware (Next.js):** `middleware.ts` at project root reads the session cookie, calls a lightweight session-check endpoint or reads directly from the shared DB (via an API call to backend), and redirects unauthenticated requests.

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

All new auth endpoints are under `/api/v1/auth/`:

| Method | Path | Request | Response | Notes |
|--------|------|---------|----------|-------|
| POST | `/api/v1/auth/magic-link` | `{ email: string }` | `{ message: string }` | Rate-limited. Always returns 200 with generic message. |
| GET | `/api/v1/auth/verify` | `?token=<token>` | Redirect to `/` or `/auth/connect-school` | Sets session cookie on success |
| DELETE | `/api/v1/auth/session` | — | `{ ok: true }` | Sign out — clears cookie, revokes session |
| GET | `/api/v1/auth/me` | — | `{ email, connectedSchool: { schoolName, schoolYear } \| null }` | Requires auth |
| POST | `/api/v1/connection` | `{ semel, year, username, password }` | `{ schoolName, schoolYear, childrenCount }` | Connect school account |
| PUT | `/api/v1/connection` | `{ username?, password? }` | `{ ok: true }` | Update credentials |
| DELETE | `/api/v1/connection` | — | `{ ok: true }` | Disconnect + delete all associated data |
| GET | `/api/v1/sync/status` | — | `{ done: boolean, sourcesCompleted: number, sourcesTotal: number }` | Used by sync progress screen |

---

## New Database Schema

### `app_user`
Fields: `id` (UUID PK), `email` (unique), `createdAt`, `updatedAt`

### `magic_link_token`
Fields: `id`, `email`, `tokenHash` (SHA-256 of raw token), `expiresAt`, `usedAt` (nullable), `createdAt`
Index: `(email, usedAt, expiresAt)` for rate-limit queries

### `app_session`
Fields: `id`, `userId` (FK → app_user), `sessionToken` (unique, random 32-byte hex), `expiresAt`, `lastActivityAt`, `revokedAt` (nullable), `createdAt`
Index: `sessionToken` (unique, for fast lookup on every request)

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
- Email input field + submit button
- On submit: `POST /api/v1/auth/magic-link`
- Show "Check your inbox" confirmation state after submit
- Link back to re-enter email if needed
- No password field. No OAuth buttons.

### `/auth/verify` (magic-link landing)
- No UI — just shows a loading spinner while `GET /api/v1/auth/verify?token=...` resolves
- On success: redirect to Home (or connect-school if no connection)
- On error: show error page with "Request new link" action

### `/auth/connect-school`
- Form: school code, school year, username, password
- Submit calls `POST /api/v1/connection`
- On success: redirect to `/auth/syncing`
- Show upstream error inline (e.g., "Invalid credentials — check your Mashov username and password")

### `/auth/syncing`
- Progress screen: "Setting up your account…" with animated indicator
- Polls `GET /api/v1/sync/status` every 3 seconds
- Shows progress: "Syncing notifications… 3 / 10 sources complete"
- On done: redirect to Home
- Skip button (for manual re-sync): goes to Home immediately

### Settings page additions
- Show connected school name + year (read-only)
- "Update credentials" button → inline form with username/password fields
- "Disconnect account" button → confirmation modal → `DELETE /api/v1/connection`
- Sign out button → `DELETE /api/v1/auth/session` → redirect to `/auth/sign-in`

### App shell additions
- Show current user's email or initials in header (tap → sign-out confirmation or settings link)
- Session expiry: show a toast "Session expired — sign in again" when API returns `401`

---

## Out of Scope (Phase 2)

- Multiple school connections per user (one user = one school account in Phase 2)
- OAuth / social sign-in
- Password-based sign-in (magic-link only)
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
| 1 | Should magic-link tokens be invalidated after use, or support one-time-per-device click with multi-tab grace? | UX edge case | Invalidated after first use; 30-day session handles re-access |
| 2 | Should `DELETE /api/v1/connection` also delete the `app_user` record, or just disconnect? | Data retention | Keep user record, delete all school data |
| 3 | What happens if two parents share the same school credentials (same Mashov account)? | Multi-user isolation | Not a Phase 2 supported scenario; each user creates their own connection |
| 4 | Should the sync progress screen block or allow skip? | Onboarding UX | Allow skip after 10 seconds |
| 5 | Email transport: should both SMTP and Resend be supported simultaneously or exactly one? | Ops flexibility | Exactly one; determined by which env vars are present |

---

## Definition of Done

### Phase 2

1. An unauthenticated request to any `/api/v1/*` endpoint returns `401`.
2. An unauthenticated browser request to any app page (except `/auth/*`) redirects to `/auth/sign-in`.
3. A parent can complete the full sign-in → connect-school → sync progress → Home flow end-to-end.
4. A parent can update their school credentials and see the change reflected immediately.
5. A parent can disconnect their school account; all their data is removed; they are redirected to connect-school.
6. Two parent accounts with different school connections cannot see each other's data (verified by integration test).
7. `isNew`/`isArchived` mutations on homework and behavior items persist per-user (two users toggling the same item see independent state).
8. Magic-link email is sent and contains a working link in test/staging environments.
9. Session cookie has `HttpOnly; Secure; SameSite=Strict` flags (verified by browser devtools or integration test header inspection).
10. Credentials are never returned in any API response (automated test: grep for password-like fields in all API fixtures).
11. All unit and integration tests pass. Coverage ≥ 80%.
12. `docker compose up --build` succeeds. Auth flow demonstrable against the Dockerized stack.
13. E2E suite passes for: sign-in flow, connect-school flow, sign-out, session-protected route redirect.
14. Phase 1 data migration script runs successfully and preserves all existing data.
15. README updated with Phase 2 env vars (`CREDENTIAL_ENCRYPTION_KEY`, `SESSION_LIFETIME_DAYS`, `BOOTSTRAP_ADMIN_EMAIL`, email transport vars).
