# ADR-0010: UI Interaction Patterns — Bulk Actions, Feed Filtering, Selection Highlight, and Post-Action Navigation

- **Date**: 2026-03-15
- **Status**: Accepted
- **Deciders**: Frontend agent

## Context and Problem Statement

A batch of related UI polish decisions arose together during the same session: the inbox needed a bulk "mark as read" action scoped to the new-items filter; a missing `manifest.json` was producing browser 404 errors; child card selection highlight was producing visual noise inconsistent with the desired interaction model; the home feed filter set was asymmetric with the inbox; and detail pages had no clear exit path after a user took an action. Each decision was small in isolation but collectively they define the app's interaction contract. Because they share a common theme — how the UI responds to user-initiated state changes — they are recorded together.

## Decision Drivers

- Consistency: inbox and home feed are the two primary list surfaces; their filter structures should match so that users build one mental model, not two.
- Minimum-surprise navigation: users who tap a button to mark an item read or archived expect the UI to move them along, not leave them on the same page.
- Selection highlight was creating a false affordance — cards behaved as selectable items when selection had no downstream purpose in the current UX.
- `layout.tsx` already hardcodes `/manifest.json`; changing the manifest path would touch more files than creating the static file.
- Zero redundant controls: showing "mark as read" on items that are already read adds noise without value.

## Considered Options

### Decision 1 — Inbox bulk "mark as read" visibility

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Show "סמן כנקרא" button only when `activeFilter === 'new'` | Surfaces the action exactly when it is meaningful; zero redundant controls; reuses existing `useMarkRead` hook | Slightly non-obvious to users who do not know the filter state controls button visibility — mitigated by the button disappearing naturally when switching tabs | **Selected** |
| Show "סמן כנקרא" always (alongside a "mark unread" button) | Maximally discoverable regardless of filter state | Introduces a "mark as read" button on items that are already read, and a "mark unread" button that has no value in the default view; doubles the action surface for no gain | Rejected |

### Decision 2 — manifest.json 404 fix

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Create `frontend/public/manifest.json` as a static file | Fixes the 404 at the path `layout.tsx` already references; zero other file changes required | Static file must be kept in sync manually if manifest fields change — no type safety | **Selected** |
| Use Next.js `app/manifest.ts` (generates `/manifest.webmanifest`) | Framework-idiomatic; typed; auto-generated at the correct route | `layout.tsx` hardcodes `/manifest.json`; adopting this approach requires also updating `layout.tsx` and any other consumers of the path, touching more files for an equivalent outcome | Rejected |

### Decision 3 — Child card selection highlight

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Remove selection highlight — use `border-border` unconditionally in `ChildQuickCard.tsx` and `ChildCard.tsx` | Eliminates false affordance; cleaner visual; consistent with a navigation-only tap model where cards route to a detail page rather than entering a selected state | Loses the visual feedback that a card was tapped; mitigated by page transition which is a stronger signal | **Selected** |
| Keep highlight but use a subtler color | Reduces visual noise without fully removing feedback | Does not resolve the root issue — a selection ring implies a selectable/multi-selectable pattern that does not exist in this app; any highlight color continues to imply the affordance | Rejected |

### Decision 4 — Home feed filter parity with inbox

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Add "ארכיון" filter to `LatestFeed.tsx` — three-way: לא נקרא / ארכיון / הכל; "הכל" excludes archived | Matches inbox filter structure exactly; archived items are opt-in rather than polluting the default "all" view; single mental model across both list surfaces | Slightly increases `LatestFeed` complexity; archived items in the feed window may be sparse, making the archived tab feel thin — accepted because completeness matters more than density | **Selected** |
| Keep two-filter layout (unread / all) | Simpler component; fewer states to test | "All" on home feed and "All" on inbox behave differently — users who expect parity will encounter archived items in one place and not the other; inconsistency degrades trust | Rejected |

### Decision 5 — Detail page post-action navigation

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Call `router.back()` on success of explicit mark-read/unread or archive/restore button actions in `HomeworkDetailPage` and `BehaviorDetailPage` | Matches user expectation: "I acted on this item, take me back to my list"; list refetches on focus via TanStack Query so the item's updated state is visible immediately upon return | If the user navigated directly to the detail page (e.g., from a bookmark or direct URL), `router.back()` may land them outside the app — acceptable edge case given the primary entry path is always from the list | **Selected** |
| Stay on detail page and update in-place after action (previous behavior) | No navigation side-effect; user can take multiple actions on the same item without leaving | Contradicts the expected workflow: marking something read is a completion gesture, not a continuation gesture; users repeatedly reported the need to manually navigate back after acting | Rejected |

**Scope boundary — auto-mark-read on load**: The `useEffect` that marks an item read automatically when a detail page mounts does NOT call `router.back()`. Auto-reads are background housekeeping, not user-initiated actions; navigating away from a page the user just opened would be disorienting.

## Decision Outcome

**Chosen**: All five options above as documented in the Selected column.

**Rationale**: These decisions share a common thread — each removes a mismatch between what the UI implies and what a user expects to happen. The inbox bulk action appearing only at `filter=new` removes a button that would otherwise promise an action on items that need no action. The static manifest file fixes a browser error at the lowest-cost intervention point given the existing `layout.tsx` constraint. Removing the card selection highlight eliminates a false affordance: cards navigate, they do not select, and no visual state should suggest otherwise. Adding the archived filter to the home feed ensures that both primary list surfaces follow the same three-way filter contract, preventing users from building two separate mental models for functionally equivalent screens. Finally, `router.back()` after explicit actions treats button-triggered state changes as completion gestures rather than intermediate steps — which is how users behave when they tap "archive" or "mark as read" in any mature email or notification client. The exception for auto-read on mount is equally important: background housekeeping should be invisible.

**Positive Consequences**:
- Inbox bulk action is contextually present only when actionable, reducing cognitive overhead on the already-read filter tab.
- Browser console 404 for `manifest.json` is eliminated with a single new file and no cascading changes.
- Child card tap interactions feel lighter and navigation-forward rather than selection-forward.
- Home feed and inbox now share one filter vocabulary; onboarding cost for new users decreases.
- Detail pages clear themselves from the stack after user action, keeping the navigation history clean and the list view current on return.

**Negative Consequences / Risks**:
- The "mark as read" button's conditional visibility is filter-dependent; if the filter logic changes in a future refactor, the button's display condition must be updated alongside it — a coupling that should be documented in `useInboxFilters` or equivalent.
- The static `manifest.json` file has no type safety; fields like `theme_color` or `display` can drift out of sync with actual app behavior without a build-time check.
- `router.back()` on detail pages assumes a list-originated navigation path; direct-URL access to a detail page will result in an unexpected exit from the app on action. This is logged as a known edge case with no planned mitigation at this time.
- Removing the archived filter from "all" on the home feed means a user who wants to see all items including archived must select the explicit archived tab; this is intentional but may surprise users who expect "all" to mean "every item ever".

## Links

- Related: [ADR-0009 — Home Feed Read/Unread Filter — Client-Side Toggle over Server-Side Query Param](0009-home-feed-read-unread-filter.md)
- Related: [ADR-0005 — State Management — TanStack Query for Server State, No Global Client Store](0005-tanstack-query-state-management.md)
- Implemented in: `frontend/src/app/inbox/page.tsx`
- Implemented in: `frontend/src/components/home/LatestFeed.tsx`
- Implemented in: `frontend/src/components/child/HomeworkDetailPage.tsx`
- Implemented in: `frontend/src/components/child/BehaviorDetailPage.tsx`
- Implemented in: `frontend/public/manifest.json`
