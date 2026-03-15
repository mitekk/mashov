# ADR-0008: Manual Refresh Lifecycle — Blocking Sync API + Awaited Query Invalidation

- **Date**: 2026-03-15
- **Status**: Accepted
- **Deciders**: Frontend + backend agent

## Context and Problem Statement

The dashboard home page (`frontend/src/app/home/page.tsx`) has a manual refresh button that calls `POST /api/v1/sync/refresh`. The previous backend contract returned `202 Accepted` immediately and ran sync in the background. That forced the frontend to model refresh lifecycle indirectly (mutation timing + extra refetch timing).

The goal is to make refresh lifecycle deterministic without guessing when backend work is done.

## Decision Drivers

- `POST /sync/refresh` should reflect actual manual sync completion rather than queue admission.
- Frontend refresh state should be derived from mutation lifecycle, not extra page-local state.
- Concurrent refresh clicks must not trigger duplicate backend sync runs.
- Partial task failures should not hard-fail HTTP; client should receive a structured summary.

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Blocking `POST /sync/refresh` + `200` completion payload + frontend awaits query invalidation | Deterministic lifecycle; mutation pending spans server work and immediate cache refresh; no page-local loading state | Longer request time; contract change from `202` to `200` | **Selected** |
| Keep `202` fire-and-forget + page-local `isManuallyRefreshing` | Works without backend changes | Frontend still has to infer backend completion and coordinate extra local async state | Rejected |
| Async run-id endpoint + polling status | Robust for long jobs and distributed workers | More moving parts than needed for current single-process deployment | Rejected |

## Decision Outcome

**Chosen**: Blocking manual refresh API with structured completion response, plus awaited query invalidation in `useSyncRefresh`.

**Rationale**: The API now returns only after `refreshAll()` finishes, so mutation pending naturally models “manual refresh still running.” On frontend success, `useSyncRefresh` awaits invalidation/refetch of relevant query keys, extending pending state through client data refresh. This removes the need for page-specific manual refresh flags while preserving clear UX feedback.

**Positive Consequences**:
- `POST /sync/refresh` now reports completion status with task-level summaries (`success` / `partial`).
- Concurrent manual refresh calls are deduplicated and share one in-flight run.
- Home refresh button can rely on mutation `isPending` without local lifecycle state.
- Immediate cache invalidation/refetch remains part of the mutation lifecycle.

**Negative Consequences / Risks**:
- API response latency increases because manual refresh is now blocking.
- In-flight deduplication is in-memory and assumes a single backend process (no distributed lock).
- Existing clients expecting `202` + `{ started, message }` must update to the new payload.

## Links

- Related: [ADR-0005 — State Management — TanStack Query for Server State, No Global Client Store](0005-tanstack-query-state-management.md)
- Implemented in: `backend/src/sync/sync.controller.ts`, `backend/src/sync/sync.service.ts`, `frontend/src/hooks/useDashboard.ts`
