# ADR-0015: Session Token Strategy — Server-Side DB Sessions over JWT Cookies

- **Date**: 2026-03-16
- **Status**: Accepted
- **Deciders**: Planner, Backend agent

## Context and Problem Statement

Phase 2 requires session management for authenticated parents. Once a magic-link is consumed and identity is confirmed, the app must issue a credential that survives page navigation and browser restarts. Two mainstream approaches exist: a self-contained signed token (JWT) stored in an httpOnly cookie, or an opaque random token stored in an httpOnly cookie that is validated against a server-side session record. The choice determines revocation capability, DB coupling, information exposure risk, and operational complexity. This decision is upstream of every protected API route in Phase 2.

## Decision Drivers

- **Revocation must be instant** — The "sign out on all devices" use case (parent changes phone, child uses parent's device) requires immediate, unconditional session termination. JWT revocation requires a blocklist, which reintroduces a DB lookup on every request — eliminating the statelessness benefit that makes JWTs appealing.
- **Deployment model is single-node, DB-always-available** — This is a private household deployment running on a single server with a co-located PostgreSQL instance. The canonical argument for JWT statelessness — "avoid a DB hit on every request to support horizontal scaling" — does not apply.
- **Opaque tokens carry no information** — JWTs are base64-encoded and readable by any client with browser dev tools. An opaque session token reveals nothing about the user, session metadata, or signing algorithm. Given that session cookies are transmitted on every request, opaque tokens are the strictly lower-risk format.
- **No JWT secret rotation complexity** — Rotating a JWT signing secret invalidates all outstanding tokens simultaneously. Managing rotation without mass-logout requires versioned secrets or short-lived tokens with refresh tokens — an added complexity layer this app has no need for.

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Server-side DB session** — `crypto.randomBytes(32)` token stored in `app_session` table; cookie holds the opaque token; every request validates against the DB with an indexed lookup | Instant revocation via `revokedAt`; opaque token leaks no information; no secret rotation; straightforward audit of all active sessions; indexed lookup is < 1 ms on the household scale | Every authenticated request touches the DB; cannot be validated without DB access (rules out stateless API gateways) | **Selected** |
| **JWT in httpOnly cookie** — signed token containing `userId` and `exp`; validated by verifying the signature without a DB lookup | Stateless validation; no DB hit per request; well-understood format with broad library support | Cannot be revoked without a blocklist (a DB lookup, defeating statelessness); JWT payload is readable by clients; secret rotation requires coordinated token migration; `exp` must be short enough to limit exposure, requiring refresh token complexity | Rejected |

## Decision Outcome

**Chosen**: Server-side DB session stored in `app_session` table

**Rationale**: The primary argument for JWTs — stateless validation to avoid per-request DB overhead — does not survive contact with the revocation requirement. A JWT without revocation capability is acceptable only in systems where token compromise is an acceptable risk until natural expiry. A private household app where a parent can grant a child-facing session that must be terminable on demand does not meet that bar. Adding a blocklist to enable revocation reintroduces the DB lookup, leaving only the downsides of JWTs: a readable payload, secret rotation complexity, and the operational burden of refresh token flows. The server-side session model with an indexed `sessionToken` column delivers sub-millisecond validation latency at the scale of this deployment, supports instant revocation by writing a single `revokedAt` timestamp, and produces no information in the cookie value itself. The inability to validate sessions without DB access is the accepted trade-off, and it is not a constraint that matters for a single-node deployment.

**Positive Consequences**:
- Revocation is atomic: a single `UPDATE app_session SET revokedAt = NOW() WHERE token = $1` terminates a session on the next request.
- All active sessions for a user are enumerable — a "sign out all devices" operation is a single `UPDATE ... WHERE userId = $1 AND revokedAt IS NULL`.
- No JWT library dependency; no signing secret to manage or rotate.
- Session metadata (last used, IP, user agent) can be stored on the `app_session` row without expanding the cookie.

**Negative Consequences / Risks**:
- Every authenticated request executes a DB read (mitigated by a unique index on `app_session.token`; at household scale this adds negligible latency).
- A session cleanup cron is required to purge expired and revoked rows. Without it, the table grows indefinitely. Scheduled for daily at 02:00, consistent with the sync layer's maintenance window convention.
- If the DB is unavailable, no authenticated request can be served — the app is fully unavailable rather than degraded. This is accepted: the DB is a hard dependency for all data reads regardless.

## Links

- Related: [ADR-0014 — Authentication Strategy — Custom Magic-Link with DB Sessions](0014-magic-link-authentication.md)
- Related: [ADR-0002 — No Redis — PostgreSQL as the Read Layer](0002-no-redis-postgres-cache.md)
- Implemented in: `backend/src/auth/` (to be created in Phase 2)
- Implemented in: `backend/prisma/schema.prisma` (`AppSession` model, to be added in Phase 2)
