# ADR-0014: Authentication Strategy — Custom Magic-Link with DB Sessions

- **Date**: 2026-03-16
- **Status**: Accepted
- **Deciders**: Planner, Backend agent

## Context and Problem Statement

Phase 2 introduces parent authentication to the Mashov Parent Command Center. The upstream Mashov school system already owns school credentials; parents interacting with this app need an independent, low-friction mechanism to prove identity. The app is a private household deployment (1–5 users) with no social login requirement and no enterprise IdP. A decision was needed on which auth library or service to adopt — and whether to adopt one at all.

## Decision Drivers

- **No OAuth provider exists for this app** — School credentials belong to the upstream Mashov API, not to a Google or GitHub account. Social login via OAuth would authenticate nothing relevant to the app's trust model.
- **Backend lives in NestJS, not Next.js** — Auth logic must execute in the NestJS API layer. Libraries tightly coupled to the Next.js request lifecycle (e.g., NextAuth) are architecturally misaligned.
- **Private household deployment** — External auth services (Auth0, Clerk, Supabase Auth) introduce vendor dependency, ongoing cost, and external data residency for a system that has a closed user list and no public registration.
- **Minimal dependency surface** — Node.js `crypto` handles secure token generation natively. Adding a strategy framework to wrap a single auth strategy adds complexity without abstraction benefit.
- **Revocation and session control are required** — Parents need to sign out on all devices ("disconnect account"). This requirement drives toward server-side session storage regardless of the token format used.

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Custom magic-link with DB sessions** — Node `crypto` generates a one-time token; Nodemailer/Resend delivers it; an `app_session` table tracks active sessions via httpOnly cookie | No vendor dependency; owns revocation; auditable ~200-line implementation; aligns with existing DB-first architecture; no strategy framework needed for a single auth flow | Must implement expiry, revocation, and cleanup cron ourselves; no community support path if edge cases arise | **Selected** |
| **NextAuth.js** | Large ecosystem; built-in magic-link adapter; handles session cookies automatically | Designed for the Next.js layer (route handlers / API routes) — not a NestJS middleware; forces auth responsibility into the wrong tier of the architecture | Rejected |
| **Passport.js** | NestJS-compatible; mature; strategy pattern supports future additions | A strategy framework whose value proposition is multi-strategy pluggability — adding it for a single strategy that will never grow adds ~3 abstractions for zero reuse | Rejected |
| **External auth service (Auth0 / Clerk / Supabase Auth)** | Instant production-grade auth; handles email delivery, MFA, device management | Vendor lock-in; ongoing cost for a household tool; user data (email addresses) leaves the self-hosted environment; over-engineered for a known, static user list | Rejected |

## Decision Outcome

**Chosen**: Custom magic-link with DB sessions

**Rationale**: The two most common rejections for custom auth implementations are scope and complexity — neither applies here. The user list is closed, the auth flow is a single pattern (magic-link), and the entire implementation fits in three database tables (`app_user`, `app_session`, `magic_link_token`) and roughly 200 lines of service code. NextAuth was disqualified structurally: it executes inside the Next.js request lifecycle, and placing auth logic there would split authentication responsibility between the Next.js layer and the NestJS layer that enforces it on every API route. Passport.js offers no advantage over plain NestJS middleware guards when there is only one auth strategy and no foreseeable need for a second. External services would be appropriate if this app were public-facing or needed MFA, audit logs, or multi-tenant isolation — none of which appear in the PRD. Node `crypto` is auditable, has no CVE exposure surface beyond the Node runtime itself, and satisfies the token generation requirement without introducing a package dependency.

**Positive Consequences**:
- Auth implementation is fully auditable with no framework abstraction hiding the session lifecycle.
- Revocation is immediate: setting `revokedAt` on an `app_session` row invalidates that session on the next request.
- No external service dependency; auth works offline and in air-gapped deployments.
- Email transport is configurable via env vars — Nodemailer SMTP for self-hosted, Resend API for managed delivery — without changing the auth logic.

**Negative Consequences / Risks**:
- The team owns the full session lifecycle: token expiry (15-minute magic-link window), session expiry (configurable TTL), revocation, and cleanup cron. Each of these must be tested explicitly.
- No social login is available in Phase 2. This is explicitly out of scope per the PRD and acceptable given the closed user list.
- A session cleanup cron (daily purge of expired and revoked sessions) is required to prevent unbounded table growth — this is a maintenance responsibility not present in a managed auth service.

## Links

- Related: [ADR-0015 — Server-Side DB Sessions over JWT Cookies](0015-server-side-db-sessions.md)
- Related: [ADR-0016 — Per-User State via user_item_state Table](0016-per-user-item-state.md)
- Implemented in: `backend/src/auth/` (to be created in Phase 2)
