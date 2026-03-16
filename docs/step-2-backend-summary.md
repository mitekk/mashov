# Backend Phase 2 Summary — Auth, Sessions, Multi-Household

## What Was Built

### Authentication & Session Management

- **`MashovSessionService`** (`src/session/mashov-session.service.ts`) — per-connection session cache using `Map<connectionId, ConnectionSession>`. Supports `getAuthHeadersForConnection()` with in-flight promise deduplication to prevent concurrent logins for the same connection. Falls back to the shared session when no user-linked connections exist.
- **`MashovHttpClient.getForConnection<T>()`** — authenticates per connection, retries on 401/403 with `forceRefresh=true`.
- **`EncryptionService`** — AES-256-GCM decryption of stored credentials.

### Multi-Household Sync

All 13 sync tasks updated to loop over `HouseholdConnection` records where `userId IS NOT NULL AND active = true`. Tasks fall back to the shared session when no user-owned connections exist.

Tasks modified:
- `homework.task.ts`, `behavior.task.ts`, `mail-inbox.task.ts`, `groups.task.ts`
- `mail-counts.task.ts`, `achvas.task.ts`, `user-details.task.ts`, `notifications.task.ts`
- `timetable.task.ts`, `daily-behave.task.ts`, `out-behave.task.ts`, `lessons-count.task.ts`
- `message-board.task.ts`

### Per-User Item State

- **`UserItemStateService`** — `getStateBatch()` / `setStateBatch()` backed by `UserItemState` table. `ChildrenService` now delegates `isNew`/`isArchived` to this service per user.
- `HomeworkItem` and `BehaviorItem` no longer have `isNew`/`isArchived` columns — state lives in `UserItemState`.
- `MailConversation.isNew` renamed to `isUnread` throughout.

### Feed & Dashboard

- `FeedService` defaults `isNew: true, isArchived: false` (no per-user context without userId). Mail feed items map `conv.isUnread → isNew`.
- `DashboardService` queries items without `isNew`/`isArchived` filters (fields no longer on the model).

### Infrastructure

- Redis service added to `docker-compose.yml` with `maxmemory 256mb`, `allkeys-lru`, `--save ""`.
- Backend `depends_on` redis with `condition: service_healthy`.
- New env vars: `REDIS_URL`, `SESSION_LIFETIME_DAYS`, `SESSION_SECURE_COOKIE` added to `.env.example` files.
- `backend/scripts/migrate-phase2.ts` migration script added.

## Test Results

- 170 tests pass across 13 suites.
- Build: `nest build` succeeds with no errors.

## Key Files

- `backend/src/session/mashov-session.service.ts` — per-connection session cache
- `backend/src/session/mashov-http.client.ts` — `getForConnection<T>()`
- `backend/src/children/children.service.ts` — delegates state to `UserItemStateService`
- `backend/src/sync/tasks/*.task.ts` — all updated for multi-household loop
- `backend/prisma/schema.prisma` — `UserItemState` model, `isUnread` on `MailConversation`
- `docker-compose.yml` — Redis service entry
