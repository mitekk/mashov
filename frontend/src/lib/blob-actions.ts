/**
 * Imperative blob actions: save to disk, and print.
 *
 * These are the only two places that mint an object URL outside
 * `useAttachmentBlob`. Each mints and revokes its **own** URL so that neither
 * can invalidate the URL the live preview is rendering.
 */

import { previewKindFor } from '@/lib/mime';

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
 * user to the share sheet. Accepted; the alternative is `window.open`, which
 * loses the filename everywhere else.
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PRINT_PAGE_STYLE = '@page{margin:10mm}html,body{margin:0;padding:0}';

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
 *   nothing we can render, so saving the file is the honest action.
 * - PDFs go into a hidden iframe by `src`, where the browser's own viewer
 *   handles them.
 * - Images are decoded in the *parent* document first, then rendered via
 *   `srcdoc`. The preload is what defuses the load-event race: an iframe's
 *   `load` can fire before its image has painted, and printing then yields a
 *   blank page.
 * - Text is rendered as an HTML-escaped `<pre>`.
 *
 * The frame is positioned off-screen but **rendered** (not `display:none`):
 * Chrome will not instantiate its PDF viewer inside a non-rendered frame, and
 * `print()` then silently does nothing.
 *
 * **Fallback:** if the frame never loads or `print()` throws — some browsers
 * refuse programmatic printing of a frame, and iOS Safari is unreliable here —
 * this opens the file in a new tab (`window.open`) and lets the user print it
 * from there. Printing is therefore best-effort by design; it never throws at
 * the caller.
 */
export async function printBlob(blob: Blob, mime: string, fileName: string): Promise<void> {
  const kind = previewKindFor(mime, fileName);

  if (kind === 'unsupported') {
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

  const openInNewTab = () => {
    cleanedUp = true;
    window.clearTimeout(cleanupTimer);
    window.removeEventListener('afterprint', cleanup);
    frame.remove();
    // Deliberately not revoked: the new tab still needs the URL. It dies with
    // the document.
    window.open(objectUrl, '_blank', 'noopener');
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
    } else {
      frame.srcdoc = textPrintDocument(text ?? '', fileName);
    }

    document.body.appendChild(frame);
    await loaded;

    await afterTwoAnimationFrames();

    const frameWindow = frame.contentWindow;
    if (!frameWindow) {
      openInNewTab();
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
    if (!cleanedUp) openInNewTab();
  }
}
