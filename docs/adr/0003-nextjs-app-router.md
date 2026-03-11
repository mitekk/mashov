# ADR-0003: Frontend Framework — Next.js 15 App Router over React + Vite

- **Date**: 2026-03-11
- **Status**: Accepted
- **Deciders**: PRD author (requirement), Planner (Step 1 architecture)

## Context and Problem Statement

The project's default template (CLAUDE.md) specifies React + Vite as the frontend stack. The PRD explicitly overrides this and requires Next.js. Beyond the PRD mandate, the application has characteristics that make the choice consequential: it is mobile-first, Hebrew RTL, requires a persistent navigation shell across all routes, renders sanitized HTML from upstream mail bodies, and must deliver a fast initial paint on mobile connections. The decision is not whether to use Next.js — that is PRD-mandated — but which rendering and routing model within Next.js best serves the application's constraints, and what trade-offs the team accepts by departing from the simpler Vite SPA baseline.

## Decision Drivers

- PRD explicitly specifies Next.js as the frontend framework — this is a hard requirement, not a preference
- Mobile-first target: first-contentful-paint on the Home screen must be under 2 seconds on a mobile connection; SSR reduces the JS parse + data-fetch waterfall for the initial load
- App Router layouts provide a shared navigation shell (bottom nav, header strip) that persists across route transitions without prop drilling or re-mounting
- Phase 2 auth (middleware, server actions, protected routes) integrates as a natural Next.js middleware layer rather than a bolt-on
- `next/image` handles child avatar and icon optimization (WebP conversion, lazy loading, responsive sizing) automatically

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Next.js 15 App Router** | PRD-mandated; SSR reduces first-paint on mobile; App Router layouts eliminate navigation shell re-renders; `next/image` for avatar optimization; middleware-based auth integrates cleanly in Phase 2; RSC reduces client-side JS bundle for static sections | More complex Docker build (standalone output mode required); RSC/client boundary discipline required — TanStack Query hooks must be in `"use client"` components; slower hot-reload than Vite in some configurations | **Selected** |
| React + Vite (SPA) | Project default; simpler Docker build (static `dist/` served by nginx); fastest HMR; no RSC/client boundary complexity; well-understood by most React developers | Does not meet PRD specification; no SSR means first load requires full JS parse + API fetch before render — slower on mobile; shared navigation shell requires additional state management; Phase 2 auth requires a separate middleware layer | Rejected |
| Next.js 15 Pages Router | Simpler mental model than App Router; no RSC/client boundary discipline; battle-tested | App Router is the current Next.js standard; Pages Router receives no new features; layout nesting and shared shells are more complex in Pages Router; RSC benefits unavailable | Rejected |

## Decision Outcome

**Chosen**: Next.js 15 with App Router

**Rationale**: The PRD mandate settles the framework choice; the architectural judgment is in selecting App Router over Pages Router. App Router's nested layout system is the right model for this application: a root layout provides the `<html dir="rtl">` wrapper and Hebrew font, the shell layout provides the bottom navigation bar and header, and route-level pages render their content inside that persistent shell without remounting. This eliminates a class of navigation UX bugs (scroll reset, loading flash) that require workaround in a Pages Router or SPA architecture. SSR of the Home screen means the first meaningful paint includes server-rendered dashboard data rather than a skeleton — critical on mobile connections where the JS parse + API round-trip waterfall is expensive. The trade-offs are real: the `standalone` output mode required for Docker adds build complexity, and developers must maintain RSC/client boundary discipline (TanStack Query hooks in `"use client"` components only). Both are one-time setup costs, not recurring operational burdens.

**Positive Consequences**:
- Root layout enforces `dir="rtl"` and Hebrew font globally — no per-page discipline required
- Navigation shell (bottom nav, sync status header) is rendered once at the layout level and never unmounts during route transitions
- SSR of the Home screen data reduces perceived load time on mobile; TanStack Query hydrates from the server-rendered payload for subsequent client-side refreshes
- Phase 2 auth can be implemented as a single Next.js middleware file with no changes to page components

**Negative Consequences / Risks**:
- Docker build requires `output: 'standalone'` in `next.config.ts` and a multi-stage Dockerfile that copies the standalone output correctly; a misconfigured build silently produces a non-functional container
- Every component that uses TanStack Query, `useState`, or browser APIs must be marked `"use client"` — omission causes a runtime error rather than a compile-time error, requiring test coverage to catch
- Hot-reload speed in Docker (via `docker-compose.override.yml` volume mount) is slower than Vite's native HMR; local development outside Docker is recommended for fast iteration

## Links

- Related: [ADR-0001 — NestJS backend framework](0001-backend-framework-nestjs.md)
- Implemented in: `frontend/`, `frontend/next.config.ts`, `frontend/src/app/layout.tsx`
