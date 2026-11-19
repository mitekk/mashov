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
