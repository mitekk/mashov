# PRD: Mashov School Parent Command Center — v3 (Phase 2 + 2.1: Authentication, Multi-Household, Merged Household Access)

**Date:** 2026-11-20
**Status:** Active
**Supersedes:** v2 (Phase 2 baseline)
**Phase scope:** Phase 2 (auth, per-user data scoping, multi-household) plus **Phase 2.1**
(merged household access — several schools per household, sign-in adoption, the household
merge)

**What changed from v2.** v2 assumed one parent = one household = one school. Phase 2.1 broke
all three halves of that, so this version corrects the claims v2 made about them and records
the questions it left open as answered. Phase 2's FR-1 … FR-30 keep their numbers and meanings;
Phase 2.1 is additive as FR-31 … FR-38. The decisions are in
[ADR-0029](../adr/0029-household-merge-and-login-adoption.md) (adoption),
[ADR-0030](../adr/0030-per-connection-data-scoping.md) (per-connection scoping),
[ADR-0031](../adr/0031-child-visibility-is-a-set-of-connections.md) (visibility is a set) and
[ADR-0032](../adr/0032-household-merge-trust-model.md) (the merge's trust model).

---

## Overview

Phase 2 adds proper parent authentication to the Mashov household command center built in Phase 1. It converts the app from a single-household private deployment into a secure, multi-tenant system where multiple parents can independently sign in and view only the children they are entitled to see. Authentication uses the parent's existing Mashov school credentials (school selector + username + password) — no separate account or email address required. Local read/handled state that was household-global in Phase 1 becomes user-scoped. The sync engine runs independently per household. Everything else — the dashboard, child workspace, inbox, timetable, behavior classification — carries forward from Phase 1 unchanged in UX.

**Phase 2.1 — merged household access.** v2's model was one parent, one household, one school,
and each of those three turned out to be wrong about real families. A household now holds up to
**four** school connections, because a parent with children at two schools wants one briefing
rather than two logins. A child can be visible through **several** connections, because two
parents at one school each hold their own Mashov credentials and both are entitled to the same
children — under the single-stamp rule the second to sync evicted the first. And signing in with
a school's credentials attaches to whichever household already linked that school, rather than
creating a second one that holds a copy of it. "Only their own children's data" therefore means
*the set of children reachable through the caller's own connections*, not *the children of one
connection* — and every read is scoped to that set at the service layer.

---

## Problem Statement

Phase 1 works for a single household with no app-level login. It is unsuitable for shared deployments and lacks privacy isolation between users. A family member logging in sees another member's handled/read state. There is no way to add a second parent or school account without redeploying. Phase 2 fixes these limitations so the app can be safely shared within a household or deployed for multiple families.

---

## Users & Roles

### Phase 2

| Role | Description | Capabilities |
|------|-------------|--------------|
| **Parent (authenticated)** | Signed-in user with one or more connected school accounts (up to 4) | Full access to the children reachable through their own connections; add, re-credential and unlink each school independently; merge in a school another household holds, with their own password for it; sign out |
| **Unauthenticated visitor** | Any request without a valid session cookie | Can reach sign-in page only; all `/api/v1/*` and app pages except `/auth/*` redirect to sign-in |

No admin role in Phase 2. Multi-household is supported by having multiple parent accounts;
there is no super-admin or household manager role.

Two parents may hold credentials at the **same** school and be entitled to the same children.
That is a supported state, not a collision: each sees the shared children, and read/handled
state stays per-user. Equally, a sign-in does **not** always create a household — whoever holds
a school's password reaches the household that already linked that school (FR-33). There is no
role attached to being the parent who linked it first; `linkedByUserId`/`linkedAt` are an audit
trail, not a permission.

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
- **FR-12:** After first login, the initial sync starts immediately. The parent is shown the sync progress screen (`/auth/syncing`) which polls `GET /api/v1/sync/status` every 2 seconds and shows the task in flight. The screen leaves for Home on whichever comes first: `done` from the poll, the `POST /api/v1/sync/refresh` request resolving, or a 120-second hard cap. Completion includes a *partial* refresh — a source that failed upstream is reported in settings, and must never hold the parent on this screen.
- **FR-13:** Skip button on sync screen: goes to Home immediately after 10 seconds without waiting for sync to complete.

### School Account Management — Settings

- **FR-14:** In More/Settings, an authenticated parent can view their connected school account details (school name, year, username — never the raw password).
- **FR-15:** Parent can update their school credentials (re-enter username and/or password). Backend re-validates with Mashov upstream before saving. On failure, keep old credentials.
- **FR-16:** Parent can unlink **one** school, or all of them. Unlinking removes that `household_connection` and only that school's data (its students, homework, behavior, mail, releases, activities, profile, digest rows and sync runs) after a confirmation prompt naming how many schools it affects. The **session stays active and the parent is not signed out**: they still have a household, and signing them out because one of several schools went away would be a worse outcome than the unlink they asked for. Unlinking the last school leaves the `app_user` and the session intact.
- **FR-17:** Credential encryption key rotation: when `CREDENTIAL_ENCRYPTION_KEY` is rotated, an admin CLI command (`npm run credentials:rotate`) re-encrypts all stored credentials. This is an ops concern, not a UI feature.

### Per-User Data Scoping

- **FR-18:** All student, homework, behavior, mail, timetable, and sync data is associated with a `userId` (via `householdConnectionId`). Queries in all controllers include a user-scope filter derived from the session.
- **FR-19:** `isNew`/`isArchived` state on `homework_item` and `behavior_item`, and `isNew` on `mail_conversation`, is migrated from item-level columns to a `user_item_state` table keyed by `(userId, itemType, itemId)`. Items themselves are neutral; user state is overlaid at query time.
- **FR-20:** A parent's read/handled state changes do not affect any other parent's view of the same items. Two parents sharing children at one school is a **supported** state as of Phase 2.1 (FR-31), not the hypothetical v2 described, so this is a live requirement rather than a data-model precaution.
- **FR-21:** The `POST /api/v1/sync/refresh` endpoint triggers sync only for the authenticated user's household connection.

### Multi-Household Sync Isolation

- **FR-22:** The sync engine associates each `sync_run` record with a `householdConnectionId`. Cron tasks iterate over all active household connections and sync each independently.
- **FR-23:** A failure in one household's sync does not affect other households' cron runs.
- **FR-24:** Freshness state (`GET /api/v1/settings/source-health`) returns health for the authenticated user's connection only.

### Merged Household Access (Phase 2.1)

- **FR-31:** A child can be visible through **more than one** household connection. Visibility is a set (`student_connection`), not a single owning stamp, so two parents at one school who are each entitled to the same children both see them, simultaneously and regardless of which of them synced last.
- **FR-32:** A household holds up to **4** school connections. A parent adds one from Settings by entering that school's Mashov credentials; the children of every connected school appear together in one list, each labelled with its school.
- **FR-33:** **Sign-in adoption.** Signing in with a school's credentials attaches the session to whichever household already holds that school's connection, rather than creating a second household holding a copy of it. This is the same authorisation the rest of the model rests on — whoever holds a school's password reaches that school's data. Governed by a single kill switch, `MASHOV_ENABLE_SCHOOL_LINK_ADOPTION`; `false` restores Phase 2's behaviour, in which linking a second school dead-ends.
- **FR-34:** **The household merge.** A parent who signed into school B first and later wants B inside school A's household is offered a merge rather than refused. `POST /school-links` answers `409 MERGE_AVAILABLE` **after** the password for B is proven, carrying only what a parent needs to recognise what they are about to move — the school name and the child count — and the parent confirms explicitly before anything happens. The merge re-parents B's connection, revokes the other household's sessions, moves its `userId`-keyed state, and leaves the retired `app_user` interpretable via `mergedIntoUserId`. It is gated on the same kill switch as FR-33.
- **FR-35:** A merge is offered only when the other household holds **no other active connection**. A household actively using two schools is not an orphan: pulling one school out of it would revoke a live household's sessions. That state keeps the Phase 2 refusal, and the parent can unlink from the other side.
- **FR-36:** Revoking a session must clear its Redis mirror as well as its database row. Session validation answers from the cache without consulting the database, so a database-only revoke leaves the signed-out household browsing a household whose every page has quietly emptied.
- **FR-37:** Every cross-child response carries the school each item belongs to (`schoolId`, `schoolShortLabel`), resolved server-side and always naming one of the **caller's own** connections. `null` means "ownership not yet known" and must render as *no badge*, never as a school named "null"; such an item stays visible under every school filter, because hiding it behind a chip it can never match would make it unreachable.
- **FR-38:** Contact details in Settings are shown **per school**, each labelled with the school it came from. Through Phase 2 the school label and the contact details were read by two different queries, so a two-school parent could be shown one school's phone number captioned with another school's name.

### Session Management

- **FR-25:** Session validation uses Redis cache-aside: check Redis first (TTL 5 min); on cache miss, check DB; on valid session populate Redis. This eliminates a DB round-trip on the hot path (frontend polls every 3s).
- **FR-26:** `GET /api/v1/auth/me` returns the current user's profile: `{ mashovUserId, username, displayName, schools: MeSchool[] }`, newest sign-in first, `[]` when none. A singular `connectedSchool` field existed through Phase 2 and was removed in Phase 2.1's cleanup: it was `schools[0]` under a name that claimed there was only one.
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
| GET | `/api/v1/auth/me` | — | `{ mashovUserId, username, displayName, schools: MeSchool[] }` | Requires auth. No `connectedSchool` — removed in Phase 2.1 |
| GET | `/api/v1/school-links` | — | Paginated `SchoolLink[]` | Every connected school, newest sign-in first |
| POST | `/api/v1/school-links` | `{ semel, username, password, confirmMerge? }` | `SchoolLink` | 201. Answers `409 MERGE_AVAILABLE` when another household holds that school and a merge is possible; the confirm is this same POST with `confirmMerge: true` |
| PUT | `/api/v1/school-links/:id` | `{ username?, password? }` | `{ ok: true }` | Re-credential **one** school. Replaces `PUT /api/v1/connection` |
| DELETE | `/api/v1/school-links/:id` | — | — | 204, no body. Unlink one school |
| DELETE | `/api/v1/school-links` | — | — | 204, no body. Unlink every school; the session survives. Replaces `DELETE /api/v1/connection`, which answered `200 { ok: true }` |

`PUT`/`DELETE /api/v1/connection` were documented aliases over the same service methods and
were **removed** in Phase 2.1's cleanup; both paths now 404. See `docs/api-contract.md` for the
migration note.
| GET | `/api/v1/sync/status` | — | `{ done, sourcesCompleted, sourcesTotal, phase, refreshId, startedAt, endedAt, tasksTotal, tasksSettled, tasksFailed, currentTask, tasks }` | Used by sync progress screen. `done` comes from the refresh envelope, not from a `sync_run` count; see `docs/api-contract.md` for the phase table |

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

### Phase 2.1 schema additions

- **`student_connection`** — the visibility edge from FR-31: `(studentGuid, householdConnectionId)` plus `lastSeenInRosterAt`. This, not `student.householdConnectionId`, is what answers "may this caller see this child". The single stamp survives as an *ownership* hint — which connection's credentials to spend upstream — and is nullable, meaning "ownership not yet known".
- **`app_user.mergedIntoUserId`** — set on the retired `app_user` of a merged household (FR-34), making its state interpretable. Cleared when the merged-in school is unlinked, scoped by that connection's `upstreamUserId` so unlinking a *different* school does not release it.
- **`household_connection.linkedByUserId` / `linkedAt`** — the audit trail for who asserted a claim over a school, and when.
- **`householdConnectionId` on the per-school tables** — mail, notifications, releases, activities, sync runs and the parent profile are each scoped to the connection they came from (ADR-0030). `NULL` means "ownership not yet known" and is admitted by every reader, per FR-37.

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
- Polls `GET /api/v1/sync/status` every 2 seconds
- Shows progress: "3 / 10 sources complete", plus the name of the task in flight
- Leaves for Home on any one of: `done` from the poll (including a partial refresh), the
  refresh request resolving, or a 120-second hard cap
- On a refresh failure or proxy timeout: an explanation and a "continue" button, never a
  spinner with no way forward
- Skip button: goes to Home immediately (available after 10 seconds)

### Settings page additions
- One row per connected school (name + year, read-only), and one contact-details card per school, each labelled with its own school (FR-38)
- "Add a school" → `/more/schools/new`: school selector + that school's Mashov credentials. A school already linked is shown but unselectable — preventing the error beats reporting it
- On `409 MERGE_AVAILABLE`, the form shows a confirmation in a parent's words (the separate sign-in stops working; both schools' children appear here; the school can be unlinked at any time) rather than an error, and resubmits with `confirmMerge: true` (FR-34). Editing any field withdraws the offer, so the card on screen always describes the request the button would send
- "Update credentials" per school → inline form with username/password fields
- "Unlink" per school → confirmation modal → `DELETE /api/v1/school-links/:id`; the bulk action names how many schools it affects
- Sign out button → `DELETE /api/v1/auth/session` → redirect to `/auth/sign-in`

### App shell additions
- Show current user's `displayName` or initials in header (tap → sign-out confirmation or settings link)
- Session expiry: show a toast "Session expired — sign in again" when API returns `401`

---

## Out of Scope (Phase 2)

- OAuth / social sign-in
- Email-based or passwordless authentication (magic-link, OTP)
- Admin user management UI
- Account deletion (supported only via `DELETE /api/v1/school-links`, which removes every school's data; the `app_user` record persists — see Open Question 1)
- Grade reports, performance analytics
- Outbound messaging (compose, reply)
- Attachment download
- Justification submission
- Push/email notifications for school events
- Timetable live/rolling schedule (static weekly timetable already in Phase 1)
- Grades or report cards

**Moved into scope in Phase 2.1:** "multiple school connections per user (one user = one school
account in Phase 2)" was listed here in v2. It is now FR-32, and the cap is 4.

---

## Open Questions

| # | Question | Impact | Status |
|---|----------|--------|--------|
| 1 | Should unlinking also delete the `app_user` record, or just disconnect? | Data retention | **Resolved — keep the user record**, and not only by preference: `app_session.userId` is a required relation with no `onDelete`, so Postgres restricts the delete. The question named `DELETE /api/v1/connection`, which no longer exists; the endpoint is `DELETE /api/v1/school-links` |
| 2 | What happens if two parents share the same school account, or hold separate accounts at one school? | Multi-user isolation | **Resolved, and opposite to v2's default.** v2 answered "not a supported scenario; each user creates their own connection; same `mashovUserId` would collide on upsert — return 409". Two parents with their **own** credentials at one school is now supported and tested: visibility is a set (FR-31), so both see the shared children at once. The collision v2 predicted was real — under the single-stamp rule the second parent to sync evicted the first — and is fixed, not refused. Two parents sharing **one** Mashov account reach one household by FR-33, which is what that account entitles them to |
| 3 | Should the sync progress screen block or allow skip? | Onboarding UX | **Resolved** — allow skip after 10 seconds |
| 4 | Migration script: should it run automatically on first login or require explicit `npm run migrate:phase2`? | Ops simplicity | **Resolved** — explicit script; safer for production upgrades |

No open question remains. The two operational items left on Phase 2.1 are a live-stack
verification against real second-school credentials and a full cron cycle, tracked in
`docs/plans/merged-household-access-followups.md` rather than here.

---

## Definition of Done

### Phase 2

1. An unauthenticated request to any `/api/v1/*` endpoint returns `401` (except `/api/v1/auth/login`, `/api/v1/auth/schools`, `/health`).
2. An unauthenticated browser request to any app page (except `/auth/*`) redirects to `/auth/sign-in`.
3. A parent can complete the full sign-in → sync progress → Home flow end-to-end using Mashov credentials.
4. A parent can update their school credentials and see the change reflected immediately.
5. A parent can unlink one school; only that school's data is removed; the other schools and the session survive.
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

### Phase 2.1

16. Two parents with their **own** credentials at the same school both see the children they
    share, at the same time, whichever of them synced last (the hard case; DoD 6 above is the
    easy one, and nine routes passed it while having no ownership guard at all).
17. No query anywhere returns another household's data, and no request goes upstream under
    another household's decrypted credentials — including the fallback paths for a row whose
    ownership is not yet known.
18. A parent with two schools sees both schools' children in one list, each labelled, and both
    schools' contact details in Settings captioned with the right school.
19. A parent who signed into school B first can add B from school A's session: they are offered
    a merge, confirm it explicitly, and afterwards both schools' children appear in one
    household. The separate sign-in's live session stops working — in the database **and** in
    the Redis mirror.
20. `MASHOV_ENABLE_SCHOOL_LINK_ADOPTION=false` restores Phase 2 behaviour for both sign-in and
    the merge.
21. Unlinking the merged-in school releases the merge pointer, so signing in with that school
    re-forms its own household; unlinking a *different* school does not.
