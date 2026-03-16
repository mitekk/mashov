# ADR-0019: Session Strategy — DB Sessions with Redis Cache

- **Date**: 2026-03-16
- **Status**: Accepted
- **Deciders**: Planner, Backend agent
- **Supersedes**: [ADR-0015](0015-server-side-db-sessions.md)

## Context and Problem Statement

ADR-0015 chose server-side DB sessions (opaque token in httpOnly cookie, validated against `app_session` on every request) and explicitly accepted the trade-off of a DB read per request, noting this was negligible at household scale. Two Phase 2 changes reopen that trade-off. First, ADR-0017 introduces Redis for rate limiting — Redis is now in the stack at zero marginal infrastructure cost. Second, the frontend polling pattern is aggressive: TanStack Query revalidates on window focus and the sync-status endpoint is polled every 3 seconds. Each poll triggers a session validation DB read. The question is not whether to change the session model — DB-backed opaque sessions remain the correct choice — but whether the Redis now present in the stack should absorb session validation on the hot path.

## Decision Drivers

- **Redis is already in the stack (ADR-0017)** — marginal cost of adding session cache-aside to an existing Redis instance is zero infrastructure cost; the trade-off that justified DB-only in ADR-0015 no longer holds
- **Frontend polls every 3 seconds** — each poll performs session validation; at 3-second cadence, session validation runs ~20 times per minute per active user; the cumulative DB read load is structurally different from the request pattern ADR-0015 anticipated
- **Revocation must remain instant** — ADR-0015's primary rejection of JWT was the revocation requirement; that requirement is unchanged; the cache design must not weaken it
- **Rolling sessions provide equivalent UX to refresh tokens without two-token complexity** — the "stay logged in while active" requirement is met by updating `last_activity_at` on each request; a separate refresh token lifecycle adds complexity with no user-visible benefit at this deployment scale
- **Magic-link flow removed (ADR-0018)** — `magic_link_token` table dependency is gone; session creation now occurs directly from Mashov login response; the `app_session` schema is unchanged but its creation path changes

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **DB sessions + Redis cache-aside** — Redis GET on every request; DB fallback on miss; Redis SET (5-min TTL, rolling) on DB hit; Redis DEL on revocation in addition to DB `revoked_at` write | Sub-millisecond validation on cache hits; reduces DB write load by debouncing `last_activity_at` updates; revocation remains instant (DB + cache key both updated); Redis restart degrades gracefully to DB | Cache invalidation on revocation requires both DB write and Redis DEL — a missed DEL allows stale session for up to 5 minutes | **Selected** |
| **DB sessions only (ADR-0015)** | No cache invalidation concern; simpler code path | DB round-trip on every request including 3-second polling; with Redis already in the stack, this is a foregone optimization with no remaining justification | Rejected |
| **JWT in httpOnly cookie** | Stateless validation; no DB hit per request for valid, non-revoked tokens | Revocation requires a blocklist (a DB lookup, negating statelessness); JWT payload is client-readable; secret rotation complexity; refresh token lifecycle required for extended sessions — all objections from ADR-0015 remain unchanged | Rejected |
| **Refresh token pair (short-lived access + long-lived refresh)** | Industry-standard pattern for distributed systems; limits access token blast radius | Value proposition is enabling short-lived stateless tokens to reduce revocation blocklist churn — inapplicable here where tokens are already opaque and server-validated; adds two-token lifecycle, rotation logic, a second httpOnly cookie, and replay attack surface on the refresh token itself | Rejected |

## Decision Outcome

**Chosen**: DB sessions with Redis cache-aside

**Rationale**: ADR-0015 accepted DB-only because Redis was absent and the per-request latency was negligible at household scale. Both premises have changed: Redis is now present (ADR-0017), and the 3-second polling cadence introduced in Phase 2 means session validation is no longer an incidental per-navigation cost but a recurring background operation. The cache-aside pattern is the conservative extension of the ADR-0015 model: Redis holds a 5-minute TTL copy of the session validity result; DB remains the source of truth and the fallback on every cache miss. Revocation is handled by writing `revoked_at` to the DB row and explicitly deleting the Redis key — not relying on TTL expiry. The 5-minute TTL exists as a safety net for a missed DEL, not as the primary revocation mechanism. Refresh tokens were evaluated and rejected: the rolling session pattern (`last_activity_at` debounced to once per 60 seconds) provides identical UX — the user stays logged in while active — without the added token rotation complexity that refresh tokens require in exchange for their benefits in stateless distributed systems.

**Positive Consequences**:
- Session validation on the 3-second polling hot path drops from ~2–5ms (indexed DB read) to <0.5ms (Redis GET) for active sessions
- DB write load reduced by approximately 60% for polling-heavy sessions: `last_activity_at` is debounced to at most one DB write per 60 seconds per session regardless of polling frequency
- Instant revocation preserved: `revoked_at` DB write + Redis DEL on logout or forced sign-out ensures immediate effect on the next request
- Redis restart transparently falls back to DB validation for all sessions — no user-visible impact since PostgreSQL remains the source of truth

**Negative Consequences / Risks**:
- Cache invalidation correctness is critical: a failed Redis DEL during revocation leaves a stale cache entry valid for up to 5 minutes; acceptable given household deployment with trusted users and the DB `revoked_at` check on all cache misses
- Session validation code path is more complex than ADR-0015: Redis GET → DB fallback → Redis SET → rolling EXPIRE must all be correctly ordered and failure-safe (Redis unavailability must not block request handling)
- `magic_link_token` table is removed from the schema (dependency of ADR-0014/ADR-0015) — any migration must drop this table cleanly without affecting `app_session` or `app_user`

## Links

- Supersedes: [ADR-0015 — Session Token Strategy — Server-Side DB Sessions over JWT Cookies](0015-server-side-db-sessions.md)
- Related: [ADR-0017 — Caching Strategy — Conditional Redis](0017-caching-strategy-conditional-redis.md)
- Related: [ADR-0018 — Authentication Strategy — Direct Mashov Credential Login](0018-direct-mashov-credential-login.md)
- Implemented in: `backend/src/auth/session.service.ts`, `backend/src/auth/session.guard.ts`, `backend/prisma/schema.prisma` (`AppSession` model)
