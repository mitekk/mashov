# ADR-0005: State Management — TanStack Query for Server State, No Global Client Store

- **Date**: 2026-03-11
- **Status**: Accepted
- **Deciders**: Frontend agent (Step 3 implementation)

## Context and Problem Statement

The Mashov dashboard is data-heavy and read-dominated: it displays grades, attendance records, behavior events, homework, and school messages, all fetched from the backend API and periodically refreshed. The application requires loading, error, and stale-data states to be handled consistently across all data-fetching components. A decision was needed on whether to use a dedicated server-state library, a global client-state store, or a combination — and which specific libraries to adopt.

## Decision Drivers

- All primary state in the app is server state (fetched from the backend) — there is no meaningful local client state that crosses component trees
- The dashboard must auto-refresh on a 60-second interval and refetch on window focus to keep data current with the backend sync engine
- Next.js App Router requires an SSR-safe QueryClient singleton to avoid sharing state between server requests
- Custom hooks per domain (useDashboard, useChild, useMail, etc.) must encapsulate query keys, stale times, and invalidation logic
- The team should not add a global store (Zustand, Redux) unless a concrete cross-tree client state need is identified — premature global state is a maintenance burden

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **TanStack Query v5 (server state only)** | Purpose-built for server state; handles caching, background refetch, window-focus refetch, retry, and stale-while-revalidate automatically; v5 API is stable and tree-shakeable; devtools included; SSR-safe with singleton pattern; custom hooks per domain keep component code clean | Requires `"use client"` discipline in Next.js App Router — hooks cannot run in RSC | **Selected** |
| SWR | Similar server-state caching; smaller bundle; same `"use client"` requirement | Fewer features (no mutation primitives, no `invalidateQueries`, weaker devtools); TanStack Query is the project default per the frontend rules | Rejected |
| React Context + useReducer | No additional dependency; built in | Manual cache invalidation, no background refresh, no deduplication — reimplements what TanStack Query provides; does not scale to the number of data domains in this app | Rejected |
| Zustand + manual fetch | Simple global store; works in any component | No caching semantics, no stale-time, no background refetch — all must be written by hand; conflates client and server state; overkill for a read-dominated app | Rejected |
| Redux Toolkit (RTK Query) | Mature ecosystem; RTK Query handles server state | Significantly heavier setup (store, slices, RTK Query config); React Query is simpler and sufficient; RTK is better suited to apps with complex synchronous client state | Rejected |

## Decision Outcome

**Chosen**: TanStack Query v5 for all server state; no global client state library

**Rationale**: Every data-fetching concern in the application maps cleanly onto TanStack Query primitives: `useQuery` for reads, `useMutation` for the sync-refresh trigger, `invalidateQueries` for cache busting after mutation, and `refetchInterval` for the 60-second dashboard polling. The custom hook pattern (`useDashboard`, `useChild`, `useMail`, `useChildren`, `useConversation`) encapsulates query keys and stale times in one place — components import the hook and receive `{ data, isLoading, error }` with no boilerplate. There is no identified need for a global client state store: navigation state lives in the URL (Next.js router), UI state is local to the component, and all shared data flows through the query cache. Adding Zustand or Redux without a concrete need would introduce an additional mental model and synchronization surface.

The SSR-safe singleton pattern in `providers.tsx` (one QueryClient per browser session, a fresh instance per server request) ensures that query cache does not leak between users in SSR contexts — a critical correctness requirement for Next.js App Router.

**Positive Consequences**:
- Cache invalidation after sync refresh (`invalidateQueries`) is a single call per domain — no manual state threading
- `refetchOnWindowFocus: true` ensures data is fresh when the parent switches back to the tab after checking another app
- `staleTime: 30_000` on the dashboard query prevents redundant fetches during rapid navigation while still keeping data acceptably fresh
- Devtools (`@tanstack/react-query-devtools`) provide visibility into query state in development at zero production cost (tree-shaken in production builds)

**Negative Consequences / Risks**:
- All TanStack Query hooks must be in `"use client"` components — accidentally using them in a React Server Component produces a runtime error that must be caught by tests or review
- If a genuine cross-tree client state need emerges (e.g., a notification badge count that multiple layout components must read), a global store will need to be added; this decision should be revisited at that point

## Links

- Related: [ADR-0003 — Next.js App Router](0003-nextjs-app-router.md)
- Implemented in: `frontend/src/app/providers.tsx`, `frontend/src/hooks/`
