# ADR-0021: API Response Field Names — Explicit Mapping Layer over Prisma Model Passthrough

- **Date**: 2026-03-17
- **Status**: Accepted
- **Deciders**: Backend agent, Smoke test verifier

## Context and Problem Statement

Feed item responses, the dashboard summary, and the mail summary were returning field names drawn directly from the Prisma model (`isNew`, `isArchived`, `newConversations`). The API contract specified contract-facing names for the same semantics: `isUnread`, `isHandled`, `unreadConversations`, `newCount`. Frontend components referenced contract names and silently received `undefined`, causing badges and read/unread indicators to render as empty or zero regardless of actual state. The mismatch was invisible at compile time because the response objects were typed as `any` or plain `object` at the serialization boundary.

## Decision Drivers

- The API contract table in `docs/api-contract.md` is the source of truth for frontend and QA agents (per `api.md`); backend responses must match it exactly
- Prisma model field names reflect database naming conventions and storage semantics (`isNew` = "not yet seen by system"); contract field names reflect product semantics from the parent's perspective (`isUnread` = "not yet read by user")
- The smoke test phase (Step 5.7) surfaced the mismatch by observing zero unread counts and blank feed states for a seeded account with known unread items
- Homework and behavior feed items do not carry per-item read state at the feed level (that state lives in `user_item_state`; see ADR-0016); they must return deterministic contract-compliant values rather than undefined

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Add an explicit mapping layer in service methods that translates Prisma fields to contract fields before returning | Contract compliance enforced in one place per service; DB schema and API contract can evolve independently | Mapping code must be maintained when either side changes; not automatically type-checked against the contract | **Selected** |
| Rename Prisma model columns to match API contract names | Eliminates the mapping layer | Requires a migration; DB columns are named for storage semantics, not product semantics; creates future confusion when DB and API semantics diverge again | Rejected |
| Generate response DTOs directly from Prisma types via `@prisma/client` model types | Zero mapping code; always in sync with DB | Leaks DB internals as public API; prevents independent evolution of DB schema and API contract; contradicts the contract-first approach in `api.md` | Rejected |

## Decision Outcome

**Chosen**: Explicit mapping layer in each service method that returns feed or summary data.

**Rationale**: The Prisma model and the API contract serve different masters. Prisma field names describe how the backend stores and queries state; contract field names describe what the frontend and its users expect to receive. These two namespaces coincide now for some fields but will diverge as the product evolves — the DB may gain internal flags that have no contract representation, and the contract may gain computed fields with no single DB column. Renaming DB columns (Option B) collapses the two namespaces and forces a migration every time the API contract is revised. Using Prisma types as DTOs (Option C) couples the public API to the ORM, which the project explicitly rejected in ADR-0004. The mapping layer is the standard anti-corruption boundary between persistence and presentation. For homework and behavior items, where per-item read state is not available at feed level, the mapping returns `isUnread: false, isHandled: false` as documented defaults rather than `undefined`, which is the contract-correct behavior for items whose individual state has not been fetched.

**Positive Consequences**:
- Frontend receives `isUnread`, `isHandled`, `unreadConversations`, and `newCount` as specified; badges and indicators render correctly
- DB schema and API contract can evolve independently without cross-cutting changes
- Spec files and integration tests now assert on contract-compliant field names, providing a regression gate

**Negative Consequences / Risks**:
- The mapping layer is not type-checked against the contract table; a future rename of a contract field requires a manual audit of all service mappings — this should be addressed by introducing response DTOs with class-validator or Zod schemas that are shared between the contract document and the service layer
- Homework and behavior items returning `isUnread: false` at feed level is a documented approximation; if per-item read state is ever surfaced at feed level, the mapping must be updated or it will silently return incorrect values

## Links

- Related: [ADR-0016](0016-per-user-item-state.md) — per-user read/archive state table that feeds the mapping logic for mail items
- Related: [ADR-0004](0004-prisma-orm.md) — ORM choice that introduced the Prisma model naming conventions
- Implemented in: `backend/src/feed/feed.service.ts`, `backend/src/dashboard/dashboard.service.ts`, `backend/src/mail/mail.service.ts`
