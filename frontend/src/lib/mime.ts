/**
 * MIME resolution for attachment previews.
 *
 * The backend sets `Content-Type` from whatever Mashov reported and falls back
 * to `application/octet-stream` when upstream said nothing
 * (`mail.controller.ts`, `children.controller.ts`) — and it performs no
 * content-type validation at all. So the filename-extension fallback below is
 * the *primary* path for many real files, not an optimization.
 *
 * Both exported predicates are pure and total: no throwing, no I/O.
 */

export type PreviewKind = 'image' | 'pdf' | 'text' | 'docx' | 'unsupported';

/**
 * Header values that mean "we have no idea what this is". When the header is
 * one of these we prefer the filename extension, which at least reflects what
 * the school uploaded.
 */
const UNINFORMATIVE_MIME_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/download',
  'application/force-download',
]);

/**
 * Word OOXML — the one office type that renders inline. It is parsed into DOM
 * nodes in the page (see `components/attachments/DocxPreview.tsx`), never
 * handed to a frame. Legacy `.doc` is a different, binary format and stays
 * unsupported; `.xlsx`/`.pptx` are OOXML too but need their own renderers.
 */
export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Extension → MIME. Deliberately small: the types the viewer can render, plus
 * the common office and archive types so an unsupported file still gets named
 * honestly rather than as `application/octet-stream`.
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
  doc: 'application/msword',
  docx: DOCX_MIME_TYPE,
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
};

/** Only these render in an `<img>`. A closed allowlist — see `previewKindFor`. */
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
]);

/**
 * Only these render as text. `text/html` and `application/xml` are absent on
 * purpose: a Mashov HTML error page served with status 200 arrives labelled
 * `text/html`, and rendering it would dress a failure up as a document.
 */
const TEXT_MIME_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown']);

const SVG_MIME_TYPE = 'image/svg+xml';

/** The bare MIME type: no parameters, trimmed, lowercased. */
function bareType(value: string | null | undefined): string {
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

/** Lowercased final extension, or `''` when the name has none. */
function extensionOf(fileName: string): string {
  const base = (fileName ?? '').trim().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * The MIME type the filename extension implies, or `null` when the extension
 * is absent or unrecognized.
 *
 * Exposed so a caller can decide *before* fetching whether a file is worth
 * pulling into memory: a `.xlsx` or `.zip` can never render inline, and
 * streaming 30MB of it over mobile data only to show a "cannot display" card
 * is worse than the plain link it replaced. A `.docx` does render, so its
 * bytes are worth the transfer.
 */
export function mimeFromExtension(fileName: string): string | null {
  return EXTENSION_MIME_TYPES[extensionOf(fileName)] ?? null;
}

/**
 * The `charset` parameter of a Content-Type header, lowercased, or `null`.
 *
 * Needed because `Blob.text()` always decodes as UTF-8, and Mashov text
 * attachments from Israeli schools are frequently windows-1255 — which would
 * otherwise render as mojibake instead of Hebrew.
 */
export function charsetFromContentType(header: string | null | undefined): string | null {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(header ?? '');
  return match ? match[1].trim().toLowerCase() : null;
}

/**
 * The effective MIME type of a downloaded attachment.
 *
 * Strips any `;charset=…` parameter, trims and lowercases. Trusts the header
 * unless it is empty or uninformative, in which case it derives the type from
 * the filename extension. Falls back to `application/octet-stream` when
 * neither source says anything useful.
 */
export function resolveMimeType(
  header: string | null | undefined,
  fileName: string,
): string {
  const fromHeader = bareType(header);

  if (fromHeader && !UNINFORMATIVE_MIME_TYPES.has(fromHeader)) {
    return fromHeader;
  }

  const fromExtension = EXTENSION_MIME_TYPES[extensionOf(fileName)];
  if (fromExtension) return fromExtension;

  return fromHeader || 'application/octet-stream';
}

/**
 * How the viewer should render a file — a closed allowlist whose default
 * branch is `'unsupported'`.
 *
 * The allowlist is a security control, not a convenience. The rule it encodes
 * is about *where* bytes are rendered, not only whether they are. An SVG is a
 * script-bearing document: it is safe inside `<img>`, where the UA forces
 * secure static mode (no scripts, no external loads), and *unsafe* inside
 * `<object>`/`<embed>`/`<iframe>`, because a `blob:` URL inherits this
 * document's origin for scripting — that would be stored XSS with the
 * session cookie attached. Keeping `unsupported` as the default branch is what
 * stops a new or mislabeled type from falling through into the iframe path.
 *
 * So: never "fix" a complaint about some file not previewing by swapping the
 * tag. Add the type here, to the branch that can render it safely, or leave it
 * unsupported.
 *
 * SVG is detected from *either* source — strictest source wins — so a header
 * claiming `image/png` on `evil.svg` still routes down the image-only path
 * rather than anything laxer. That check stays first: the docx branch below
 * must not capture an `evil.svg` whose header claims the Word type.
 *
 * `docx` is the one kind that is neither a tag nor a frame: the bytes are
 * parsed to DOM nodes by `docx-preview` and appended inside a shadow root in
 * this page. That is safe *because* nothing is ever injected as an HTML
 * string, and it is why the invariant is "in-page, never framed" rather than
 * "docx cannot preview". Do not render a docx by pointing a frame at its blob.
 */
export function previewKindFor(mime: string, fileName: string): PreviewKind {
  const normalized = bareType(mime);

  if (normalized === SVG_MIME_TYPE || extensionOf(fileName) === 'svg') {
    return 'image';
  }
  if (IMAGE_MIME_TYPES.has(normalized)) return 'image';
  if (normalized === DOCX_MIME_TYPE) return 'docx';
  if (normalized === 'application/pdf') return 'pdf';
  if (TEXT_MIME_TYPES.has(normalized)) return 'text';

  return 'unsupported';
}

/**
 * Whether a resolved MIME type (or the filename) means SVG. Used to keep SVG
 * out of every code path that is not an `<img>` — including printing, where
 * the print frame must not be handed an SVG document.
 */
export function isSvg(mime: string, fileName: string): boolean {
  return bareType(mime) === SVG_MIME_TYPE || extensionOf(fileName) === 'svg';
}

/** Human-readable byte size for the viewer header, e.g. `1.4 MB`. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}
