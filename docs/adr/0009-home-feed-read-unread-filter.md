# ADR-0009: Home Feed Read/Unread Filter — Client-Side Toggle over Server-Side Query Param

- **Date**: 2026-03-15
- **Status**: Accepted
- **Deciders**: Frontend agent

## Context and Problem Statement

The home page `LatestFeed` component displays up to 20 merged feed items (homework, behavior, mail conversations) sourced from `GET /api/v1/dashboard`. Every `FeedItem` already carries `isNew: boolean`. Users want an "All / Unread" toggle to surface only items not yet read. The existing inbox page uses a server-side `?filter=all|new|archived` query param with URL state, so the team needed to decide whether the home feed should follow that same pattern or take a lighter approach.

## Decision Drivers

- `DashboardResponse.feed` is already capped at 20 items and every item already carries `isNew` — no data is missing from the existing payload.
- The home feed is a glanceable summary surface, not an exhaustive inbox; users filtering here do not need paginated "all unread" access.
- ADR-0005 establishes TanStack Query as the owner of server state; view-only UI concerns (sort order, local toggles) belong in `useState`, not in query keys.
- ADR-0008 set the precedent that local component state is the right tool for UI lifecycle concerns that do not require a new network round-trip.
- Zero backend changes are acceptable; any option requiring a schema or endpoint change carries higher delivery risk for marginal gain.

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Client-side `useState` toggle in `LatestFeed.tsx` filtering `items` on `isNew` | No new request, no new query key, no loading/error state; consistent with ADR-0005 and ADR-0008; `LatestFeed` already uses `useState` for `visibleCount` pagination | Filtered view is limited to the 20 items already fetched — cannot surface unread items outside that window | **Selected** |
| Server-side `?feedFilter=all\|new` added to `GET /api/v1/dashboard` | Guaranteed completeness — returns only truly unread items regardless of the 20-item cap | Adds DB-level filtering overhead for a capped endpoint where the result set is not meaningfully different; bloats the dashboard query contract; introduces a new query key, cache entry, and loading/error/empty state in the component | Rejected |
| New dedicated `GET /api/v1/feed?filter=new` endpoint | Clean separation; could support pagination of unread items | Creates a second fetch path for the home page, breaking the single-query dashboard contract; duplicates loading/error states for a surface that is deliberately lightweight; adds a backend endpoint for what is effectively a 1-line array filter | Rejected |

## Decision Outcome

**Chosen**: Client-side `useState` toggle in `LatestFeed.tsx`

**Rationale**: The home feed's design constraint is a cap of 20 items, which means the difference between "client filters the fetched 20 for `isNew`" and "server filters the DB for `isNew` and returns up to 20" is, in practice, cosmetic — both surfaces deliver a bounded, non-exhaustive view. Given that constraint, adding a server-side filter would impose real costs (new query key, cache invalidation path, loading state, backend changes) without changing what the user can do. The client-side toggle sits entirely within the existing data shape: `FeedItem.isNew` is already populated, `LatestFeed` already holds `useState` for `visibleCount` pagination, and no new loading or error states are introduced. This is the minimum-intervention path that satisfies the requirement while staying consistent with ADR-0005's boundary between server state (TanStack Query) and view-only UI concerns (local state).

**Positive Consequences**:
- No backend changes, no new API contract surface, no cache invalidation concerns.
- The toggle resets instantly with no network latency, giving a fluid UI response.
- Component complexity is contained: the new boolean sits alongside the existing `visibleCount` state, using the same pattern already established in the component.

**Negative Consequences / Risks**:
- The "Unread only" view is bounded by the 20-item dashboard fetch window; if all 20 items are read, the filtered view will appear empty even though unread items may exist further back in the user's history. This is an accepted trade-off given the home feed's stated purpose as a summary surface, not an inbox replacement.
- If the dashboard fetch cap is raised significantly in the future, filtering client-side over a large array may become a performance concern; at that point, moving the filter server-side should be reconsidered.

## Links

- Related: [ADR-0005 — State Management — TanStack Query for Server State, No Global Client Store](0005-tanstack-query-state-management.md)
- Related: [ADR-0008 — Refresh Button Lifecycle — Local State over Mutation isPending](0008-refresh-button-lifecycle-local-state.md)
- Implemented in: `frontend/src/components/home/LatestFeed.tsx`
