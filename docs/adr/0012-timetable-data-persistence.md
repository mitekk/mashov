# ADR-0012: Timetable Data Persistence — Sync-and-Store over Live Proxy

- **Date**: 2026-03-16
- **Status**: Accepted
- **Deciders**: Backend agent, Planner

## Context and Problem Statement

The Mashov API exposes a timetable endpoint (`GET https://web.mashov.info/api/students/{studentId}/timetable`) that returns a student's weekly schedule. The Mashov parent app needs to display this data. Two fundamentally different delivery models were available: store a local copy that is periodically refreshed, or forward each client request to the upstream API at read time. The choice determines request latency, upstream coupling, session management complexity, and resilience characteristics for the entire timetable feature.

## Decision Drivers

- **Consistency with the established sync layer** — Every other data type in this project (homework, behavior events, subjects, notices) is delivered through the same scheduled-sync + Prisma-backed-read pattern. Diverging for a single data type would introduce an architectural split without offsetting benefit.
- **CSRF token and session lifetime** — Calling the Mashov API requires a live CSRF token and session cookie. Proxying requires threading those credentials through every HTTP request lifecycle, creating re-authentication risk if the upstream session expires between user interaction and the forwarded request.
- **Timetable data is near-static** — School timetables change at most once per semester. Reading from a local DB on every page view is faster and cheaper than accepting Mashov API latency on a dataset that almost never changes.
- **Resilience requirement** — The app must remain functional when the Mashov API is slow or temporarily unavailable, consistent with the offline-first resilience posture that motivated choosing PostgreSQL as the read layer (ADR-0002).

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Sync-and-store via weekly cron** — NestJS `@Cron('0 3 * * 0')` upserts timetable rows into `timetable_entry`; frontend reads from `/api/v1/children/{studentGuid}/timetable` | Consistent with all other data types; instant reads; resilient to upstream downtime; no CSRF in request path; reduced upstream load | Data can be up to 7 days stale; a mid-week timetable change requires a manual sync trigger | **Selected** |
| **Live proxy** — Each frontend request is forwarded to the Mashov API in real time with CSRF token and session cookies attached | Always returns the freshest data; no DB schema additions | Requires CSRF token management per-request; latency tied to Mashov API; app unusable if Mashov is down; breaks the uniform sync-layer contract; N×upstream requests per page view instead of one weekly fetch | Rejected |

## Decision Outcome

**Chosen**: Sync-and-store via weekly cron (`@Cron('0 3 * * 0')`)

**Rationale**: Timetable data belongs to a category that is functionally read-only after initial publication — schedule changes are administrative events that happen outside the normal school week, not real-time mutations. The sync-and-store model was already the correct choice for all other data types, and timetable fits more cleanly into that category than any of them: it has the lowest change frequency, the highest read frequency, and zero requirement for sub-minute freshness. Live proxying would purchase nothing of practical value (fresher data nobody needs between syncs) at the cost of re-authentication complexity, upstream coupling, and a break in the uniform architecture that every other backend module and the entire test strategy depend on. The weekly cron cadence was chosen specifically to match timetable update cycles, and the manual sync trigger available on the sync task provides an escape valve for the one realistic edge case — a mid-week schedule change.

**Positive Consequences**:
- Timetable reads are served from the local DB with consistent sub-millisecond latency, identical to every other data type.
- No CSRF token or session credential handling is required in the request path for timetable data; auth complexity remains confined to the sync layer.
- If the Mashov API is down, timetable data remains accessible unchanged — the app does not degrade.
- The sync architecture stays uniform: one pattern, one test strategy, one mental model for all data types.

**Negative Consequences / Risks**:
- Timetable data can be up to 7 days stale. A timetable change published mid-week will not appear in the app until the next scheduled sync at Sunday 3 AM or until a manual sync is triggered. This is accepted because timetable changes at most schools are communicated directly to students and parents through other channels before they take effect.
- A new Prisma model (`TimetableEntry`) with a unique constraint on `(studentGuid, day, lesson)` adds schema surface area that must be migrated in all environments.

## Links

- Related: [ADR-0002 — No Redis — PostgreSQL as the Read Layer](0002-no-redis-postgres-cache.md)
- Related: [ADR-0004 — Data Access — Prisma ORM over Knex or Raw SQL](0004-prisma-orm.md)
- Implemented in: `backend/src/sync/tasks/timetable.task.ts`
- Implemented in: `backend/prisma/schema.prisma` (`TimetableEntry` model)
