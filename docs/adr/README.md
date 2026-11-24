# Architecture Decision Records

This directory contains MADR-format Architecture Decision Records for the **Mashov School Parent Command Center** project. Each ADR documents a decision where two or more viable alternatives existed and the choice has lasting consequences on the codebase.

For authoring conventions, see `.claude/skills/adr/` or the `/adr` skill.

## Index

| ID | Title | Status | Deciders | Date |
|----|-------|--------|----------|------|
| [ADR-0001](0001-backend-framework-nestjs.md) | Backend Framework — NestJS over Fastify | Accepted | Planner | 2026-03-11 |
| [ADR-0002](0002-no-redis-postgres-cache.md) | No Redis — PostgreSQL as the Read Layer | Superseded | Planner | 2026-03-11 |
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
| [ADR-0013](0013-bulk-actions-homework-behavior.md) | Bulk Actions for Homework and Behavior Sections — Inline Bar, Filter-Aware Visibility, Dedicated Backend Endpoints | Accepted | Frontend agent, Backend agent | 2026-03-16 |
| [ADR-0014](0014-magic-link-authentication.md) | Authentication Strategy — Custom Magic-Link with DB Sessions | Superseded | Planner, Backend agent | 2026-03-16 |
| [ADR-0015](0015-server-side-db-sessions.md) | Session Token Strategy — Server-Side DB Sessions over JWT Cookies | Superseded | Planner, Backend agent | 2026-03-16 |
| [ADR-0016](0016-per-user-item-state.md) | Per-User Read/Archive State — Normalized user_item_state Table over Item-Level Columns | Accepted | Planner, Backend agent | 2026-03-16 |
| [ADR-0017](0017-caching-strategy-conditional-redis.md) | Caching Strategy — Conditional Redis | Accepted | Planner | 2026-03-16 |
| [ADR-0018](0018-direct-mashov-credential-login.md) | Authentication — Direct Mashov Credential Login | Accepted | Planner, Backend agent | 2026-03-16 |
| [ADR-0019](0019-session-strategy-db-with-redis-cache.md) | Session Strategy — DB Sessions with Redis Cache | Accepted | Planner, Backend agent | 2026-03-16 |
| [ADR-0020](0020-auth-controller-passthrough-response.md) | Auth Controller — NestJS Passthrough Mode with Exception-Based Error Paths | Accepted | Backend agent, Smoke test verifier | 2026-03-17 |
| [ADR-0021](0021-api-contract-field-name-alignment.md) | API Response Field Names — Explicit Mapping Layer over Prisma Model Passthrough | Accepted | Backend agent, Smoke test verifier | 2026-03-17 |
| [ADR-0022](0022-middleware-cookie-name-alignment.md) | Next.js Middleware Auth Check — Read `mashov_session` Cookie, Not `session` | Accepted | Frontend agent, Smoke test verifier | 2026-03-17 |
| [ADR-0023](0023-bounding-mashov-egress-abortsignal.md) | Bounding Mashov Egress — `AbortSignal` in a Shared Axios Factory | Accepted | Backend agent, Smoke test verifier | 2026-11-16 |
| [ADR-0024](0024-school-year-resolution-and-rollover.md) | School Year — Resolve from Upstream, Persist on the Connection, Scope the Rows | Accepted | Backend agent, Planner | 2026-11-17 |
| [ADR-0025](0025-school-year-history-window.md) | `MASHOV_YEAR` Means the Earliest Year to Fetch, Never the Year in Scope | Partially superseded by [ADR-0036](0036-current-year-lists-and-derived-past-year-archive.md) | Backend agent, Planner | 2026-11-17 |
| [ADR-0026](0026-outbound-digest-delivery-and-llm-egress.md) | Outbound Digest Delivery — Pluggable Sender, Telegram First, and the Project's First Runtime LLM Call | Accepted | Backend agent, Planner | 2026-11-17 |
| [ADR-0027](0027-derived-homework-deadlines.md) | Derived Homework Deadlines — Label the Estimate, Never Promise a Due Date | Accepted | Backend agent, Planner | 2026-11-17 |
| [ADR-0028](0028-refresh-completion-envelope.md) | Refresh Completion Is an Envelope, Not a Source Threshold | Accepted | Backend agent, Frontend agent, Planner | 2026-11-18 |
| [ADR-0029](0029-household-merge-and-login-adoption.md) | One Household, N Schools, and Adoption at Sign-In | Accepted | Planner, Backend agent, Frontend agent | 2026-11-18 |
| [ADR-0030](0030-per-connection-data-scoping.md) | Every Per-School Read and Write Is Scoped to Its Connection | Accepted | Backend agent, Planner | 2026-11-18 |
| [ADR-0031](0031-child-visibility-is-a-set-of-connections.md) | A Child's Visibility Is a Set of Connections, Not the One That Answered | Accepted | User, Backend agent | 2026-11-18 |
| [ADR-0032](0032-household-merge-trust-model.md) | A Household Merge Is a Confirmed, Password-Proven Move of One Connection | Accepted | User, Backend agent, Frontend agent | 2026-11-20 |
| [ADR-0033](0033-parent-driven-telegram-linking.md) | A Parent Links Their Own Telegram, From a One-Time Code We Read Out of the START | Accepted | User, Backend agent, Frontend agent | 2026-11-21 |
| [ADR-0034](0034-child-activity-badges-count-unread-this-year.md) | Child Activity Badges Count Unread Items for the School Year, Not a Rolling Window | Accepted | User, Backend agent, Frontend agent | 2026-11-22 |
| [ADR-0035](0035-per-user-digest-isolation.md) | A Digest Run Is One Child and One Parent, Not One Child | Accepted | User, Backend agent | 2026-11-22 |
| [ADR-0036](0036-current-year-lists-and-derived-past-year-archive.md) | The Default Lists Show the Current School Year; a Past Year Is Archived by Derivation | Accepted | User, Backend agent, Frontend agent | 2026-11-22 |
| [ADR-0037](0037-bell-schedule-source-and-derived-breaks.md) | Bell Times Come From the School When It Serves Them, From a Labelled Default When It Does Not — and Breaks Are Derived | Accepted | User, Backend agent, Frontend agent | 2026-11-22 |
| [ADR-0038](0038-inbox-mail-notifications.md) | Inbox Mail Is Its Own Message, on Its Own Cadence, with Its Own Ledger | Accepted | User, Backend agent | 2026-11-22 |
| [ADR-0039](0039-mashov-attachments-into-telegram.md) | Mashov Attachment Bytes Leave the Host, into a Telegram Chat | Accepted | User, Backend agent | 2026-11-22 |
| [ADR-0040](0040-digest-waits-for-the-childs-own-last-bell.md) | The Digest Waits for the Child's Own Last Bell | Accepted | User, Backend agent | 2026-11-23 |
| [ADR-0041](0041-self-hosted-image-optimization.md) | Self-Hosted Image Optimization — AVIF-First, `sharp` Shipped Explicitly, Cache on a Volume | Accepted | User, Frontend agent | 2026-11-23 |
| [ADR-0042](0042-in-app-mashov-auth-surface.md) | The Whole Mashov Auth Surface Lives In Our App — Except the Captcha, Which Cannot | Accepted | User, Backend agent, Frontend agent | 2026-11-23 |
| [ADR-0043](0043-self-hosted-font.md) | Assistant Is Committed to the Repo — One `next/font/local` Call per Subset, All Sharing One Family Name | Accepted | User, Frontend agent | 2026-11-23 |
| [ADR-0044](0044-feedback-rows-are-self-contained.md) | A Feedback Row Is a Self-Contained Snapshot, Not a Set of References | Accepted | User, Backend agent, Frontend agent | 2026-11-24 |
| [ADR-0045](0045-operator-feedback-delivery-and-admin-access.md) | A Cron Outbox Delivers Each Report, and the Admin Surface Is Gated by a JWT We Verify Ourselves | Accepted | User, Backend agent, Frontend agent | 2026-11-24 |
