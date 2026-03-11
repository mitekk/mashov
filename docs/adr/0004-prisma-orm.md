# ADR-0004: Data Access — Prisma ORM over Knex or Raw SQL

- **Date**: 2026-03-11
- **Status**: Accepted
- **Deciders**: Planner (Step 1 architecture)

## Context and Problem Statement

The application has a 15-table PostgreSQL schema with 10+ composite unique constraints, `jsonb` columns on every table (for `rawPayload` upstream API preservation), and typed TypeScript response shapes that must flow through NestJS services into API responses without manual interface duplication. The sync engine performs upsert operations on every sync cycle — correctness of the deduplication keys (composite uniques) is critical to data integrity. The data access layer choice determines how much of this type safety, migration management, and deduplication correctness is compiler-enforced versus convention-dependent.

## Decision Drivers

- 15 tables with composite unique constraints require migration tooling that version-controls schema changes reproducibly — manual SQL migrations are error-prone across developer machines and CI
- `rawPayload: Json` on every entity table must be supported natively; the column insulates the application against upstream Mashov API field changes by storing the full upstream response
- TypeScript types for API responses must align with DB schema without duplication; generated types from a schema-first tool eliminate a category of drift bugs
- Upsert semantics (insert-or-update on composite keys) are a first-class operation in the sync engine; the ORM must support this without falling back to raw SQL for the common case
- NestJS's `PrismaModule` global singleton pattern is well-documented; Prisma is the de facto ORM pairing for NestJS projects in the ecosystem

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Prisma** | Schema-first: `schema.prisma` is the single source of truth for DB structure and generated TypeScript types; `prisma migrate` version-controls schema changes; native `upsert` with `create`/`update`/`where` maps directly to composite-key deduplication; `Json` type supports `jsonb` columns with full TypeScript passthrough; global `PrismaClient` singleton integrates cleanly with NestJS DI | Prisma client adds ~10MB to the Node.js bundle; N+1 query risk with nested `include` clauses if not explicitly scoped; `schema.prisma` DSL is a proprietary format (not SQL); some advanced PostgreSQL features require `$queryRaw` fallback | **Selected** |
| Knex (query builder) | Thin abstraction over SQL; full access to PostgreSQL-specific syntax; smaller bundle; familiar to SQL-proficient developers | No schema-first type generation — TypeScript interfaces must be maintained manually and kept in sync with DB schema; no built-in migration diffing; `upsert` requires hand-written `ON CONFLICT` SQL; `jsonb` operations require raw SQL fragments; high duplication risk between DB schema and TypeScript types | Rejected |
| Raw SQL (`pg` driver) | Maximum control; zero abstraction overhead; full PostgreSQL feature access | No type safety on query results without manual casting; migrations are plain SQL files with no diffing tooling; every `INSERT ... ON CONFLICT DO UPDATE` written and tested individually; completely manual TypeScript interface maintenance; highest long-term maintenance burden for a 15-table schema | Rejected |

## Decision Outcome

**Chosen**: Prisma

**Rationale**: The deciding factor is the relationship between `schema.prisma` and TypeScript types. In a project where API response shapes must match database columns exactly — and where the schema has 15 tables, 10+ composite unique constraints, and `jsonb` on every row — a query builder or raw SQL approach requires maintaining two separate representations of the same truth (the SQL schema and the TypeScript interfaces). Prisma generates types from the schema at build time, making schema-interface drift a compile error rather than a runtime surprise. The `upsert` primitive with composite `where` clauses maps directly to the deduplication contract: each sync task declares its unique key in the `where` clause and Prisma generates the correct `ON CONFLICT DO UPDATE` SQL. The `rawPayload: Json` column — which captures the full upstream Mashov API response on every row — is supported natively without raw SQL fallback. The N+1 risk in the `DashboardService` (joining 4+ tables) is mitigated by explicit `include` scope in each query and can be monitored via Prisma's query logging.

**Positive Consequences**:
- `schema.prisma` is the authoritative source for both DB structure and TypeScript types; a schema change propagates to API response types via `prisma generate` without manual interface updates
- `prisma migrate dev` and `prisma migrate deploy` provide reproducible, version-controlled migrations across local, CI, and production environments
- Upsert operations across all 11 sync tasks use the same `prisma.entity.upsert()` pattern, making deduplication logic consistent and auditable
- `rawPayload` stored on every entity means upstream Mashov API field additions are captured automatically without a migration — the adapter layer in sync tasks can be updated independently

**Negative Consequences / Risks**:
- Prisma client bundle adds ~10MB to the backend image; acceptable for a Docker deployment, but worth noting if the backend ever moves to a lambda/edge target
- N+1 query patterns in nested `include` clauses can degrade performance silently; the `DashboardService` must use bounded `include` depth and be validated with `EXPLAIN ANALYZE` before release
- `schema.prisma` DSL is Prisma-proprietary; switching ORMs in the future requires rewriting migrations and type generation, not just swapping a library
- Advanced PostgreSQL features (e.g., window functions, CTEs, full-text search) require `$queryRaw` fallback, which loses type safety — these cases must be explicitly typed and tested

## Links

- Related: [ADR-0001 — NestJS backend framework](0001-backend-framework-nestjs.md)
- Implemented in: `backend/prisma/schema.prisma`, `backend/src/prisma/prisma.module.ts`, `backend/src/prisma/prisma.service.ts`
