# Inline `.docx` preview in the attachment viewer

## Context

The attachment viewer already opens images, PDFs and text files inline. A `.docx`
gets the "לא ניתן להציג את הקובץ בתוך האפליקציה" card and a download button —
`previewKindFor` in `frontend/src/lib/mime.ts` routes the OOXML MIME type to
`'unsupported'`, and `useAttachmentBlob`'s `shouldFetch` gate deliberately skips
the network request entirely, on the reasoning that the bytes could not change
the outcome.

Israeli schools send a lot of Word: permission slips, letters, forms. For a
parent on a phone, "download it and find an app that opens it" is where the task
ends. The goal is to render `.docx` in the viewer with its own styling and
correct RTL, with no backend change.

Chosen approach: **`docx-preview`**, lazy-loaded on first use. It parses the
OOXML and builds page-like DOM honoring the document's own styles including
bidi, which matters more here than bundle size — these are Hebrew documents, and
`mammoth` emits no `dir` at all. Scope is `.docx` only; `.xlsx`, `.pptx` and
legacy `.doc` keep today's download card.

## Constraints discovered during exploration

These are the non-obvious things the implementation has to respect.

1. **The allowlist in `mime.ts` is a security control, not a convenience.** Its
   doc comment says so explicitly: a `blob:` URL inherits this document's origin
   for scripting, so a script-bearing file inside `<iframe>`/`<object>`/`<embed>`
   is stored XSS with the session cookie attached. `docx-preview` builds DOM
   nodes from XML rather than injecting an HTML string, so it does not need a
   frame — **the docx render must go into a plain element in the page, never a
   frame.** Keep `'unsupported'` as the default branch.
2. **`printBlob` would misroute it.** `frontend/src/lib/blob-actions.ts` re-derives
   the kind itself and its branch selection is `pdf` → `image` → `else text`. A
   new `'docx'` kind lands in the `else`, printing the raw zip bytes escaped into
   a `<pre>`. And `AttachmentViewer`'s `canPrint` is
   `previewKind !== 'unsupported'`, so the Print button would switch on and do
   exactly that. Both must be updated in the same change.
2b. **The print frame's `srcdoc` inherits this origin.** `printBlob` builds its
   off-screen iframe with no `sandbox` attribute, deliberately — the comment in
   the file explains that `allow-scripts` on a blob URL is the one actively
   unsafe combination, and that without it the PDF viewers are disabled. A
   `srcdoc` document is same-origin with this page, so any script that survives
   into the docx print HTML would run with the session cookie attached. The
   serialized render must therefore be sanitized before it reaches `srcdoc`.
3. **Tailwind preflight will corrupt the render.** Preflight is enabled and
   `frontend/src/app/globals.css` adds `* { @apply border-border; box-sizing:
   border-box }`. So every docx border inherits the app's theme color instead of
   its own, cell width math changes, headings lose size and weight, and lists
   lose their markers. The existing `.prose-rtl` class is *not* reusable here —
   its `:where(*) { color: inherit; font-family: inherit; line-height: inherit }`
   would override the document's typography, which is the whole point of
   choosing `docx-preview`.
4. **No size is known before fetching.** `Attachment` in
   `frontend/src/types/api.ts` is `{ fileId, fileName }` — no MIME type, no size —
   and the Next proxy at `frontend/src/app/api/v1/[...path]/route.ts` deletes
   `content-length` from the response. There is no byte cap anywhere in the
   backend either. So an oversized docx can only be refused *after* the transfer,
   from `blob.size`.
5. **No lazy-loading precedent and no CSP.** There is no `next/dynamic`,
   `React.lazy` or dynamic `import()` anywhere in `frontend/src` — this will be
   the first. There is no Content-Security-Policy in the repo, so nothing will
   block the render, and nothing protects it either.
6. **No frontend test runner exists.** `frontend/package.json` has no test
   script; the only unit tests for this area live in
   `tests/integration/attachment-helpers.test.ts` (Jest + ts-jest, node
   environment, pure functions only). A React component cannot be unit tested
   without adding jsdom + testing-library, which is a tooling decision that
   should not ride along with this feature. Component behavior is therefore
   covered by e2e.

## Implementation

### 1. Dependency

Add `docx-preview` to `frontend/package.json` dependencies, pinned to an exact
version. Confirm `npm audit --audit-level=high` stays clean (Definition of Done)
and record the installed version's option names — the safe-options list in step 4
depends on them.

### 2. `frontend/src/lib/mime.ts`

- Add `'docx'` to the `PreviewKind` union.
- Add a `DOCX_MIME_TYPE` constant and a branch in `previewKindFor` returning
  `'docx'` for it, placed after the SVG and image checks and before the `pdf`
  check. Leave `.doc`, `.xls*`, `.ppt*` and archives on the `'unsupported'`
  default.
- Update the module header comment: the `.docx`/`.zip` example in
  `mimeFromExtension`'s doc comment, and the `previewKindFor` comment, both
  currently state that a docx can never render inline. Replace with the real
  invariant — docx renders in-page via DOM construction, never in a frame.

### 3. `frontend/src/hooks/useAttachmentBlob.ts`

`shouldFetch` needs no change: it already asks `previewKindFor`, so once docx is
no longer `'unsupported'` the fetch happens. Verify that, do not special-case it.

Add `blob` to the props passed down from the viewer — `AttachmentPreview`
currently receives `objectUrl` and `text` but not the blob, and the docx renderer
needs the bytes. The hook already exposes `blob`.

### 4. New `frontend/src/components/attachments/DocxPreview.tsx`

A client component taking `{ blob, fileName, onDownload, onRendered }`.

`onRendered` is what makes print possible: once the parse succeeds, the component
hands the caller the serialized render — `{ html, css }` — which
`AttachmentViewer` holds in a ref and passes to `printBlob`. Reset it to `null`
whenever the blob changes, so next/prev can never print the previous document.

- **Lazy load**: `const { renderAsync } = await import('docx-preview')` inside the
  effect, so the ~1MB chunk is fetched only when a parent actually opens a Word
  file. Guard against the effect resolving after unmount (Radix drops
  `Dialog.Content` on close) and against a stale blob resolving after next/prev.
- **Size ceiling**: refuse above a `DOCX_PREVIEW_LIMIT_BYTES` cap (10MB
  suggested — the text path's own ceiling is 512KB, and parsing a 30MB docx on
  the main thread would jank it). Over the cap, render the existing
  `UnsupportedCard` with a "file too large to display" message rather than
  attempting the parse. This is the post-fetch check from constraint 4.
- **Safe render options**: disable the alt-chunk path (`renderAltChunks: false`
  or equivalent in the installed version). Alt chunks embed arbitrary HTML
  carried inside the docx and are the one genuine injection vector in this
  library; if the installed version has no such option, sanitize that subtree
  with the existing `dompurify` dependency before display. Also set
  `useBase64URL: true` so embedded images become data URLs instead of
  `blob:` URLs this component would have to revoke by hand. Keep
  `renderChanges: false`.
- **CSS isolation**: render into a shadow root attached to the container div, so
  preflight's `*` selectors and the global `border-border` rule cannot cross the
  boundary, and pass the same root as `docx-preview`'s style container.
  Verify this against the installed version during implementation — if it
  insists on a light-DOM `HTMLElement`, fall back to a scoped reset in
  `globals.css` under a `.docx-render` class, undoing preflight for the subtree
  with `:where()` at zero specificity: `box-sizing: content-box`,
  `border-color: currentColor`, and `margin`/`font-size`/`font-weight`/
  `list-style`/`padding` set to `revert`. Record whichever route is taken in a
  comment, since it is load-bearing and not obvious.
- States: a `LoadingState` while the chunk and parse are in flight, and the
  `ErrorState` + direct-download link pattern already used in
  `AttachmentPreview` if the parse throws (a corrupt or mislabeled file).
- `data-testid="attachment-preview-docx"` on the container.

### 5. `frontend/src/components/attachments/AttachmentPreview.tsx`

Add a `previewKind === 'docx'` arm rendering `DocxPreview`, placed with the other
arms and above the final `UnsupportedCard` fallback. Export `UnsupportedCard` (or
lift it to its own file) so `DocxPreview` can reuse it for the too-large case.
Extend the module's security comment to say why docx is in-page and not framed.

### 6. `frontend/src/lib/blob-actions.ts` and `AttachmentViewer.tsx`

Close the print hole from constraint 2 and add the docx arm:

- In `AttachmentViewer.tsx`, change `canPrint` from the negative
  `previewKind !== 'unsupported'` to a positive allowlist of the kinds
  `printBlob` can actually handle — now `pdf | image | text | docx`. This is the
  fix that stops a future kind from silently enabling a broken button. For docx,
  also require that the render has completed (the `onRendered` ref is populated),
  so the button is not live while the document is still parsing.
- In `printBlob`, make the final branch explicit rather than a catch-all `else`:
  `text` prints the `<pre>` document, and anything else falls back to
  `triggerBlobDownload` — the same fallback `'unsupported'` already gets.
- Add a `docx` arm. `printBlob` currently takes `(blob, mime, fileName,
  fallbackHref)`; extend it with an optional last argument carrying the
  `{ html, css }` from step 4, and build a `docxPrintDocument(html, css)`
  template alongside the existing `imagePrintDocument` / `textPrintDocument`:
  `PRINT_PAGE_STYLE`, then the document's own CSS, then the sanitized body HTML,
  with `dir="rtl"` on the root element. When the argument is absent (parse not
  finished, or a caller that does not have it), fall back to
  `triggerBlobDownload` rather than printing something wrong.
- **Sanitize before `srcdoc`**, per constraint 2b: run the serialized HTML
  through the existing `dompurify` dependency. Do *not* reuse
  `sanitizeRichTextHtml` from `frontend/src/lib/richText.ts` — its config strips
  `style`, `class`, `span`, `table`/`tr`/`td`, `img` and `width`, which is
  everything a docx render depends on. Write a dedicated config in
  `blob-actions.ts` (or a small sibling module) that keeps table, span, img and
  inline `style`/`class`, and relies on DOMPurify's defaults to drop `script`,
  event-handler attributes and `javascript:` URLs. Comment it with why the
  richText config cannot be used, since the temptation to reuse it is obvious.

Download already works for docx unchanged: `handleDownload` uses
`triggerBlobDownload` with the blob in hand.

### 7. `frontend/src/components/attachments/AttachmentList.tsx`

No change. It shows one `Paperclip` per row and does not consult `mime.ts`;
per-type icons would be a separate, larger change.

## Tests

### Unit — `tests/integration/attachment-helpers.test.ts`

This file currently asserts the opposite of the new behavior in two places that
must be inverted:

- the `it.each` case `['application/vnd.openxmlformats-...wordprocessingml.document', 'form.docx']`
  under `'treats %s as unsupported'` — move `form.docx` out, keep `grades.xls`,
  `bundle.zip`, `mystery`.
- `it('names the office and archive types that can never preview')` — drop
  `form.docx` from the loop, keep `grades.xlsx`, `deck.pptx`, `bundle.zip`, and
  update the comment, which explains the skip-the-fetch pairing.

Add: `previewKindFor` returns `'docx'` for the OOXML type; returns `'docx'` when
the header is `application/octet-stream` and the filename is `form.docx` (the
extension-fallback path, which is the common real case); still returns
`'unsupported'` for `.doc`, `.xlsx`, `.pptx`; and an `evil.svg` served with the
docx MIME type still routes to `'image'` (strictest-source-wins must survive the
new branch).

### E2E — `tests/e2e/attachments.spec.ts`

Two existing tests use `file-docx` as their stand-in for an unpreviewable file
and now contradict the feature. Repoint both at an `.xlsx` fixture, which keeps
their intent intact:

- `'offers download but not print for a file it cannot preview'`
- `'does not download a file whose extension already rules out a preview'`
  (the assertion `expect(requested).toEqual([])` is still correct for xlsx)

Add docx cases, using `AttachmentViewerPage` with a new `docxPreview` locator for
`attachment-preview-docx`:

- a real `.docx` renders: viewer opens, `attachment-preview-docx` visible, and
  the document's Hebrew body text is present in the DOM (asserting text, not
  just the container, is what proves the parse worked). If the shadow-root route
  is taken, the assertion needs a shadow-piercing locator — Playwright's
  `getByTestId`/text engines pierce open shadow roots, so this works, but it is
  worth confirming early since it affects step 4's choice.
- the docx request *is* made now (the inverse of the skip-the-fetch test).
- a file named `.docx` whose bytes are not a zip shows the error state with the
  direct-download fallback link, not a crash. The existing fake fixture
  (`Buffer.from('PK\x03\x04 not really a docx')`) is exactly this case — keep it
  under a new id such as `file-docx-corrupt`.
- the Print button *is* present for docx once rendered, and clicking it inserts
  `attachment-print-frame` (the page object already has a `printFrame` locator,
  and `stubShell` already neutralizes `window.print`). Assert the frame's
  document contains the fixture's Hebrew body text — that is what distinguishes
  a correct docx print from the old `<pre>`-of-zip-bytes failure mode.
- the Print button is absent for the corrupt docx, whose parse never completes.

### Fixture

This needs the repo's **first binary test fixture** — every existing e2e fixture
is built in-memory from base64 or a template literal, and there is no
`fixtures/` directory. Add `tests/e2e/fixtures/sample.docx`: a small real Word
file with a Hebrew paragraph and a short table, served by `fulfillAttachment` via
`fs.readFileSync` with the OOXML content type. The e2e container mounts `./:/work`
so a checked-in file is visible. Add a one-paragraph `tests/e2e/fixtures/README.md`
recording what the file contains and how it was generated, so the next person can
regenerate it.

## Verification

1. `npm run typecheck` and `npm run lint` in `frontend/` — clean.
2. `npm run test:integration` — the `attachment-helpers` suite passes with the
   inverted docx assertions.
3. `PLAYWRIGHT_ARGS=tests/e2e/attachments.spec.ts npm run test:e2e` — the
   attachment suite passes against the Dockerized stack.
4. `docker compose up --build`, then open a conversation or homework item with a
   real Hebrew `.docx` attachment and check by eye, which is the part no test
   covers: RTL direction and paragraph alignment, that borders are the
   document's own and not the app's theme color, that list markers are visible,
   that tables are not squashed, and that the dark-mode page background does not
   leave black-on-black text (the docx carries its own colors, the app's
   `--foreground` does not reach it).
5. Confirm the chunk is genuinely deferred: the `docx-preview` chunk must appear
   in the network panel only after opening a Word file, not on first page load.
   Check `npm run build` output for where it landed.
6. Open an image, a PDF and a text attachment afterwards to confirm no
   regression, and confirm Print still works for those three.
7. Print a real Hebrew docx and check the print preview by eye: RTL direction,
   the document's own fonts and borders, page breaks, and that tables are not
   clipped at the page edge. Confirm the off-screen frame is removed afterwards
   (`afterprint` cleanup) and nothing is left in the DOM.
8. `npm audit --audit-level=high` in `frontend/` — no new high/critical CVEs.

## Follow-ups, deliberately out of scope

- **Legacy `.doc`** — binary format, no viable client-side parser; needs
  server-side LibreOffice conversion.
- **`.xlsx` / `.pptx`** — separate libraries, separate render branches.
- **A per-type icon in `AttachmentList`** so a parent can see before tapping
  whether a file will open.
- **An ADR** recording the choice of in-page DOM rendering over a frame and over
  server-side conversion. The repo has `docs/adr/` and an `/adr` skill; this
  decision has the lasting consequences that warrant one.

## Corrections found while executing this plan

Two of the constraints above were wrong, and the review caught both. They are
left in place rather than edited, because the plan is a record of what was
believed at the time — but do not carry either one forward.

**Constraint 1 proves less than it claims.** "`docx-preview` builds DOM nodes
from XML rather than injecting an HTML string, so it does not need a frame" is
true and relevant, but it closes *markup* injection only. The library assigns
`a.href` straight from `word/_rels/document.xml.rels` with no scheme check, and
it interpolates document-controlled font names into the stylesheet it
generates. The in-page render therefore needs sanitizing of its own — which
this plan gave only to the print path, the less exposed of the two. See
`frontend/src/lib/docx-safety.ts`.

**Step 4's size ceiling measures the wrong thing.** `blob.size` is the
compressed archive; the parse cost tracks the *uncompressed* `word/document.xml`,
which deflates by two orders of magnitude. A file well under the cap can still
freeze the main thread for minutes. The implementation reads the zip's central
directory for that one entry instead, before inflating anything.
