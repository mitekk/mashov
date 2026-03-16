# ADR-0002: No Redis — PostgreSQL as the Read Layer

- **Date**: 2026-03-11
- **Status**: Superseded by [ADR-0017](0017-caching-strategy-conditional-redis.md)
- **Deciders**: Planner (Step 1 architecture)

## Context and Problem Statement

The PRD requires fast dashboard reads — the Home screen must load in under 2 seconds on a mobile connection and display a unified view of notifications, mail, homework, and behavior across all children. The canonical pattern for read-performance in sync-heavy applications is an in-memory cache (Redis) sitting in front of the database. However, the upstream Mashov API imposes its own cadence floor: the fastest sync cycle is every 5 minutes. The question is whether the read-performance gap between PostgreSQL and Redis materially affects user experience given data that changes at most 12 times per hour.

## Decision Drivers

- Upstream sync cadence is 5 minutes minimum — data staleness is bounded by the sync schedule, not by database read latency
- Deployment target is a single household running Docker Compose — operational simplicity is a first-class concern; every additional service is a failure mode the household operator must manage
- Dashboard queries are bounded and indexed: the `DashboardService` joins a fixed set of tables with known cardinality (2–5 children, hundreds of events, not millions)
- Phase 2 explicitly defers multi-household support and app authentication — both are the natural triggers for Redis (session storage, per-user cache invalidation)
- Redis without a `maxmemory` policy on a household machine is a disk-exhaustion risk (as noted in the Docker rules); correct Redis configuration adds ops knowledge requirements

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **PostgreSQL only** | Eliminates a Docker service; no eviction policy, persistence, or `maxmemory` configuration to manage; indexed queries return dashboard data in <50ms warm; sync writes and API reads share a single consistency boundary | Cannot serve sub-millisecond reads; if concurrent users or write frequency increase significantly, read latency will grow | **Selected** |
| Redis as cache layer | Sub-millisecond read latency; well-understood pattern for hot-path data; supports pub/sub for future live updates | Adds a third Docker service with its own failure mode; requires eviction policy configuration (`allkeys-lru`, `maxmemory` cap); cache invalidation must be wired to every sync write path; persistence decisions (RDB/AOF) add further ops complexity; provides no measurable benefit at 5-minute sync cadence | Rejected |
| Redis for session storage only (not data cache) | Separates auth state from DB; standard for multi-tenant apps | Phase 1 has no app authentication — there are no sessions to store; premature for Phase 1 scope | Rejected |

## Decision Outcome

**Chosen**: PostgreSQL only (no Redis in Phase 1)

**Rationale**: The decision hinges on the relationship between sync cadence and read latency. Dashboard data changes at most every 5 minutes; a PostgreSQL query returning stale-by-30-seconds data is indistinguishable from one returning stale-by-50ms data from the user's perspective. Properly indexed joins across the 15-table schema return dashboard results in under 50ms warm — well within the 2-second mobile load target with room for network overhead. The operational cost of Redis in a household deployment is non-trivial: `maxmemory` must be set to prevent disk exhaustion, eviction policy must match access patterns, and the service adds another failure mode that the operator must diagnose. These costs are justified when Redis provides a material benefit; at 5-minute cadence with bounded data cardinality, it does not. The Phase 2 trigger — multi-household support with concurrent users and per-user session management — is the correct point to introduce Redis, when the architectural need is genuine.

**Positive Consequences**:
- `docker-compose.yml` has two services (backend + postgres) rather than three; the stack is simpler to start, stop, and debug for a household operator
- No cache invalidation logic to maintain: sync writes to Postgres and API reads from Postgres share a single consistency boundary
- No `maxmemory`/eviction policy decisions deferred to the operator at install time

**Negative Consequences / Risks**:
- If sync write frequency increases (e.g., per-minute cadence in a future iteration) or read concurrency grows (multi-household), PostgreSQL read latency will climb without a cache layer; the migration path to Redis at that point requires wiring invalidation into every sync write path
- Dashboard query performance depends on index maintenance; `EXPLAIN ANALYZE` must be used to validate query plans as the schema evolves
- Without Redis, there is no straightforward path to pub/sub or live dashboard updates (WebSocket push) in a future iteration without introducing it or an alternative

## Links

- Related: [ADR-0001 — NestJS backend framework](0001-backend-framework-nestjs.md)
- Implemented in: `backend/src/dashboard/dashboard.service.ts`, `docker-compose.yml`
