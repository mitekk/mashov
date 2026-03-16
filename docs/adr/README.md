# Architecture Decision Records

This directory contains MADR-format Architecture Decision Records for the **Mashov School Parent Command Center** project. Each ADR documents a decision where two or more viable alternatives existed and the choice has lasting consequences on the codebase.

For authoring conventions, see `.claude/skills/adr/` or the `/adr` skill.

## Index

| ID | Title | Status | Deciders | Date |
|----|-------|--------|----------|------|
| [ADR-0001](0001-backend-framework-nestjs.md) | Backend Framework — NestJS over Fastify | Accepted | Planner | 2026-03-11 |
| [ADR-0002](0002-no-redis-postgres-cache.md) | No Redis — PostgreSQL as the Read Layer | Accepted | Planner | 2026-03-11 |
| [ADR-0003](0003-nextjs-app-router.md) | Frontend Framework — Next.js 15 App Router over React + Vite | Accepted | PRD author, Planner | 2026-03-11 |
| [ADR-0004](0004-prisma-orm.md) | Data Access — Prisma ORM over Knex or Raw SQL | Accepted | Planner | 2026-03-11 |
| [ADR-0005](0005-tanstack-query-state-management.md) | State Management — TanStack Query for Server State, No Global Client Store | Accepted | Frontend agent | 2026-03-11 |
| [ADR-0006](0006-react-hook-form-zod.md) | Form Validation — React Hook Form + Zod | Accepted | Frontend agent | 2026-03-11 |
| [ADR-0007](0007-component-architecture.md) | Component Architecture — Feature-Based Folder Structure with Shared UI Primitives | Accepted | Frontend agent | 2026-03-11 |
| [ADR-0008](0008-refresh-button-lifecycle-local-state.md) | Manual Refresh Lifecycle — Blocking Sync API + Awaited Query Invalidation | Accepted | Frontend + backend agent | 2026-03-15 |
| [ADR-0009](0009-home-feed-read-unread-filter.md) | Home Feed Read/Unread Filter — Client-Side Toggle over Server-Side Query Param | Accepted | Frontend agent | 2026-03-15 |
| [ADR-0010](0010-ui-interaction-patterns.md) | UI Interaction Patterns — Bulk Actions, Feed Filtering, Selection Highlight, and Post-Action Navigation | Accepted | Frontend agent | 2026-03-15 |
| [ADR-0011](0011-child-card-badge-unread-count.md) | Child Card Badge Counts — Unread + Non-Archived Only, No Date Window | Proposed | Frontend + backend agent | 2026-03-15 |
| [ADR-0012](0012-timetable-data-persistence.md) | Timetable Data Persistence — Sync-and-Store over Live Proxy | Accepted | Backend agent, Planner | 2026-03-16 |
