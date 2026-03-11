# ADR-0007: Component Architecture — Feature-Based Folder Structure with Shared UI Primitives

- **Date**: 2026-03-11
- **Status**: Accepted
- **Deciders**: Frontend agent (Step 3 implementation)

## Context and Problem Statement

The frontend has multiple distinct feature areas (dashboard/home, children list, child detail, inbox, conversation thread, settings/more) each composed of multiple components, plus shared UI primitives (loading states, error states, badges, empty states) used across features. A decision was needed on how to organize components, whether to colocate component code with routes, and how to structure the relationship between route pages, feature components, and reusable UI primitives.

## Decision Drivers

- Next.js App Router already imposes a file structure for routes (`app/` directory) — the component structure should complement, not fight, this
- Shared UI primitives (LoadingState, ErrorState, Badge, EmptyState) must be discoverable and reusable across all feature areas without path gymnastics
- Feature-specific components (e.g., a grade row, a conversation bubble) should live near the feature that uses them, not scattered across a flat component directory
- The frontend rules require a `components/` directory for shared reusable UI and a `pages/` (or `app/`) directory for route-level components — this is a hard constraint
- Custom hooks that encapsulate TanStack Query calls belong in `hooks/` — components should not contain raw `useQuery` calls
- No premature abstraction: a component is only extracted to `components/ui/` when it is genuinely used by two or more features

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Feature-based folders under `components/`** (`home/`, `inbox/`, `child/`, `layout/`, `ui/`) | Clear ownership — a developer knows exactly where `ConversationItem` lives; shared primitives are isolated in `ui/`; feature folders grow independently; aligns with frontend rules | Shared utilities that span features must be promoted to `ui/` or `lib/` — requires a judgment call on what counts as "shared" | **Selected** |
| Flat `components/` directory | Simple; no subdirectory decisions | Does not scale past ~10 components; files become unnavigable; no ownership signal | Rejected |
| Atomic Design (atoms/molecules/organisms/templates/pages) | Formally structured; well-documented pattern | Adds naming overhead without clear benefit for this app size; "molecule vs organism" distinctions are subjective and lead to bike-shedding; not aligned with the frontend rules | Rejected |
| Full colocation (components next to routes in `app/`) | Maximum locality — component and page in same directory | Conflicts with the frontend rules' explicit `components/` directive; makes shared component discovery harder; Next.js `app/` directory has special file conventions that pollute a colocation approach | Rejected |

## Decision Outcome

**Chosen**: Feature-based subfolders under `components/` with a shared `ui/` sub-directory for cross-feature primitives

**Structure adopted**:
```
frontend/src/
  app/                  Route files (Next.js App Router)
    home/page.tsx
    children/page.tsx
    children/[studentGuid]/page.tsx
    inbox/page.tsx
    inbox/[conversationId]/page.tsx
    more/page.tsx
    layout.tsx           Root layout (RTL, font, providers)
    providers.tsx        QueryClientProvider
  components/
    ui/                 Cross-feature primitives (LoadingState, ErrorState, Badge, EmptyState, StaleIndicator)
    layout/             App shell components (AppShell, BottomNav, FreshnessBar)
    home/               Dashboard-specific components (SummaryStrip, ChildQuickCard, NeedsAttentionCard, LatestFeed, FeedItem)
    children/           Children list components (ChildCard)
    child/              Child detail components (ChildHeader, SubjectsSection, HomeworkSection, BehaviorSection, ...)
    inbox/              Inbox components (ConversationList, ConversationItem, UnreadBadge)
    conversation/       Thread view components (MessageThread, MessageBubble)
    more/               Settings components (ProfileCard, SourceHealthList)
  hooks/                TanStack Query custom hooks (one file per domain)
  api/                  Typed API client functions (one file per resource)
  types/                Shared TypeScript interfaces (api.ts, index.ts)
  lib/                  Utility functions (dates.ts, rtl.ts)
```

**Rationale**: The App Router provides natural route isolation — each page file (`page.tsx`) is thin and delegates all rendering to components in `components/<feature>/`. This keeps page files readable (they compose components rather than define them) and makes components testable in isolation. The `ui/` sub-directory contains only components that are imported by two or more feature directories — nothing is promoted there prematurely. Custom hooks in `hooks/` own all TanStack Query logic, so components receive only `data`, `isLoading`, and `error` — this separation makes component unit tests straightforward (mock the hook, not the network). API client functions in `api/` are pure async functions with typed request/response shapes, consumed only by hooks.

**Positive Consequences**:
- A new developer can find any component by asking "which feature owns this?" and navigating to `components/<feature>/`
- `components/ui/` contains only genuinely reusable primitives — the directory stays small and focused
- Hook encapsulation means changing a query key, stale time, or refetch interval requires editing one file in `hooks/` — no hunt through component tree
- Feature folders can be extended independently as new views are added in later phases

**Negative Consequences / Risks**:
- Some components sit between features (e.g., a grade badge used in both `child/` and `home/`); the rule is to promote to `ui/` on the second import — this requires a review check to enforce consistently
- No enforced import boundaries between feature folders (e.g., `inbox/` could accidentally import from `child/`) — this is a lint rule that could be added via `eslint-plugin-import` if cross-feature coupling becomes a problem

## Links

- Related: [ADR-0003 — Next.js App Router](0003-nextjs-app-router.md)
- Related: [ADR-0005 — TanStack Query state management](0005-tanstack-query-state-management.md)
- Implemented in: `frontend/src/components/`, `frontend/src/hooks/`, `frontend/src/api/`, `frontend/src/app/`
