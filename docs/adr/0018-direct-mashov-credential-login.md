# ADR-0018: Authentication Strategy — Direct Mashov Credential Login

- **Date**: 2026-03-16
- **Status**: Accepted
- **Deciders**: Planner, Backend agent
- **Supersedes**: [ADR-0014](0014-magic-link-authentication.md)

## Context and Problem Statement

ADR-0014 chose a custom magic-link flow on the assumption that parents need an independent identity layer — an email address as their primary credential. That assumption was wrong. Every user of this app already holds a Mashov school portal account with a username, password, and associated school code (`semel`). The app's only purpose is to surface data from that portal. Treating Mashov credentials as a second-factor while building a separate identity layer (email, magic-link tokens, Nodemailer transport) adds infrastructure and maintenance burden for an authentication problem Mashov already solves. The question is how to replace the magic-link flow with a model that uses Mashov directly as the credential authority.

## Decision Drivers

- **Mashov is already the credential authority for all app users** — every parent has a Mashov username and password; there is no population of users who have email but lack Mashov credentials
- **Magic-link requires email, which is not part of Mashov identity** — the Mashov API returns `credential.userId` and `credential.displayName`, not an email address; sourcing email addresses requires a separate registration step with no upstream validation
- **Email transport is an operational dependency** — magic-link delivery requires either a self-hosted SMTP server or an external relay (Resend, SendGrid); for a household deployment, both are friction that vanishes if login uses Mashov directly
- **Auth and data access share the same credential** — the Mashov session returned on login is also the credential the background sync engine uses; authenticating via Mashov eliminates the need to store and manage a separate credential set for sync
- **Household deployment has a closed, known user list** — external auth services (Auth0, Clerk) are designed for public user registration at scale; they provide no benefit over a direct Mashov call for a system where every user is a Mashov account holder

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Direct Mashov credential login** — backend receives `{ semel, username, password }`, derives `year` from the school list, calls `POST https://web.mashov.info/api/login`, upserts `app_user` on success, creates `app_session` | No email transport; no token table; no bootstrap config; users already know their credentials; auth and sync use the same upstream call | App auth is coupled to Mashov uptime at login time — if Mashov API is down, new logins fail (existing sessions remain valid); Mashov can change their API contract | **Selected** |
| **Magic-link with email (ADR-0014)** | Familiar UX pattern; email-based identity is portable | Email is not part of Mashov identity — requires sourcing email addresses out-of-band; adds Nodemailer transport dependency; `magic_link_token` table lifecycle management; onboarding step Mashov login already replaces | Rejected |
| **Passport.js LocalStrategy wrapping Mashov** | NestJS-compatible; strategy pattern supports future additions | Framework abstraction for a single custom strategy with no foreseeable second strategy; adds ~3 layers of indirection over a direct HTTP call to `web.mashov.info`; hides the upstream call behind a framework that provides no reuse value here | Rejected |
| **External auth service (Auth0, Clerk, Supabase Auth)** | Production-grade auth; MFA; device management | Vendor lock-in; ongoing cost; user identity data leaves the self-hosted environment; requires mapping from external identity to Mashov identity anyway — the mapping problem is not solved, only deferred | Rejected |

## Decision Outcome

**Chosen**: Direct Mashov credential login

**Rationale**: The magic-link approach solved the wrong problem. It treated "authenticating to this app" as distinct from "authenticating to Mashov," but for all users of this app, those are the same act. Routing authentication through Mashov directly means the `magic_link_token` table, email transport configuration, 15-minute token expiry windows, and token cleanup cron are all eliminated — not replaced with something simpler, but removed entirely because they solved a problem that does not exist. The coupling risk — Mashov downtime blocks new logins — is real but bounded: existing sessions remain valid after login, so an active user is unaffected by Mashov downtime unless they explicitly log out. The Mashov API is also the data dependency for every sync operation; if it changes its contract, the sync engine breaks regardless of auth strategy. Auth coupling to Mashov is therefore not a new risk surface — it is the same risk already accepted for the core data pipeline.

**Positive Consequences**:
- No email transport infrastructure (SMTP relay, Resend API key, delivery reliability concern)
- No `magic_link_token` table, no 15-minute expiry logic, no cleanup cron for expired tokens
- No bootstrap admin step — any valid Mashov credential can log in; user is upserted on first successful login
- Onboarding requires only information the user already has (school, username, password); no separate app registration step
- Auth credential and sync credential are the same upstream call; the encrypted Mashov session stored in `household_connection` is a direct product of the login response

**Negative Consequences / Risks**:
- New logins are blocked if `web.mashov.info` is unavailable; mitigated by the fact that existing sessions continue to function and Mashov downtime already blocks all data syncs
- Mashov has no published API stability commitment; a breaking change to `POST /api/login` requires an auth layer update; monitored via the sync engine's existing error reporting
- The login error message must be deliberately generic ("Invalid credentials, please try again") — the app cannot distinguish wrong school vs wrong username vs wrong password from the Mashov response, and must not attempt to do so to avoid user enumeration

## Links

- Supersedes: [ADR-0014 — Authentication Strategy — Custom Magic-Link with DB Sessions](0014-magic-link-authentication.md)
- Related: [ADR-0019 — Session Strategy — DB Sessions with Redis Cache](0019-session-strategy-db-with-redis-cache.md)
- Related: [ADR-0016 — Per-User Read/Archive State](0016-per-user-item-state.md)
- Implemented in: `backend/src/auth/auth.service.ts`, `backend/src/auth/auth.controller.ts`, `backend/prisma/schema.prisma` (`AppUser`, `AppSession` models)
