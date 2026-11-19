/**
 * Imperative blob actions: save to disk, and print.
 *
 * These are the only two places that mint an object URL outside
 * `useAttachmentBlob`. Each mints and revokes its **own** URL so that neither
 * can invalidate the URL the live preview is rendering.
 */

import DOMPurify from 'dompurify';

import { isSvg, previewKindFor } from '@/lib/mime';

/**
 * A finished `.docx` render, serialized by `DocxPreview`.
 *
 * Declared here rather than in the component because the print path is its
 * only other consumer, and a lib must not import a component.
 */
export interface DocxRender {
  /** The rendered body markup, straight from the shadow root. Unsanitized. */
  html: string;
  /** The stylesheet `docx-preview` generated for this document. */
  css: string;
}

const PRINT_FRAME_LOAD_TIMEOUT_MS = 15_000;

/**
 * `print()` is non-blocking in Safari, so `afterprint` is not guaranteed to
 * arrive. This bounds how long a print frame can linger before we tear it
 * down regardless.
 */
const PRINT_CLEANUP_FALLBACK_MS = 60_000;

/**
 * Save a blob to disk under `fileName`.
 *
 * Known gap: iOS Safari does not reliably honour `download` on a synthetic
 * anchor pointing at a `blob:` URL — it may open the file instead, leaving the
 * user to the share sheet. Accepted for inert types; a scriptable one must go
 * through {@link triggerHrefDownload} instead, where the server's
 * `Content-Disposition` settles it.
 */
export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoking synchronously can cancel the download in some browsers; one task
  // later the navigation has been handed off.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

/**
 * Save a file by navigating to its server URL instead of a blob URL.
 *
 * For types the browser must never get a chance to *render* — an SVG above all.
 * The endpoint sends `Content-Disposition: attachment`, so the browser saves
 * it; a `blob:` URL cannot promise that, and a rendered blob document runs the
 * SVG's scripts in this app's origin with the session cookie attached.
 */
export function triggerHrefDownload(href: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PRINT_PAGE_STYLE = '@page{margin:10mm}html,body{margin:0;padding:0}';

/**
 * Sanitize a docx render for the print frame.
 *
 * Why this exists at all: the frame below is built with `srcdoc` and
 * deliberately carries no `sandbox` attribute (see the note in `printBlob`), so
 * its document is same-origin with this page. Anything scriptable that reached
 * `srcdoc` would run with the session cookie attached. The in-page preview does
 * not need this — `docx-preview` builds DOM nodes there and never parses HTML —
 * but serializing that DOM and re-parsing it as a document is exactly the step
 * that would turn a crafted attribute back into live markup.
 *
 * Why not `sanitizeRichTextHtml` from `lib/richText.ts`: its config forbids
 * `style`, `class`, `width`, and the `span`, `table`/`tr`/`td` and `img` tags —
 * which is every single thing a docx render is made of. Reusing it would
 * produce a wall of unstyled text. It is tuned for untrusted *mail bodies*,
 * where presentation is noise; here the presentation is the document.
 *
 * So this config is permissive about presentation and relies on DOMPurify's
 * defaults for the parts that matter: `<script>`, `on*` handlers and
 * `javascript:` URLs are dropped, while `data:` images (what `useBase64URL`
 * produces) are kept.
 */
function sanitizeDocxHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'base', 'form'],
    FORBID_ATTR: ['srcdoc'],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Neutralize the generated stylesheet before it goes inside `<style>`.
 *
 * The CSS is machine-generated, but it interpolates names taken from the
 * document — a style or class name carrying `</style>` would close the element
 * early and everything after it would be parsed as markup. There is no legal
 * `<` in CSS here, so dropping it costs nothing.
 */
function sanitizeDocxCss(css: string): string {
  return css.replace(/</g, '');
}

function docxPrintDocument(render: DocxRender, fileName: string): string {
  return (
    '<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
    `<title>${escapeHtml(fileName)}</title>` +
    `<style>${PRINT_PAGE_STYLE}</style>` +
    `<style>${sanitizeDocxCss(render.css)}</style>` +
    `</head><body>${sanitizeDocxHtml(render.html)}</body></html>`
  );
}

function imagePrintDocument(objectUrl: string, fileName: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(fileName)}</title>` +
    `<style>${PRINT_PAGE_STYLE}img{max-width:100%;height:auto;display:block}</style>` +
    `</head><body><img src="${objectUrl}" alt="${escapeHtml(fileName)}"></body></html>`
  );
}

function textPrintDocument(text: string, fileName: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(fileName)}</title>` +
    `<style>${PRINT_PAGE_STYLE}pre{white-space:pre-wrap;word-break:break-word;` +
    'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}</style>' +
    `</head><body><pre>${escapeHtml(text)}</pre></body></html>`
  );
}

/** Two frames, so the frame has had a layout pass — Chrome prints a blank page
 * if `print()` is called before one. */
function afterTwoAnimationFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Print one attachment.
 *
 * - Unsupported types delegate to {@link triggerBlobDownload} — there is
 *   nothing we can render, so saving the file is the honest action. SVG takes
 *   the same exit for a different reason: it renders safely in the preview's
 *   `<img>`, but every path in here would have to put the document somewhere it
 *   could execute. Callers should not offer Print for an SVG at all; this is
 *   the backstop.
 * - PDFs go into a hidden iframe by `src`, where the browser's own viewer
 *   handles them.
 * - Images are decoded in the *parent* document first, then rendered via
 *   `srcdoc`. The preload is what defuses the load-event race: an iframe's
 *   `load` can fire before its image has painted, and printing then yields a
 *   blank page.
 * - Text is rendered as an HTML-escaped `<pre>`.
 * - A docx prints the render the preview already produced, re-sanitized on the
 *   way into `srcdoc`. Without that render in hand — the parse has not
 *   finished, or the caller never had one — it saves the file instead, which
 *   beats printing a document that is not the one on screen.
 *
 * The frame is positioned off-screen but **rendered** (not `display:none`):
 * Chrome will not instantiate its PDF viewer inside a non-rendered frame, and
 * `print()` then silently does nothing.
 *
 * **Fallback:** if the frame never loads or `print()` throws — some browsers
 * refuse programmatic printing of a frame, and iOS Safari is unreliable here —
 * this saves the file instead, so the button is never silent, and the user can
 * print it from their own viewer. It deliberately does *not* `window.open` the
 * blob URL: a top-level `blob:` navigation yields a document in this app's
 * origin, which for a script-bearing file is stored XSS against the session.
 * (A popup blocker would eat it regardless — by then we are several awaits
 * past the click's user-gesture window.) Printing is best-effort by design; it
 * never throws at the caller.
 *
 * `fallbackHref` is the file's server URL, used when the bytes themselves must
 * not be handed to the browser as a blob.
 *
 * `docxRender` is the serialized output of `DocxPreview`, required for — and
 * only used by — `kind === 'docx'`.
 */
export async function printBlob(
  blob: Blob,
  mime: string,
  fileName: string,
  fallbackHref: string,
  docxRender?: DocxRender | null,
): Promise<void> {
  const kind = previewKindFor(mime, fileName);

  if (isSvg(mime, fileName)) {
    triggerHrefDownload(fallbackHref, fileName);
    return;
  }

  // Every kind this function cannot render, plus a docx whose parse has not
  // produced a render, exits here. `AttachmentViewer` keeps the button hidden
  // in these cases; this is the backstop, and the reason the branch selection
  // below names every kind explicitly instead of ending in an `else`.
  if (kind === 'unsupported' || (kind === 'docx' && !docxRender)) {
    triggerBlobDownload(blob, fileName);
    return;
  }

  const objectUrl = URL.createObjectURL(blob);

  const frame = document.createElement('iframe');
  frame.setAttribute('data-testid', 'attachment-print-frame');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = fileName;
  frame.referrerPolicy = 'no-referrer';
  // Off-screen but rendered — see the note above. No `sandbox`: without
  // `allow-scripts` the PDF viewers (pdfium, pdf.js) are both disabled, and
  // `allow-scripts` on a blob URL is the one actively unsafe combination.
  frame.style.cssText =
    'position:fixed;top:0;inset-inline-end:-10000px;width:1px;height:1px;opacity:0;border:0;';

  let cleanedUp = false;
  let cleanupTimer = 0;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    window.clearTimeout(cleanupTimer);
    window.removeEventListener('afterprint', cleanup);
    frame.remove();
    URL.revokeObjectURL(objectUrl);
  };

  /** Give up on printing and save the file, so the action is never silent. */
  const fallBackToDownload = () => {
    cleanup();
    triggerBlobDownload(blob, fileName);
  };

  try {
    // Decode image bytes before the frame exists, so the frame's `load` event
    // cannot beat the paint.
    if (kind === 'image') {
      const preload = new Image();
      preload.src = objectUrl;
      try {
        await preload.decode();
      } catch {
        // A decode failure here is not fatal — the frame may still render it.
      }
    }

    const text = kind === 'text' ? await blob.text() : null;

    // Listeners first, then content, then insertion: an iframe inserted with
    // no content fires a `load` for `about:blank`, which would resolve the
    // wait below against the wrong document.
    const loaded = new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.addEventListener('error', () => reject(new Error('print frame failed')), {
        once: true,
      });
      window.setTimeout(
        () => reject(new Error('print frame load timed out')),
        PRINT_FRAME_LOAD_TIMEOUT_MS,
      );
    });

    if (kind === 'pdf') {
      frame.src = objectUrl;
    } else if (kind === 'image') {
      frame.srcdoc = imagePrintDocument(objectUrl, fileName);
    } else if (kind === 'docx' && docxRender) {
      frame.srcdoc = docxPrintDocument(docxRender, fileName);
    } else if (kind === 'text') {
      frame.srcdoc = textPrintDocument(text ?? '', fileName);
    } else {
      // Unreachable: the guard above exits for every other kind. Saving the
      // file is the honest answer if a new kind ever gets here.
      fallBackToDownload();
      return;
    }

    document.body.appendChild(frame);
    await loaded;

    await afterTwoAnimationFrames();

    const frameWindow = frame.contentWindow;
    if (!frameWindow) {
      fallBackToDownload();
      return;
    }

    // `srcdoc` keeps the frame same-origin, so for images this is readable as
    // a second check that the bytes actually rendered.
    if (kind === 'image') {
      const image = frameWindow.document.images[0];
      if (image && !image.complete) {
        await new Promise<void>((resolve) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => resolve(), { once: true });
          window.setTimeout(resolve, 2_000);
        });
      }
    }

    frameWindow.addEventListener('afterprint', cleanup, { once: true });
    window.addEventListener('afterprint', cleanup, { once: true });
    cleanupTimer = window.setTimeout(cleanup, PRINT_CLEANUP_FALLBACK_MS);

    frameWindow.focus();
    frameWindow.print();
  } catch {
    if (!cleanedUp) fallBackToDownload();
  }
}
