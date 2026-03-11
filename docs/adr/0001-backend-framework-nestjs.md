# ADR-0001: Backend Framework — NestJS over Fastify

- **Date**: 2026-03-11
- **Status**: Accepted
- **Deciders**: Planner (Step 1 architecture)

## Context and Problem Statement

The Mashov Parent Command Center backend must run 11 independent cron jobs across 7 cadence groups, all sharing a single upstream session service that manages CSRF tokens, cookie jars, and re-authentication. Every sync task requires the same `MashovSessionService` to obtain auth headers, detect 401/403 mid-request, and trigger re-auth before retry. Beyond the sync engine, the backend exposes 17 REST route handlers across 8 domain modules. A framework choice that required manual wiring of dependency injection and scheduling would significantly increase surface area for bugs in the session-sharing contract.

## Decision Drivers

- `MashovSessionService` must be injected into every sync task; manual wiring across 11 cron tasks is high-risk
- 11 cron jobs with 7 distinct cadence groups require a reliable, first-class scheduling primitive — not an ad-hoc `setInterval` wrapper
- Domain module boundaries (SessionModule, SyncModule, MailModule, ChildrenModule, etc.) map 1:1 to business subdomains and should be enforced structurally, not by convention
- The deployment target is a single household Docker container — raw throughput performance is not a selection criterion
- Prisma ORM integration requires no special adapter; NestJS and Fastify are equally compatible

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **NestJS** | Built-in DI container eliminates manual injection wiring; `@nestjs/schedule` provides first-class cron support with decorators; modular structure enforces domain separation structurally; decorator-based controllers reduce route boilerplate | Higher initial boilerplate than Fastify; heavier runtime (~50MB vs ~10MB); framework conventions require team familiarity | **Selected** |
| Fastify | Minimal core; lower memory footprint; faster raw throughput; familiar to teams preferring a micro-framework | No built-in DI — `fastify-cron` or `node-cron` would require manual injection of `SessionService` into every task; module organization is by convention only, not enforcement; scheduling reliability depends on third-party plugin quality | Rejected |

## Decision Outcome

**Chosen**: NestJS

**Rationale**: The session service is the load-bearing piece of the entire sync architecture — it holds the upstream cookie jar, handles CSRF token refresh, and must be available to every one of the 11 cron tasks without duplication or shared global state. NestJS's DI container makes this contract explicit and compiler-verified: a task that fails to declare `SessionService` in its constructor will not compile. `@nestjs/schedule` handles cron registration, overlapping-run protection, and lifecycle management as a first-class concern rather than an application-level responsibility. The modular structure (each domain becomes a NestJS module) prevents accidental coupling between, say, `MailModule` and `ChildrenModule` in a way that a Fastify plugin registry does not enforce. The performance gap between NestJS and Fastify is irrelevant at household scale — the bottleneck is upstream Mashov API latency, not local request throughput.

**Positive Consequences**:
- `MashovSessionService` injection is structurally enforced: adding a new sync task requires declaring the dependency explicitly, making omission a compile error rather than a runtime bug
- `@nestjs/schedule` prevents overlapping cron runs out of the box, which matters for tasks that may take longer than their cadence under degraded network conditions
- Module boundaries map directly to the architecture diagram, making future agents' orientation fast

**Negative Consequences / Risks**:
- NestJS startup time and memory footprint (~50MB) are higher than Fastify; acceptable for a household deployment, but a constraint if the target ever shifts to edge/serverless
- Decorator-based code can be unfamiliar to contributors who have not worked in Angular-style frameworks; the learning curve is front-loaded at onboarding
- Boilerplate for module/controller/service files is higher per domain; mitigated by the NestJS CLI scaffolding

## Links

- Related: [ADR-0004 — Prisma ORM](0004-prisma-orm.md)
- Implemented in: `backend/src/app.module.ts`, `backend/src/sync/`, `backend/src/session/`
