# ADR-0022: Next.js Middleware Auth Check — Read `mashov_session` Cookie, Not `session`

- **Date**: 2026-03-17
- **Status**: Accepted
- **Deciders**: Frontend agent, Smoke test verifier

## Context and Problem Statement

The Next.js middleware that guards protected routes checked for the presence of `request.cookies.get('session')`. The backend (NestJS) sets `Set-Cookie: mashov_session=<token>` on successful login (per ADR-0018 and ADR-0019). The name mismatch meant the middleware evaluated every request from a logged-in user as unauthenticated, producing an unconditional redirect to `/auth/sign-in`. The redirect target itself was unprotected, so the loop terminated — but no protected route was reachable. The defect was masked during component-level development because E2E auth setup injected a cookie named `session` via Playwright `storageState`, which matched the (incorrect) middleware check.

## Decision Drivers

- The cookie name is a stable, documented interface between the NestJS auth layer and the Next.js middleware; it must be consistent across both sides
- `security.md` mandates httpOnly cookies for session tokens; the backend owns the cookie name and the middleware is a consumer of that contract
- The smoke test phase (Step 5.7) revealed the loop by navigating as an authenticated user and observing the infinite redirect in network traces — a failure mode that Playwright `storageState`-based tests had not caught
- Changing the backend cookie name is a schema-level change affecting session table lookups, existing sessions in Redis, and the logout handler; it carries more blast radius than changing the middleware string

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Change middleware to read `mashov_session` | One-line fix; consumer adapts to producer; backend session infrastructure unchanged | None of significance at current scale | **Selected** |
| Change backend to emit a `session` cookie name | Middleware requires no change | Requires coordinated update to session lookup, Redis key prefix, logout handler, and any existing live sessions; `session` is a generic name that risks collision with third-party session cookies on the same origin | Rejected |
| Introduce a shared constant for the cookie name, imported by both backend and middleware | Eliminates future drift; enforced at compile time | Requires a shared package or monorepo-level module; over-engineering for a single stable string; the interface is now documented and tested | Rejected |

## Decision Outcome

**Chosen**: Update the Next.js middleware to read `request.cookies.get('mashov_session')`.

**Rationale**: The backend is the authoritative producer of the session cookie; the middleware is a consumer. When producer and consumer disagree on a contract detail, the consumer adapts — changing the producer requires coordinated migration of all downstream consumers (Redis keys, logout handler, session table) and invalidates any live sessions. The `mashov_session` name is also preferable on its own merits: it is project-scoped and avoids collision with the generic `session` cookie name that third-party services (analytics, support widgets) may also set on the same origin. The shared constant approach (Option C) is the right long-term answer for a mature monorepo but is disproportionate for one string that has now been stabilized and is tested end-to-end. The E2E test suite's use of `storageState` with a `session` cookie name is an independent concern: that setup is specific to Playwright's auth project and does not interact with the production session middleware path.

**Positive Consequences**:
- All authenticated navigation paths reach their destination without redirect loops
- The cookie name contract is now consistent across backend, middleware, logout, and documentation
- The smoke test scenario (navigate as authenticated user, verify no redirect) is now a regression gate in E2E

**Negative Consequences / Risks**:
- The cookie name remains a bare string literal in the middleware; a future rename of the backend cookie (e.g., to support multi-tenant prefixes) will silently break auth again unless the middleware is updated in the same change — the shared constant approach (Option C) would prevent this, and the team should revisit it if the cookie name ever needs to change
- Playwright `storageState`-based tests that inject a `session` cookie (not `mashov_session`) continue to work because they target routes that Playwright navigates to after auth setup, bypassing the middleware redirect logic — this is acceptable but means those tests do not exercise the middleware path

## Links

- Related: [ADR-0018](0018-direct-mashov-credential-login.md) — auth mechanism that establishes the session cookie
- Related: [ADR-0019](0019-session-strategy-db-with-redis-cache.md) — session strategy that determines cookie lifecycle and name
- Implemented in: `frontend/src/middleware.ts`
