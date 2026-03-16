# ADR-0017: Caching Strategy — Conditional Redis

- **Date**: 2026-03-16
- **Status**: Accepted
- **Deciders**: Planner
- **Supersedes**: [ADR-0002](0002-no-redis-postgres-cache.md)

## Context and Problem Statement

ADR-0002 correctly rejected Redis for Phase 1: no authentication, single household, 5-minute sync cadence, and sub-50ms indexed DB reads made the operational cost of Redis unjustifiable. Phase 2 changes the workload profile in two concrete ways. First, every API request now validates a session cookie against a DB row — a synchronous DB round-trip on every request, including the frontend's aggressive polling cycle (sync status every 3 seconds, TanStack Query revalidation on focus). Second, login rate-limiting state (N failed attempts per IP per 15-minute window) requires a fast, TTL-native store; an in-process counter doesn't survive restarts and a DB write on every login attempt is disproportionate overhead. The question is whether these two Phase 2 use cases individually or collectively justify introducing Redis.

## Decision Drivers

- **Session validation is now on the hot path** — every authenticated request, including 3-second polling, executes a DB round-trip; at household scale this is individually cheap but cumulatively meaningful
- **Rate-limiting state is TTL-native** — login attempt counters must expire automatically after 15 minutes; DB-backed counters require a scheduled cleanup job or `DELETE WHERE created_at < NOW() - INTERVAL`; Redis TTL keys handle this natively at zero operational cost
- **Redis is already conditionally justified by one use case** — once the infrastructure service is present for rate limiting, the marginal cost of using it for session caching is zero; rejecting the second use case on grounds of "no Redis" becomes circular
- **ADR-0002 explicitly named Phase 2 auth as the correct trigger** — "The Phase 2 trigger — multi-household support with concurrent users and per-user session management — is the correct point to introduce Redis, when the architectural need is genuine"
- **Docker Rules require `maxmemory` and `maxmemory-policy`** — Redis configuration is non-negotiable per project rules; the risk ADR-0002 flagged (disk exhaustion) is mitigated by enforcing `--maxmemory 256mb --maxmemory-policy allkeys-lru` in the compose definition

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Redis for session cache + rate limiting only** — cache-aside on session token validation (5-min TTL), TTL-keyed counters for login rate limiting; PostgreSQL remains source of truth for all persistent data | Eliminates DB lookup on hot-path session validation; TTL-native rate-limit counters with no cleanup job; one infrastructure service serves both use cases; ADR-0002 explicitly deferred this decision to Phase 2 | Adds a third Docker service; cache invalidation on session revocation must be correct (miss = stale session for up to 5 min) | **Selected** |
| Redis as general data cache | Sub-millisecond reads for all data; positions the stack for future read scaling | Cache invalidation must be wired to every sync write path; sync cadence is still 5 minutes — data caching remains unjustified at this cadence; significant added complexity for no measurable benefit on bounded cardinality queries | Rejected |
| DB-only for both session validation and rate limiting | No new infrastructure service; simpler compose | DB round-trip on every session validation at 3-second polling cadence; rate-limit counters require cleanup job or complex `ON CONFLICT` upsert logic; misses the natural trigger ADR-0002 described | Rejected |
| In-process memory for rate limiting | Zero infrastructure; fastest possible counter increment | Does not survive process restarts — a server restart resets all rate-limit windows; in a containerized deployment, restart is a routine event (deploy, crash, OOM kill) | Rejected |

## Decision Outcome

**Chosen**: Redis for session cache and rate limiting only

**Rationale**: ADR-0002 deferred Redis to the point where "the architectural need is genuine." Two independent Phase 2 requirements converge on that point simultaneously. Rate-limiting counters with automatic expiry are the canonical Redis use case — the TTL primitive eliminates an entire cleanup-job concern that any DB-backed implementation must solve. Session validation caching addresses the specific polling pattern introduced in Phase 2: a 3-second poll cycle means session validation runs dozens of times per minute per active user; reducing that from a 2–5ms indexed DB read to a sub-millisecond Redis GET is a structural improvement, not premature optimization. The critical constraint from ADR-0002 — preventing disk exhaustion — is addressed by mandatory `maxmemory: 256mb` and `maxmemory-policy: allkeys-lru` configuration. PostgreSQL remains the authoritative store for all persistent data; Redis holds only ephemeral, safely-discardable keys.

**Positive Consequences**:
- Session validation overhead is eliminated for active sessions; the hot path (3-second polling) bypasses the DB on cache hits
- Rate-limit counters are stateless across restarts with no cleanup job required — Redis TTL handles expiry natively
- Both use cases are served by a single Redis instance with identical configuration; the infrastructure cost is paid once
- Redis restart (deploy, crash) transparently degrades to DB validation for all sessions — no user-visible impact since PostgreSQL is the source of truth

**Negative Consequences / Risks**:
- Cache invalidation on session revocation must be correct: a missed `Redis DEL session:<token>` means a revoked session appears valid for up to 5 minutes — mitigated by always querying the DB on cache miss and verifying `revoked_at IS NULL`
- Redis data is intentionally ephemeral — `--save ""` disables RDB persistence; a restart clears all cached sessions, requiring one extra DB round-trip per active session until the cache warms
- Third infrastructure service increases compose startup complexity and adds one more failure mode to diagnose; mitigated by a simple `redis-cli ping` health check with `depends_on: condition: service_healthy`

## Links

- Supersedes: [ADR-0002 — No Redis — PostgreSQL as the Read Layer](0002-no-redis-postgres-cache.md)
- Related: [ADR-0019 — Session Strategy — DB Sessions with Redis Cache](0019-session-strategy-db-with-redis-cache.md)
- Implemented in: `docker-compose.yml` (redis service), `backend/src/auth/session.service.ts`, `backend/src/auth/rate-limit.guard.ts`
