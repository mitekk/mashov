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
