# ADR-0042: Assistant Is Committed to the Repo — One `next/font/local` Call per Subset, All Sharing One Family Name

- **Date**: 2026-11-23
- **Status**: Accepted
- **Deciders**: User, Frontend agent
- **Related**: [ADR-0041](0041-self-hosted-image-optimization.md) — the same "this deployment has no CDN, so do it in-container" reasoning, and the source of the `/public` middleware trap cited below

## Context and Problem Statement

`frontend/src/app/layout.tsx` loaded Assistant through `next/font/google`. That helper is
not a runtime link to Google Fonts — it resolves the family **during `next build`**, by
fetching CSS from `fonts.googleapis.com` and then the woff2 files behind it. In this
project `next build` runs inside `docker build`, so **every image build, local and CI and
production, made an outbound request to Google.**

Twice in four CI runs on 2026-11-23 that request came back with something the loader could
not parse:

```
src/app/layout.tsx
An error occurred in `next/font`.
TypeError: Cannot read properties of null (reading '1')
    at @next/font/dist/google/loader.js:122:78
> Build failed because of webpack errors
```

A null regex match on the served CSS. Once on PR #31 — shard 2 failed while shard 1 built
the *same commit* successfully, which rules out the commit and points squarely at the
response. Once on `master` directly, after merging #32 and #33. Both times a bare re-run
passed.

There is no retry around that fetch. At the observed rate it is roughly a coin flip per
image build, it now lands on the default branch where a red `master` blocks everyone, and
a production deploy can fail for a reason that has nothing to do with the code being
deployed.

An Explore pass confirmed this was the frontend build's **only** network dependency beyond
`npm ci`. Removing it makes `next build` hermetic.

The constraint on the fix: **byte-identical font delivery and no visual change.** Same
files, same subsets, and in particular the same two files preloaded — PR #32 had just
corrected the preload set from `latin` alone (which renders almost nothing in a
`lang="he" dir="rtl"` app) to hebrew + latin, and that fix must survive.

## Decision Drivers

- `next build` must make no network request. `npm ci` stays as the one exception.
- No regression: identical glyph coverage, identical preload set, no layout-shift
  regression on font swap.
- No new build-time tooling. No font subsetting toolchain exists on the development
  machine (`fonttools`, `pyftsubset`, `woff2_compress`, `brotli` — none installed).
- Correct **by construction** where possible, rather than correct while a hand-maintained
  invariant holds. This stack will not be looked at again for a year.
- Font updates must stay a documented, repeatable operation, not folklore.

## Considered Options

1. **`next/font/local`, one call per subset, all three declaring the same
   `font-family: 'Assistant'`** — chosen.
2. **One call per subset, each with its own generated family name, chained in the CSS
   font-family stack** — the original shape of this plan. Rejected; see below.
3. **A single `next/font/local` call listing all three files as `src` entries.**
4. **Hand-written `@font-face` in `globals.css`, files in `frontend/public/fonts/`.**
5. **Keep `next/font/google` and retry the build on failure.**

## Decision Outcome

Chosen: **option 1.** The three Assistant subsets are committed to
`frontend/src/assets/fonts/` and loaded by three `localFont()` calls, each passing
`font-family: 'Assistant'` in `declarations` so that all three faces share one family —
reproducing exactly the CSS the Google loader emitted before. `globals.css` and
`tailwind.config.ts` are **unchanged**.

### Why three calls and not one

Next's `build/webpack/loaders/next-font-loader/postcss-next-font.js` takes the
`font-family` of the *first* `@font-face` produced by a call and rewrites every other face
in that call to match. And `declarations` is a per-call option, not a per-`src` one. So a
single call cannot carry a different `unicode-range` per file — option 3 would produce
three faces sharing one range, and the browser would download all three files for any text
at all. Per-subset ranges are the entire mechanism by which a Hebrew reader does not pay
for `latin-ext`; keeping them requires one call per subset.

That `unicode-range` is settable at all is worth recording: Next's
`local/validate-local-font-function-call.js` rejects only `src`, `font-display`,
`font-weight` and `font-style` from `declarations`. Everything else passes through. So is
`font-family`, and deliberately so — `local/loader.js` checks
`hasCustomFontFamily = declarations?.some(({ prop }) => prop === 'font-family')` and omits
its own generated name when one is supplied. It is a supported path, not a loophole.

### Why one shared family name, and not three chained (option 2)

This is the crux, and option 2 — the shape this change was originally planned as — is
quietly broken.

`postcss-next-font` builds each CSS variable not as one family but as
`formatFamily(fontFamily), [adjustFontFallbackFamily], ...fallbackFonts`. The
`adjustFontFallback` shim it appends is

```css
@font-face{font-family:Assistant Fallback;src:local("Arial");
  ascent-override:109.94%;descent-override:30.90%;size-adjust:92.87%}
```

— and that face carries **no `unicode-range`**, so by CSS font-matching it matches every
codepoint in existence. Under option 2, chaining `var(--a), var(--b), var(--c)` expands to

```
'A', 'A Fallback', 'B', 'B Fallback', 'C', 'C Fallback', system-ui, sans-serif
```

A Latin digit misses `'A'` (ranged to Hebrew, say), then **hits `'A Fallback'`**, which is
size-adjusted Arial. Family `'B'` is never reached. Only the first real family in the
chain is ever reachable, for anything. The damage is silent: the page renders, no error is
logged, and the text is simply in the wrong typeface at 92.87% scale.

Option 2 can be made to work — allow the shim on exactly one call and make sure that
call's variable is listed last — but its correctness then rests on a hand-maintained
ordering invariant spread across `layout.tsx`, `globals.css` and `tailwind.config.ts`, with
nothing but a comment to protect it.

With one shared family name the problem disappears structurally: every real subset sits at
position 1 of the stack, covers its own range, and the shim can never shadow anything
regardless of order. Sharing the name costs nothing — Next no longer hashes family names
in the emitted CSS (`postcss-modules-local-by-default` localises only `animation-name` and
`url()`, never `font-family`; the hash lives in the CSS-Modules *selector* names,
`.__variable_65073b`), and preload generation is keyed on the module and the emitted
filename's `.p.` marker, never on the family. Three modules sharing a family contribute to
the preload manifest independently. As a bonus, `globals.css` and `tailwind.config.ts` need
no edit at all.

### The shim comes from the latin file, not the hebrew one

fontkit's `calcAverageWidth` (`local/get-fallback-metrics-from-font-file.js`) measures the
string `'aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      '` and returns `undefined` when the font
has no glyph for some codepoint in it — which collapses `sizeAdjust` to `1` and computes
the ascent/descent overrides against an unadjusted em.

The hebrew subset contains no `a–z`. Deriving the shim from it would therefore yield
`size-adjust: 100%` — a *worse* shim than the `92.87%` shipping today, and worse layout
shift on swap. So `adjustFontFallback` stays on the **latin** call and is `false` on the
other two. Under option 1 the ordering is free, so this costs nothing. (The planning
assumption that Hebrew's metrics would be "the representative ones" was wrong in the
opposite direction: Next cannot read Hebrew metrics at all, it just silently gives up.)

### The font stays on `<body>`, and the `html` rule is dead code

`globals.css` has always had `html { font-family: var(--font-assistant), … }`, but the
next/font `.variable` class is applied to `<body>`. Custom properties inherit **downward
only**, so on `html` that `var()` is invalid at computed-value time and the whole
declaration is dropped. Verified in the build output: the font is applied entirely by
`.__className_239291{font-family:Assistant,Assistant Fallback}` on `<body>`; the `html`
rule has never done anything.

The obvious tidy-up — move the classes to `<html>` so the rule finally resolves — was
tried and **reverted, because it breaks dark mode.** The inline `themeBootstrap` script
toggles `dark` on `document.documentElement` before hydration; giving `<html>` a React
`className` prop lets React reconcile that attribute and wipe the class.
`suppressHydrationWarning` silences the warning, not the patching. Two `theme.spec.ts`
tests caught it immediately (theme not persisting across reload and navigation).

`<html>`'s class attribute therefore belongs to the theme, and the font stays on `<body>`
exactly as it is today — `assistantLatin.className` plus the three `.variable` values. The
shared family name is what makes one `.className` sufficient for all three subsets.
Tailwind's `font-sans` utilities resolve the variable normally, since they match elements
inside `<body>`.

The dead `html { font-family }` declaration is removed, with a comment in its place saying
why nothing belongs there. It never applied, so deleting it changes no rendering; `<body>`'s
generated `.className` and Tailwind's `font-sans` already cover every element.

### A subset can silently vanish

`build/webpack/config/blocks/css/index.js` registers the next/font loader rule with
`sideEffects: false`. A `localFont()` call whose returned object is never referenced is
therefore tree-shaken, and its `@font-face` disappears from the **production** bundle while
dev still works. The hebrew and latin-ext calls declare `variable` names that no CSS ever
reads, purely so all three objects are referenced in rendered JSX. `tests/e2e/fonts.spec.ts`
asserts three `Assistant` faces are present for this reason.

### Why not `/public/fonts` (option 4)

`frontend/src/middleware.ts` auth-gates `/public`: its `PUBLIC_PATHS` are `/auth/`,
`/api/v1/auth/`, `/_next/` and `/api/health`, plus a short `PUBLIC_FILES` allowlist.
`/fonts/*.woff2` matches none, so a signed-out visitor to the sign-in page would get a 307
to sign-in for every font file — the bug recorded in ADR-0041. Widening the auth gate for
a font is the wrong trade. Option 4 would also mean hand-written preload tags and
hardcoded fallback metrics that drift on update. `next/font/local` emits into
`/_next/static/media/`, already allowlisted by the `/_next/` prefix, and keeps both the
preload machinery and the fontkit-derived metrics.

### Why not retry (option 5)

A retry hides a failure mode rather than removing it, and still leaves a production deploy
able to fail because of a third party. `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` is no answer
either: it supplies only the CSS, and `fetchFontFile` would still reach
`fonts.gstatic.com`. The fetch is unnecessary; the right move is to not make it.

### The files

Assistant is a **variable** font and Google serves one woff2 per subset covering the whole
`wght` axis, so all five weights the app uses come from one file per subset. Hence
`weight: '300 700'` — a range, which is the loader's supported path for variable fonts, and
the exact `font-weight` Google declares for these files.

| subset | bytes | preloaded |
|---|---|---|
| hebrew | 7 336 | yes |
| latin | 22 056 | yes |
| latin-ext | 11 224 | no |

39.7 KB total. All three are committed and exactly the two preloaded before are preloaded
now, so this is a no-regression change rather than a trade; `latin-ext` costs a visitor
nothing until a glyph needs it. The files are used **exactly as Google serves them** —
nothing is re-encoded, because no subsetting toolchain exists here and Google's subsets are
already optimally cut.

## Consequences

**Good**

- `next build` is hermetic. `npm ci` is the build's one remaining network dependency, and
  a Google Fonts hiccup can no longer redden `master` or fail a deploy.
- Font delivery is unchanged where it counts: the three woff2 files are byte-identical to
  what Google served (the latin file even lands on the same build hash,
  `67ea4463d4a1f79e-s.p.woff2`, 22 056 B), the subsets are the same, and the same two are
  preloaded.
- The shadowing trap is gone by construction rather than by convention, and
  `globals.css` / `tailwind.config.ts` needed no change.
- `tests/e2e/fonts.spec.ts` guards the preload set, the presence of all three subsets
  (against tree-shaking), and — by measuring rendered text width against both candidate
  families — that text really renders in Assistant and not in the Arial shim. Before this
  change nothing in the suite asserted anything about fonts or head contents, so #32's
  preload fix was unguarded too.

**Bad / accepted**

- **The fallback shim's metrics changed slightly**, from
  `ascent-override:109.94%; descent-override:30.90%; size-adjust:92.87%` to
  `114.19% / 32.10% / 89.41%`. This is inherent to the loader swap, not a mistake:
  `next/font/google` reads precomputed capsize metrics for the *whole* font from
  `capsize-font-metrics.json`, while `next/font/local` has fontkit measure the latin
  subset's own `a–z` advance widths. Both are approximations of "scale Arial to match
  Assistant" and differ by ~3.5%. It affects only the brief `display: swap` window and the
  no-webfont case, never rendered Assistant text — and in practice the shim face reports
  `unloaded` on the sign-in page, i.e. it is never used at all.

- `<html>` carries no `font-family` of its own any more. Nothing renders text at that
  level so it changes nothing, but it does mean the font is applied in exactly one place
  (`<body>`'s generated class) rather than two nominal ones.

- **Font updates are now manual.** Not a version bump: run
  `frontend/src/assets/fonts/fetch-assistant.sh`, then diff the `unicode-range` values it
  prints against the three `declarations` entries in `layout.tsx` and update them in the
  same commit. A stale range silently stops a glyph resolving to the real face.
  `frontend/src/assets/fonts/README.md` says so and pins the version (v24).
- 39.7 KB of binary now lives in git history, and grows by that much per update.
- The repo gains its **first licence file** (`OFL.txt`). Assistant is OFL-1.1 and the
  licence must ship with the font; no previously committed third-party asset carried one.
- Three calls are more code than one was, and two of the three `variable` names exist only
  to defeat tree-shaking — a non-obvious reason, so it is commented at the site.

**Neutral**

- `frontend/Dockerfile` needed no change: `localFont` emits into `.next/static/media/`,
  which the runner stage already copies, and the sources under `src/` are build-time only —
  the same mechanism as the sign-in illustration under `src/assets/images/`.
