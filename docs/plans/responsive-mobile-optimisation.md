# Responsive review & mobile optimisation — all 13 pages

## Context

The app presents itself as mobile-first, and its *primitives* genuinely are: a
44px `.tap-target` (19 components), `env(safe-area-inset-bottom)` on the bottom
nav, `min-h-dvh`, a `standalone` PWA manifest, and disciplined RTL via logical
properties (`border-s`, `ms-auto`, `-start-1`, `text-start`).

But the layout never *adapts*. A grep for `sm:|md:|lg:|xl:|2xl:` across all of
`frontend/src` returns **7 occurrences in 4 files**, and `globals.css` has
**zero `@media` blocks**. All 13 routes render the same narrow single column
capped at `max-w-5xl`, so a tablet or desktop shows a stretched phone with a
bottom tab bar. At the other end the 360px Android floor has never been checked.

Three latent defects compound it, all verified directly:

- **`maximumScale: 1`** (`frontend/src/app/layout.tsx:56`) blocks pinch-zoom — a
  WCAG 1.4.4 failure.
- **`scrollbar-hide` is used but defined nowhere.** No `tailwind-scrollbar-hide`
  in `package.json`, no rule in `globals.css`. Two rails show a scrollbar, while
  two other files hand-roll the real thing in two *different* ways.
- **The mobile e2e viewport is dead config.** `playwright.config.ts:64` declares
  `viewport: {390,844}` with the comment "app is mobile-first", but both real
  projects spread `devices['Desktop Chrome']` (1280×720, `isMobile:false`), and
  project `use` beats top-level `use`. **The suite has only ever run at desktop
  width.** One test (`children.spec.ts:1158`) opts into 390px by hand.

**Outcome:** every route lays out deliberately at three sizes — phone (360px
floor, no horizontal page overflow), tablet (≥768), desktop (≥1024, bottom bar
becomes a side rail) — with the mobile defects fixed and a regression suite that
actually runs at phone width.

## Decisions taken

| Question | Answer |
|---|---|
| Scope | Full adaptive mobile→desktop, not mobile-only polish |
| Small floor | **360px**, guaranteed free of horizontal page overflow |
| Mobile timetable | **Day-tabbed vertical agenda** <md; week grid ≥md |
| Adjacent cleanups | **Both** — extract the shared centred shell, and convert the 3 hand-rolled modals to Radix |
| Delivery | Foundation first, then one commit per page group, tests last |

## Global Constraints

Three rules drive nearly every choice below. Read them before the detail.

1. **Never render the same `data-testid` twice.** Where a surface has two
   presentations (bottom bar + side rail, week grid + agenda, horizontal tabs +
   vertical tabs), Playwright's `getByTestId` resolves two nodes and throws in
   strict mode — *even when one is `display:none`*. So: either one DOM node
   switched by CSS, or a second presentation with **its own** testids.
2. **Switch presentations with CSS, never `useMediaQuery`.** A JS conditional
   means SSR picks one arm and the client may flip it — a hydration flicker on
   exactly the slow devices this app targets.
3. **`@layer components` always loses to `@layer utilities`**, regardless of
   selector specificity. So a parent component class can never override
   `min-w-[176px]` on a child. Rail-child adaptive sizing must live on the
   child's own `className` with responsive prefixes.

Only 4 e2e references to nav testids exist (verified): `nav-inbox` ×2,
`nav-children`, `nav-more`. `bottom-nav` and `nav-home` are unused, so renaming
`BottomNav.tsx` is free. But `school-filter.spec.ts:424` asserts
`nav-inbox` → `toContainText('64')` at 1280, which pins one thing hard: **the
desktop side rail must render the unread count as text, not a dot.**

## Verified defects

| # | Where | Issue |
|---|---|---|
| 1 | `app/layout.tsx:56` | `maximumScale: 1` blocks pinch-zoom (WCAG 1.4.4) |
| 2 | `HomePageClient.tsx:150`, `ChildWorkspacePage.tsx:168` | `scrollbar-hide` undefined → visible scrollbars; `SchoolFilterChips.tsx:35` and `BehaviorSection.tsx:259` each solve it differently |
| 3 | `conversation/MessageBubble.tsx:71` | `prose prose-sm` are no-ops (no `@tailwindcss/typography`); school-message HTML unstyled, wide tables/images overflow. `.prose-rtl` is the real implementation. Note `max-w-none` **is** a real utility — keep it |
| 4 | `ReleasesDialog.tsx:345,607`, `SchoolActivitiesDialog.tsx:165` | `max-h-[80vh]` → iOS toolbar clips |
| 5 | `globals.css` | No `overflow-x` guard on `html`/`body` |
| 6 | `globals.css:302` | `.pt-safe` defined, used by **zero** files — no notch padding despite `display: standalone` |
| 7 | `AppShell.tsx:15` | `<main overflow-y-auto>` inside a `min-h-dvh` flex column while `body` also scrolls → two scrollers. `.pb-nav` then pads *inside* the inner one, so the last card can sit under the fixed bar |
| 8 | `AttachmentViewer.tsx:149` | `fixed inset-0` at every width; no safe-area padding on its bars |
| 9 | `SchoolBadge.tsx:52` | Hard `truncate max-w-[6rem]` cap on school names |
| 10 | `globals.css:264,280`; `SchoolAutocomplete.tsx:122,124`; `ChildHeader.tsx:173` | Last 5 physical-property sites: `pr-6`, `border-r-2 pr-3`, `mr-2`, `-right-1`. `ChildHeader`'s badge sits at `-right-1` while `BottomNav`'s is `-start-1` — opposite corners |
| 11 | `lib/rtl.ts` | Dead, actively misleading helpers: `rtlMargin()` returns physical `mr-`/`ml-`, `rtlFlexRow()` returns `flex-row-reverse`. Neither imported — delete |
| 12 | `InboxPageClient.tsx:201`, `ChildHeader.tsx:92` | Predicted 360px overflows: inbox header is `justify-between` with title + 3-segment filter (~190px) + 2×40px buttons on one non-wrapping row; `ChildHeader`'s select is `max-w-xs` (320px) inside `card-base px-4` alongside up to three 40px icon buttons |

Two notes to avoid wasted work: the `src/hooks/**` content-glob omission is
currently **inert** (those files contain no class strings) — fix as insurance,
don't bill it as a defect. And removing `<main overflow-y-auto>` does **not**
break `children.spec.ts:1158`: the timetable's `scrollIntoView({inline:'center'})`
acts on the nearest *horizontal* scroller, the wrapper at `TimetableSection.tsx:430`.

## Structural facts

- **5 of 13 routes bypass `AppShell`** — `/auth/sign-in`, `/auth/syncing`,
  `/more/telegram`, `/more/schools/new` each duplicate a `min-h-dvh … max-w-sm`
  shell. Being extracted into one primitive (user's call) so shell-level fixes
  land once.
- **Two modal idioms**: Radix portals vs. three hand-rolled `fixed inset-0`
  modals in `MorePageClient.tsx:319,368,425`. Being unified (user's call).
- **Deliberate horizontal scrollers**, correct on mobile, should become grids on
  desktop: home children rail, workspace tab rail, `SchoolFilterChips`
  (negative-margin bleed — it has an explanatory comment; preserve the intent),
  `BehaviorSection` filters, timetable.

## Reuse, don't reinvent

Extend the `@layer components` block in `globals.css` rather than adding
page-local breakpoints: `.page-shell` (8 pages) · `.card-base` (29) ·
`.tap-target` (19) · `.page-header` · `.section-stack` · `.page-title` ·
`.page-subtitle` · `.chip` · `.icon-button` · `.prose-rtl` · `.skeleton` ·
`.pb-nav` · `.pt-safe`. Colors: the semantic HSL tokens including the
`attention`/`positive`/`info` triads — never raw Tailwind palette.
Existing helpers: `lib/rtl.ts` `getTextDir()`, `lib/utils.ts` `cn()`,
`ui/LoadingState.tsx` (`Skeleton`/`CardSkeleton`/`FeedSkeleton`/`TableSkeleton`),
`lib/phase1-routes.ts`.

**No `xs: 360px` breakpoint.** 360 is a floor, not a breakpoint. Adding `xs`
invites the exact failure being fixed — authors write base styles for ~390px and
patch 360 with `xs:` overrides that *don't apply below 360*, making 320px worse.
The unprefixed layer **is** the 360 layer, enforced by the Task 6 assertion. Things
that must shrink further use intrinsic sizing (`min-w-0`, `clamp()`,
`flex-wrap`). Defaults `sm/md/lg/xl` stay; `2xl` stays unused.

## Verification (every task)

`cd frontend && npm run lint && npx tsc --noEmit && npm test`

---

## Task 1 — Responsive primitives + adaptive nav shell

`tailwind.config.ts`: add `./src/hooks/**` to `content`; `fontSize` `2xs` (11px)
and `3xs` (10px) to retire the ad-hoc `text-[10px]`/`text-[11px]`; `spacing`
`nav: 4rem` and `rail: 5rem` — the latter makes the shell offset expressible as
`lg:ps-rail`, logical, so RTL puts the rail on the right with no extra code.

`globals.css` base layer:
```css
html { -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
/* `clip`, NOT `hidden`: overflow:hidden makes html/body a scroll container,
   which breaks `position:sticky` descendants — and ChildWorkspacePage.tsx:166
   depends on `sticky top-2`. `clip` creates no scroll container. */
html, body { overflow-x: clip; }
body { overscroll-behavior-y: none; }
@supports not (overflow: clip) { body { overflow-x: hidden; } }
```
`touch-action: manipulation` goes on `.tap-target` / `.chip` only — **not on
`body`**, where it would remove double-tap-to-zoom globally and re-break WCAG
1.4.4 in the same breath as fixing `maximumScale`.

The one scrollbar utility (defect 2), replacing all three current approaches:
```css
@layer utilities {
  .scrollbar-hide { scrollbar-width: none; -ms-overflow-style: none; }
  .scrollbar-hide::-webkit-scrollbar { display: none; }
}
```

Adaptive primitives in the components layer:
- `.page-shell` gains `sm:px-5 lg:px-8 lg:pb-12`. A separate opt-in
  `.page-shell-wide { @apply xl:max-w-6xl }` — deliberately *not* folded in,
  because a 1280px-wide inbox or conversation is worse reading, not better. Only
  `/children` and the timetable earn it.
- `.page-header` gains `flex-wrap … sm:flex-nowrap` — fixes defect 12, a no-op
  on the pages that already fit.
- `.rail` / `.rail-bleed` — shared scroll-snap rail with
  `overscroll-behavior-x: contain` (stops rail scroll chaining to the page),
  carrying the bleed idiom `SchoolFilterChips` documents.
- `.card-grid` (`md:grid-cols-2 xl:grid-cols-3`), `.measure` (`max-w-3xl`),
  `.split-pane` — the last using `lg:grid-cols-[minmax(0,1fr)_20rem]`;
  `minmax(0,1fr)` not `1fr`, or a wide table child blows the column out.
- `.dialog-panel` with `max-height: min(80svh, 46rem)` behind a `80vh` fallback.
  **`svh` not `dvh`** (defect 4): `svh` is the *stable* small viewport, so the
  panel never resizes mid-scroll when the iOS toolbar collapses — plain `dvh`
  trades clipping for jank. The rem cap stops a 1440-tall desktop producing an
  1150px form. `dvh` stays for full-bleed surfaces where resizing is wanted.
- `.viewer-surface` — `fixed inset-0` below lg, a centred constrained panel at
  lg via `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`. Physical but
  symmetric, so it centres correctly under RTL; `start-1/2` there would be wrong.
  Plus `.viewer-bar-top`/`-bottom` applying safe-area padding only while
  full-bleed (defect 8).
- `.prose-rtl` gains the overflow guards for school-sent HTML (defect 3):
  `:where(img,video,iframe){max-width:100%;height:auto}` and
  `:where(table){display:block;width:max-content;max-width:100%;overflow-x:auto}`
  — each table gets its own scroller instead of pushing the page.
- `.pb-nav` gains `@media (min-width:1024px){padding-bottom:2rem}` (no bottom
  bar at lg); add `.pb-safe`, `.px-safe`; `.pt-safe` finally gets used.

**Nav shell — one `<nav>`, responsive classes.** Extraction and single-rendering
are orthogonal: take the extraction, reject the second renderer.
- `components/layout/navItems.tsx` (new) — `NAV_ITEMS` pure data + `useNavItems()`
  layering the `useDashboard()` unread badge on top.
- `components/layout/AppNav.tsx` (new) — the single `<nav>`, keeping
  `data-testid="bottom-nav"` and all `nav-*` testids verbatim.
- `components/layout/BottomNav.tsx` — deleted (one import site, no unit test).

Why one node rather than `BottomNav` + `SideRail`: two renderers means
`nav-inbox` resolves twice and both e2e call sites break under strict mode
(constraint 1), plus two `<nav>` landmarks in the a11y tree. Cost: longer
`className` strings. Worth it.

Geometry: `fixed inset-x-0 bottom-0` → at lg `lg:inset-y-0 lg:inset-x-auto
lg:start-0 lg:w-rail lg:border-s-0 lg:border-t-0 lg:border-e`. All logical, so
RTL lands the rail on the **right** edge with its border on the left, no
special-casing. The inline `paddingBottom: env(safe-area-inset-bottom)` moves to
`.pb-safe lg:pb-0` so it can be cancelled at lg. Inner `px-2` → `px-4` to align
the bar with `page-shell` content. Each `<Link>` goes `flex-1 flex-col` →
`lg:flex-none lg:w-full`, keeping `tap-target` and keeping the badge as **text**.

`AppShell.tsx` — three fixes in one file: `pt-safe lg:ps-rail lg:pt-0` on the
wrapper (defect 6 — padding belongs here, not in `UserHeader`, which returns
`null` when `me` is undefined and so would drop it on first paint), and
`overflow-y-auto` removed from `<main>` (defect 7).

Also in Task 1: delete `maximumScale: 1` (defect 1); migrate
`SchoolFilterChips.tsx:35` and `BehaviorSection.tsx:259` onto the shared rail
utilities; fix the 5 physical-property sites (defect 10); delete the dead
`rtl.ts` helpers (defect 11); extract the shared centred shell used by the 4
`AppShell`-bypassing routes.

**Task 1 is the commit most likely to regress something invisibly** — the
`overflow-y-auto` removal and `overflow-x: clip`. Smoke `/home` at 360/768/1280
by hand before moving on.

Commit: `feat(frontend): responsive primitives and adaptive nav shell`

## Task 2 — Home + children list

`app/home/HomePageClient.tsx` (children rail → `.card-grid` at md) ·
`components/home/ChildQuickCard.tsx` (`min-w-[176px] md:min-w-0 md:w-auto` — on
the child, per constraint 3) · `LatestFeed.tsx` + `FeedItem.tsx` (feed to
`.measure`) · `app/children/ChildrenPageClient.tsx:96` (ad-hoc `md:grid-cols-2`
→ `.card-grid`; shell gains `page-shell-wide`) · `components/children/ChildCard.tsx` ·
`components/school/SchoolBadge.tsx:52` → `max-w-[6rem] sm:max-w-[10rem] lg:max-w-none`
(defect 9).

No desktop aside on `/home` — it has no second content stream worth one.

Commit: `feat(frontend): adaptive layout for home and children list`

## Task 3 — Child workspace shell + non-timetable sections

`ChildWorkspacePage.tsx` — tab rail stops scrolling at md
(`md:flex-wrap md:overflow-visible`), becomes a vertical sidebar at lg via
`lg:grid-cols-[14rem_minmax(0,1fr)]` with `ChildHeader` spanning both. **Same
buttons, same `section-tab-*` testids, CSS-only flip** (constraints 1–2).

`ChildHeader.tsx` — the 360px overflow (defect 12): select →
`max-w-[min(100%,20rem)]`, action buttons wrap. Sections
(`Homework`/`Behavior`/`Subjects`/`Notices`) get `lg:grid-cols-2`, subjects
`md:grid-cols-2`. `ReleasesDialog.tsx:345,607` and
`SchoolActivitiesDialog.tsx:165` → `.dialog-panel`. Both detail pages →
`.measure` (an aside of metadata there is churn for no reading gain).

Commit: `feat(frontend): adaptive child workspace shell and sections`

## Task 4 — Timetable

Split `TimetableSection.tsx` (531 L) into three, with **all data logic
unchanged** — `useChildTimetable`/`useChildLessonPlans`/`useChildLessonHistory`,
`buildGrid`, `buildScheduleIndex`, `buildPlanIndex`, `buildHistoryIndex`,
`resolvePlan`, `resolveHistory`, `ClockRange`, `subjectColor` all stay:

- `TimetableSection.tsx` — keeps the hooks, renders both children
- `TimetableWeekGrid.tsx` — the existing `<table>`, wrapper gains `hidden md:block`
- `TimetableDayAgenda.tsx` — **new**, `md:hidden`

Why the agenda, concretely: at 360px with 32px of shell padding the viewport
shows 328px of a ~950px table — and the `w-20` lesson column plus the 196px
"today" column is 276px, i.e. **84% of visible width for 1 day of 6**. The cells
aren't atoms either: `LessonCell` stacks subject, teacher, a room pill and up to
three `LessonDetails` paragraphs at 11px inside 144px, and row height is set by
the worst cell in the row, so one long plan note inflates all six days. The
strongest evidence is in the code: the `headerRefs` + `hasAutoScrolledRef` +
`scrollIntoView({inline:'center'})` machinery exists *solely* to compensate for
the pattern. "Auto-scroll to today" is a worse version of "today is the selected
tab".

The agenda carries the identical dataset in one column: day chips א׳–ו׳ with
today preselected, then per day a vertical list of time · subject · teacher ·
room with plan/remark/homework at full width, and the existing `BreakRow` as a
slim divider.

Both children stay in the DOM, switched by CSS. The agenda gets **its own**
testids — `timetable-agenda-day-{n}`, `timetable-agenda-lesson`,
`timetable-agenda-break` — which is exactly what lets the existing count
assertions (`timetable-lesson-cell` → `toHaveCount(2)`, `timetable-lesson-time`,
`timetable-break-row`, `timetable-schedule-approximate`) keep passing
byte-for-byte at the 1280 default.

The ≥md grid keeps `overflow-x-auto` at every width as a free safety wrapper,
but drops the floors above mobile: `min-w-[196px]`/`min-w-[144px]` → `md:min-w-0`
plus `md:table-fixed`. Columns land at ≈109px at 768 (tight — pair with
`md:line-clamp-3 lg:line-clamp-none` on `LessonDetails`), ≈150px at 1024, ≈190px
at 1280 with `page-shell-wide`.

**Cost to be explicit about:** `children.spec.ts:1158` must be rewritten in this
same commit to assert that `timetable-agenda-day-{today}` is the pressed chip and
today's lessons are listed. Its `MockDate` init script and `weekDateForSchoolDay`
helper carry over unchanged. Add a vitest beside the agenda for today-selection
and plan/remark/homework rendering.

Commit: `feat(frontend): day-tabbed timetable agenda below md`

## Task 5 — Inbox, conversation, attachments, more, auth

`InboxPageClient.tsx` (the 360 header overflow; bulk bar `lg:sticky lg:top-4`;
list to `.measure`) · `ConversationPageClient.tsx` (the non-wrapping toolbar) ·
`MessageBubble.tsx:71` → `prose-rtl max-w-none …` (defect 3) · `MessageThread.tsx` ·
`AttachmentViewer.tsx:149` → `.viewer-surface` + `.viewer-bar-*` (defect 8) ·
`MorePageClient.tsx` → `.split-pane` (source-health, freshness, Telegram into the
aside) and its three modals converted to Radix · the four standalone routes onto
the extracted centred shell with `pt-safe`, `md:max-w-md`, and `lg:grid
lg:place-items-center`; `/auth/sign-in` gets `lg:grid-cols-2` so the illustration
sits beside the form instead of a 320px card floating in whitespace at 1280.

**Explicitly out of scope:** a two-pane list/detail inbox. That's a route-shape
change (`app/inbox/layout.tsx` with parallel slots), roughly a day, and belongs
in its own ticket rather than smuggled in here.

Commit: `feat(frontend): adaptive inbox, conversation, attachments, more and auth`

## Task 6 — Viewport regression tests

`playwright.config.ts`: **delete the misleading top-level `viewport` entirely**
rather than fixing it, so the trap can't re-form, and set viewport explicitly per
project *after* each device spread. Keep the existing `chromium` project at 1280
unchanged, and add `mobile-360` (`devices['Pixel 7']` + `viewport {360,780}`,
`isMobile: true`, `hasTouch: true`), `tablet-768`, `desktop-1280`, all three
matching only `**/responsive.spec.ts`.

`isMobile: true` matters: it enables meta-viewport emulation and touch, which is
what actually exercises the `maximumScale` removal, `env(safe-area-inset-*)` and
`svh`/`dvh` behaviour.

Deliberately **not** re-running the existing 12 specs at 360 — they encode the
current desktop DOM, would fail on every lg-only element, and would triple CI
time for no signal. Adaptive coverage lives in one new spec across three projects.

**The subtlety that shapes the overflow helper: the `overflow-x: clip` guard
added in Task 1 masks the very defect the test exists to catch.**
`documentElement.scrollWidth <= clientWidth` passes while content sits
unreachably off-canvas. So the primary check is a per-element walk of
`getBoundingClientRect()` over `body *`, skipping `display:none`,
`visibility:hidden`, zero-area, `position:fixed` (nav, dialogs and the viewer are
legitimately viewport-anchored), and anything inside an ancestor with
`overflow-x: auto|scroll` (the rails and timetable wrapper are intentional). It
checks **both** `r.right > vw + 1` **and** `r.left < -1`, because under RTL
overflow escapes to the *left*. The `scrollWidth` check stays as a cheap
backstop only. Helpers go in `tests/e2e/helpers/overflow.ts` and
`tests/e2e/helpers/viewports.ts`, the latter exporting the route list with its
readiness testid per route.

`responsive.spec.ts` also asserts, per project:
1. **Zoom not blocked** — `meta[name=viewport]` content fails
   `/maximum-scale|user-scalable\s*=\s*(no|0)/`.
2. **Nav shape flips** — `boundingBox()` of `bottom-nav`: at 360/768 a bottom bar
   (`y+height ≈ viewport.height`, `width ≈ viewport.width`); at 1280 a rail
   (`height ≈ viewport.height`, `width ≈ 80`, and `x+width ≈ viewport.width`
   because RTL puts it at the start edge).
3. **Tap targets at 360** — every `nav-*` and `section-tab-*` is ≥44×44. This is
   the guard for `.tap-target` surviving `lg:flex-none lg:w-full`.
4. **The adaptive content flip** — at 360 `timetable-agenda-lesson` is visible and
   `timetable-lesson-cell` is not; at 1280 the reverse. This is the assertion that
   would catch a hydration flip, and the one that proves Task 4 landed.

Commit: `test(e2e): viewport regression suite across 360/768/1280`

---

## Final verification

End to end, after Task 6:
1. `docker compose up -d --wait`
2. `npx playwright test` — full suite green, including the pre-existing specs at
   their unchanged 1280 default and the new `responsive.spec.ts` across
   `mobile-360` / `tablet-768` / `desktop-1280`.
3. Visual pass: Playwright screenshots of all 13 routes at 360 / 768 / 1280,
   reviewed for RTL correctness (rail on the right, badges on the start edge,
   `dir="ltr"` islands for clocks/emails/credentials intact).
4. Manual check of the two things automation reads poorly: pinch-zoom actually
   works on a real phone, and the PWA in `standalone` mode respects the notch and
   home indicator.

## Known follow-ups (not in this plan)

- Two-pane list/detail inbox via parallel routes.
- Moving the duplicated `ThemeToggle` + `RefreshButton` pair out of five
  `page-header`s into a rail footer at lg — touches five pages plus `theme.spec.ts`.
