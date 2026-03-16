# ADR-0016: Per-User Read/Archive State — Normalized user_item_state Table over Item-Level Columns

- **Date**: 2026-03-16
- **Status**: Accepted
- **Deciders**: Planner, Backend agent

## Context and Problem Statement

Phase 1 tracked whether homework items, behavior events, and mail conversations had been read or archived using `isNew` and `isArchived` boolean columns directly on the item tables. This model was intentionally household-global — there was no auth, so state was shared across all viewers. Phase 2 introduces parent authentication, making household-global state incorrect: two parents in the same household must be able to independently track what they have read. A migration strategy and a new data model are required. The decision determines schema shape, query complexity, migration path, and the coupling between upstream sync data and user UI state for the remainder of the project.

## Decision Drivers

- **Item tables represent upstream source data** — `homework_item`, `behavior_item`, and `mail_conversation` rows are populated and overwritten by the Mashov sync layer. Embedding user-specific UI state in these rows couples read/archive tracking to the sync lifecycle and risks accidental state erasure on upsert.
- **Multi-user correctness** — With two or more parents, item-level booleans either become per-user duplicated rows (breaking the 1:1 item→row assumption the sync layer depends on) or require a composite structure that is functionally a separate table anyway.
- **Migration must be non-destructive** — Phase 1 data is live. The migration must copy existing `isNew`/`isArchived` values forward for the bootstrap parent user without data loss, then remove the columns.
- **Query pattern is cross-type** — The home feed aggregates new items across homework, behavior, and mail. A uniform state table enables a consistent join pattern rather than three separate boolean column checks.

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Separate `user_item_state` table** — `(userId, itemType, itemId, isNew, isArchived)` with a unique constraint on the triple; item tables become state-free source data | Clean separation of sync data from UI state; no row multiplication in item tables; uniform join pattern across all item types; sync upserts cannot clobber user state; straightforward migration | All item queries require a LEFT JOIN to overlay user state; API layer must thread `userId` through to every service call; rows default to `isNew: true` if absent (requires application-level defaulting logic) | **Selected** |
| **Add `userId` column to item tables** — make `isNew`/`isArchived` per-user by adding a `userId` FK and converting the primary key to `(id, userId)` | No new table; state stays co-located with item data | Multiplies item rows by user count (N parents × M items); fundamentally breaks the sync layer's upsert semantics (which key on item ID, not item+user); mixing sync source data with UI preferences in one row violates separation of concerns | Rejected |
| **Event-sourced state log** — append-only `user_item_event` table recording `(userId, itemType, itemId, event, timestamp)` | Full audit history; supports undo; "last event wins" derivation handles concurrent mutations cleanly | Over-engineered for a boolean toggle use case; computing current state requires aggregating event history per item per user on read; adds query complexity for zero practical benefit in a household app | Rejected |

## Decision Outcome

**Chosen**: Separate `user_item_state` table

**Rationale**: The item-level column approach fails the multi-user requirement structurally — it either produces duplicate rows that break sync upserts, or it requires the same normalization as Option 2 implicitly. The rejection of event sourcing is simpler: the use case is two boolean flags per item per user, not an audit trail. The normalized state table is the correct relational model for this relationship (a user's view of an item is a distinct entity from the item itself), it keeps the sync layer's upsert logic unchanged, and it enables a consistent LEFT JOIN pattern across all three item types in the home feed query. The application-level default — "an item without a state row is unread and not archived" — is the correct business rule (every newly synced item should surface as unread) and is trivially enforced in the service layer. The migration cost is bounded: copy existing `isNew`/`isArchived` values to `user_item_state` rows keyed to the bootstrap parent user, then drop the columns in the same migration.

**Positive Consequences**:
- Sync upserts on item tables remain unaware of user state — no risk of state erasure when the Mashov API pushes updates.
- Adding a third parent user in the future requires zero schema changes; their state rows are created on first interaction.
- The home feed unread count query becomes a uniform `COUNT(*) ... LEFT JOIN user_item_state` regardless of item type.
- State for all item types can be bulk-updated (mark all read) with a single `INSERT ... ON CONFLICT DO UPDATE` targeted at one table.

**Negative Consequences / Risks**:
- Every item read query must LEFT JOIN `user_item_state` filtered by `userId`. If this join is omitted in a query, items silently return with no user state overlay. Service-layer conventions and code review must guard against this.
- The API layer must carry `userId` from the authenticated session through to every service method that fetches items — this is a pervasive change to the Phase 1 service signatures.
- A migration script is required for Phase 1 → Phase 2: copy `isNew`/`isArchived` values forward, create `user_item_state` rows for the bootstrap user, drop the source columns. This migration is not safely reversible once the columns are dropped.

## Links

- Related: [ADR-0014 — Authentication Strategy — Custom Magic-Link with DB Sessions](0014-magic-link-authentication.md)
- Related: [ADR-0004 — Data Access — Prisma ORM over Knex or Raw SQL](0004-prisma-orm.md)
- Implemented in: `backend/prisma/schema.prisma` (`UserItemState` model, to be added in Phase 2)
- Implemented in: `backend/src/` (children, homework, behavior, mail service layers — to be updated in Phase 2)
