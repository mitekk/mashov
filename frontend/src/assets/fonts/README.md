# Assistant (self-hosted)

The app's only typeface, served from this repo instead of `fonts.googleapis.com`.

| | |
|---|---|
| Family | [Assistant](https://fonts.google.com/specimen/Assistant) |
| Version | **v24** (Google Fonts `assistant/v24`) |
| Licence | SIL Open Font License 1.1 — see [`OFL.txt`](./OFL.txt) |
| Format | variable woff2, one file per subset, `wght` axis `300..700` |
| Loaded by | [`frontend/src/app/layout.tsx`](../../app/layout.tsx) via `next/font/local` |

## Why these files are here

`next/font/google` resolves the family over the network **during `next build`** — so
the Docker image build depended on Google Fonts answering correctly, and twice in one
day it did not (`TypeError: Cannot read properties of null (reading '1')` out of
`@next/font/dist/google/loader.js`, a failed regex match on the served CSS). Committing
the woff2 files makes `next build` hermetic: `npm ci` is now its only network
dependency. See [ADR-0043](../../../../docs/adr/0043-self-hosted-font.md).

## Files

| File | Bytes | Preloaded |
|---|---|---|
| `assistant-hebrew.woff2` | 7 336 | yes |
| `assistant-latin.woff2` | 22 056 | yes |
| `assistant-latin-ext.woff2` | 11 224 | no (`preload: false`) |

Each file covers all five weights the app uses — they are variable fonts, which is why
`layout.tsx` passes `weight: '300 700'` (a range, not a list).

## Updating the font

> **The `unicode-range` strings live in `layout.tsx`, not in these files.** They must be
> updated in the same commit as the binaries. Google changes subset coverage between
> font versions; a stale range silently stops a glyph from resolving to the real face.

```bash
./fetch-assistant.sh
```

The script re-downloads all three subsets plus `OFL.txt` and then **prints each
subset's `unicode-range`**. Diff that output against the three `declarations` entries in
`layout.tsx` and update them if they differ. Also bump the version recorded above.

It is never run by a build. It needs only `curl` and `python3`; the files are taken from
Google exactly as served, because no subsetting toolchain (`fonttools`, `pyftsubset`,
`woff2_compress`) is installed here and Google's subsets are already optimal.

## Do not move these to `frontend/public/`

`frontend/src/middleware.ts` auth-gates `/public`, so `/fonts/*.woff2` would 307 a
signed-out visitor to the sign-in page — the bug recorded in
[ADR-0041](../../../../docs/adr/0041-self-hosted-image-optimization.md). `next/font/local`
emits into `/_next/static/media/`, which is already public, and keeps Next's
`<link rel="preload">` and fontkit-derived fallback metrics.

## Two traps, if you edit `layout.tsx`

**All three calls declare the same `font-family: 'Assistant'`.** Keep it that way. The
`adjustFontFallback` shim adds an unranged `@font-face` for `'Assistant Fallback'`
(`src: local("Arial")`), and unranged means it matches every glyph. Give each subset its
own family name and chain them in the CSS, and that shim lands ahead of the other
families — every Latin digit then renders in size-adjusted Arial, silently. One shared
family keeps all three real faces at position 1 of the stack.

**The font classes belong on `<body>`, not `<html>`.** The theme bootstrap toggles `dark`
on `document.documentElement` before hydration; giving `<html>` a React `className` lets
React wipe that class and dark mode stops persisting. (The `html { font-family }` rule in
`globals.css` consequently never resolves — that is pre-existing and commented there.)

**Every call's return value must be referenced in rendered JSX.** Next registers the
next/font webpack rule with `sideEffects: false`, so a `localFont()` call whose object goes
unused is tree-shaken and its `@font-face` disappears from the **production** bundle while
dev keeps working. That is the only reason the hebrew and latin-ext calls declare
`variable` names no CSS reads.

Both are asserted by `tests/e2e/fonts.spec.ts`.
