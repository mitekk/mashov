# E2E binary fixtures

`sample.docx` is a real (if minimal) Word file: an RTL heading
"אישור הורים לטיול השנתי", a Hebrew body paragraph, a two-column bordered
table, and a closing line — enough to prove that the inline docx preview
parses the OOXML, honours the document's bidi, and renders its own borders
rather than the app's theme color. It is checked in because every other e2e
fixture in this repo is built in-memory from base64 or a template literal, and
a zip container is not reasonably expressible that way; the e2e container
mounts `./:/work`, so the file is visible to the suite as-is.

Regenerate with `python3 make-sample-docx.py sample.docx` (standard library
only — `zipfile`; no Word and no npm dependency involved). Edit the paragraphs
in that script rather than opening the file in Word, which would rewrite it
into something far larger. If you change the heading text, update the
assertions in `tests/e2e/attachments.spec.ts` that look for it.

`hostile.docx` is the crafted counterpart, from the same generator
(`python3 make-sample-docx.py hostile.docx`). It carries the two vectors the
viewer must neutralize: a hyperlink relationship whose target is
`javascript:window.__docxPwned=1` (the library assigns `a.href` from the
relationship with no scheme check), and a paragraph style whose font name is
`a}*{background-image:url(https://evil.example/beacon.png)}x{y:z` — no
whitespace, so the library leaves it unquoted and it escapes its declaration
block in the generated stylesheet. The e2e tests assert that neither reaches
the page: the anchor loses its `href` and the beacon is never requested. Do not
"fix" the fixture — breaking it would silently retire both regression tests.

Both files use a fixed zip timestamp, so regenerating one whose text has not
changed produces identical bytes rather than a binary diff.
