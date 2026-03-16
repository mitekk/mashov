# ADR-0013: Bulk Actions for Homework and Behavior Sections — Inline Bar, Filter-Aware Visibility, Dedicated Backend Endpoints

- **Date**: 2026-03-16
- **Status**: Accepted
- **Deciders**: Frontend agent, Backend agent

## Context and Problem Statement

The child workspace displays homework and behavior events with per-item action buttons (mark read, archive, etc.). Parents managing a child with many items must act on each one individually — a friction-heavy flow when clearing a batch of new homework or archiving a week of behavior events. The inbox route already solves this problem with a checkbox multi-select + bulk actions bar; the question is how faithfully and at what scope to replicate that pattern in the two child workspace sections, where each section carries its own `statusFilter` state (`'new' | 'archived' | 'all'`).

## Decision Drivers

- **Parity with inbox UX** — The inbox bulk actions bar is the established interaction contract for this app. Diverging would create two incompatible mental models for what is functionally the same user gesture.
- **Filter-aware action set** — Showing an "archive" button when the filter is already `'archived'` is a semantic error. The button set must respond to the active filter so that every offered action is always applicable to the selected items.
- **`all` tab semantics** — In child homework/behavior sections, `status='all'` is an "active items" view (non-archived only). Archived rows are opt-in via the dedicated `'archived'` tab.
- **Minimizing round-trips** — Calling a per-item endpoint in a loop for N selected items produces N HTTP requests and N optimistic-update cycles. A bulk endpoint collapses that to one request regardless of selection size.
- **Section independence** — Homework and behavior sections have no shared state. Selection in one section has no meaning for the other; coupling them through a parent component would add coordination overhead for zero user benefit.
- **Component complexity budget** — With exactly two use sites (HomeworkSection, BehaviorSection) and divergent filter logic, extracting a shared component adds abstraction cost that outpaces its value.

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Inline bulk actions bar — selection state local to each section, rendered conditionally** | Mirrors inbox pattern directly; zero cross-section coupling; filter-aware button visibility is a natural consequence of local state ownership; no new component file required | Logic is duplicated across HomeworkSection and BehaviorSection — future changes must be applied in two places | **Selected** |
| Shared `BulkActionsBar` component extracted to `components/shared/` | Single source of truth for bulk bar markup and behavior; consistent styling guaranteed | Filter logic differs between sections; abstraction requires a prop interface that encodes section-specific branching, buying complexity without eliminating duplication | Rejected |
| Lift selection state to `ChildWorkspacePage` | One place owns all selection; could theoretically support cross-section actions | Sections are functionally independent — shared parent state creates coupling where none exists; `ChildWorkspacePage` becomes a state coordinator for an interaction it does not own | Rejected |
| Per-item endpoint loop (frontend iterates selected items, calls existing single-item endpoints) | No backend changes required | N HTTP requests for N items; optimistic update flicker across multiple items; poor latency at any selection size above ~3; known anti-pattern already avoided in the inbox implementation | Rejected |
| Return full updated item list from bulk endpoints | Frontend gets fresh data without an explicit query invalidation | Payload grows linearly with section size, not selection size; TanStack Query invalidation is already in place and sufficient; no consumer reads the returned list | Rejected |

## Decision Outcome

**Chosen**: Inline bulk actions bar with local selection state, filter-aware button visibility, dedicated `updateMany`-backed endpoints, and a `{ updated: number }` response shape.

**Rationale**: The inbox route established the interaction contract — checkbox selection reveals a contextual bar that offers actions valid for the current view state. Replicating that contract faithfully in HomeworkSection and BehaviorSection is the correct choice because it keeps the user's mental model consistent across the app. Extracting a shared component was evaluated but rejected: the two sections have genuinely different filter-to-button mapping logic, so the shared component's prop surface would encode the branching anyway, eliminating the benefit of extraction while adding an indirection layer. The cost of two-site duplication is bounded — there are exactly two sections, the logic is shallow, and a future refactor to a shared component remains straightforward if a third use site emerges. Dedicated bulk endpoints using Prisma `updateMany` were chosen over looping per-item calls because a single round-trip is the correct primitive for a batch operation; the `{ updated: number }` response is the minimum payload that satisfies the frontend's only need — knowing whether the operation succeeded, before it discards the server data in favour of a query invalidation.

**Positive Consequences**:
- Each section manages its own selection lifecycle; clearing or navigating away resets state without any parent-level coordination.
- Filter-aware button visibility prevents semantically invalid actions (e.g., "archive" when viewing archived items) without any runtime guard logic — the active filter already determines which buttons render.
- Keeping archived rows out of `status='all'` prevents mixed-state action ambiguity and preserves one clear restore surface (`'archived'` tab).
- Bulk endpoints reduce N round-trips to 1 regardless of selection size, and Prisma's `updateMany` executes the batch as a single SQL statement.
- The pattern is immediately recognisable to any developer who has read the inbox implementation; no new conventions are introduced.

**Negative Consequences / Risks**:
- The bulk bar rendering logic and the filter-to-button mapping are duplicated in HomeworkSection and BehaviorSection. A design change to the bar (e.g., adding a "mark unread" action) requires two edits. This is accepted as a bounded cost given the two-site scope.
- Four new PUT endpoints are added to the children controller, increasing the API surface. Each is a thin wrapper over `updateMany`; the marginal maintenance burden is low but nonzero.
- `{ updated: number }` gives no item-level detail. If a future requirement needs per-item outcome reporting (e.g., partial failures), the response contract must be extended.

## Links

- Related: [ADR-0010 — UI Interaction Patterns — Bulk Actions, Feed Filtering, Selection Highlight, and Post-Action Navigation](0010-ui-interaction-patterns.md)
- Implemented in: `backend/src/children/children.controller.ts`
- Implemented in: `backend/src/children/children.service.ts`
- Implemented in: `frontend/src/api/children.ts`
- Implemented in: `frontend/src/hooks/useChild.ts`
- Implemented in: `frontend/src/components/child/HomeworkSection.tsx`
- Implemented in: `frontend/src/components/child/BehaviorSection.tsx`
