# ADR-0011: Child Card Badge Counts — Unread + Non-Archived + 7-Day Window

- **Date**: 2026-03-16
- **Status**: Accepted
- **Deciders**: Frontend + backend agent

## Context and Problem Statement

The home route renders a `ChildQuickCard` for each child, displaying icon+number badges for recent homework and behaviour items. The badge counts are sourced from `getChildren()` in `dashboard.service.ts`. The badge should surface items that are both actionable (unread) and recent (last 7 days), giving parents an at-a-glance signal of new school activity without unbounded count growth.

## Decision Drivers

- `isNew: true` is the schema-level signal that a parent has not yet acknowledged an item — the badge should only count items the parent still needs to see.
- A 7-day window bounds badge counts naturally, preventing unbounded growth on first sync and keeping the signal proportionate to recent activity.
- `isArchived: true` means the parent explicitly dismissed an item — archived items must neve r inflate the badge.
- Consistency with `getSummary()` in the same service, which uses the same 7-day window, avoids cross-surface confusion.

## Considered Options

| Option                                                | Pros                                                                                                  | Cons                                                                                      | Verdict      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| `isNew: true AND isArchived: false` + 7-day window    | Counts only unread, non-archived, recent items; badge drops as parent reads items; bounded by recency | Items older than 7 days that are still unread are not surfaced                            | **Selected** |
| `isArchived: false` + 7-day window, no `isNew` filter | Counts are bounded by recency; consistent with `getSummary()`                                         | Counts read items alongside unread, inflating the badge with already-acknowledged content | Rejected     |
| `isNew: true AND isArchived: false`, no date window   | Badge reflects all unacknowledged items regardless of age                                             | On first sync all items arrive as `isNew: true`, producing unbounded counts               | Rejected     |

## Decision Outcome

**Chosen**: `isNew: true AND isArchived: false` + 7-day window.

**Rationale**: Combining both filters captures the best of each approach — the badge counts only items the parent has not yet read (`isNew: true`), so it drops as the parent works through content, while the 7-day window prevents unbounded growth from old unread items accumulated before the app was installed or during a long absence. The result is a proportionate, actionable signal: non-zero when there is genuinely new content in the past week, and trending toward zero as the parent catches up.

**Positive Consequences**:

- Badge counts only unread, non-archived items — no inflation from already-acknowledged content.
- Bounded by a 7-day window — no unbounded growth on first sync.
- Badge trends to zero as the parent reads recent items, giving clear feedback.

**Negative Consequences / Risks**:

- Items older than 7 days that remain unread are excluded from the badge count — a parent returning after a long absence will not see old backlog in the badge.
- Accuracy depends on `isNew` state being kept current; any feature that mutates `isNew` (e.g., bulk-mark-read) must invalidate the badge via TanStack Query.

## Links

- Related: [ADR-0010 — UI Interaction Patterns — Bulk Actions, Feed Filtering, Selection Highlight, and Post-Action Navigation](0010-ui-interaction-patterns.md)
- Implemented in: `backend/src/dashboard/dashboard.service.ts`
- Implemented in: `frontend/src/components/home/ChildQuickCard.tsx`
