'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingState } from '@/components/ui/LoadingState';
import { UnsupportedCard } from '@/components/attachments/UnsupportedCard';
import { isSafeDocxHref, sanitizeDocxCss, uncompressedDocxSize } from '@/lib/docx-safety';
import type { DocxRender } from '@/lib/blob-actions';

// Re-exported so the viewer side of this feature has one import to reach for.
// The type itself lives next to `printBlob`, its only other consumer.
export type { DocxRender };

/**
 * Transfer ceiling. Nothing upstream tells us a file's size before the
 * transfer — `Attachment` carries only `{ fileId, fileName }` and the Next
 * proxy strips `content-length` — so this can only be checked once the bytes
 * are in hand. It bounds the download and the serialized copy the print path
 * keeps, and nothing else: see the next constant.
 */
export const DOCX_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Parse ceiling, on the *uncompressed* `word/document.xml`.
 *
 * The byte cap above says nothing about the work: `document.xml` is deflated
 * XML, so a 50KB file can carry 15MB of markup and a few hundred thousand runs,
 * and every run becomes a DOM node on the main thread. Measured on this
 * library: ~15MB of XML is ~400k nodes and well over a second of frozen UI, so
 * 8MB is about where a parent on a phone would still forgive us. A real Word
 * letter's `document.xml` is rarely past 2MB; images live in their own entries
 * and cost nothing here, which is why this measures one entry and not the
 * archive.
 */
export const DOCX_DOCUMENT_XML_LIMIT_BYTES = 8 * 1024 * 1024;

const DOCUMENT_XML_ENTRY = 'word/document.xml';

export interface DocxPreviewProps {
  blob: Blob;
  fileName: string;
  /** Direct download URL, for the error state's escape hatch. */
  href: string;
  onDownload: () => void;
  /** Called with the serialized render on success, and with `null` on every
   * other outcome — including the moment a new blob arrives, so next/prev can
   * never print the document the user has already navigated away from. */
  onRendered: (render: DocxRender | null) => void;
}

type Status = 'loading' | 'ready' | 'error' | 'too-large';

/**
 * Renders a `.docx` inline.
 *
 * **Why not a frame.** `docx-preview` parses the OOXML and builds DOM nodes; no
 * HTML string is ever injected. That closes *markup* injection and is what lets
 * `lib/mime.ts` list `docx` in its allowlist at all — a `blob:` URL in an
 * `<iframe>`/`<object>` inherits this document's origin, so pointing a frame at
 * the bytes would hand a crafted file the session cookie. Do not "simplify"
 * this into a frame.
 *
 * **But DOM construction is not a sanitizer.** It closes markup injection, not
 * attribute injection: the library assigns `a.href` straight from the
 * document's relationships with no scheme check, so a `javascript:` target
 * would be one tap from running script in this origin — and the stylesheet it
 * generates interpolates document-controlled font names, so a crafted one
 * injects whole CSS rules. Both are scrubbed below, after the render and before
 * anything is shown or serialized. See `lib/docx-safety.ts` for why each
 * guard is shaped the way it is.
 *
 * **Why a shadow root.** Tailwind preflight plus the global
 * `* { @apply border-border; box-sizing: border-box }` in `globals.css` would
 * otherwise repaint every border in the document with the app's theme color,
 * change table width math, and strip heading sizes and list markers. An open
 * shadow root is a hard boundary for those `*` selectors, and `docx-preview`
 * puts its own stylesheet inside it. (The library wants two `HTMLElement`
 * containers, not a `ShadowRoot`, so the two hosts below live *inside* the
 * shadow root — which also keeps the body markup and the stylesheet separable
 * for the print path.) Playwright's `getByTestId` and text engines pierce open
 * shadow roots, so the e2e assertions still reach the rendered text.
 *
 * The container div stays mounted in every state, including the failure ones.
 * That is not cosmetic: the effect needs the host to exist, and swapping it out
 * for a card would null the ref and leave the next document unable to render.
 */
export function DocxPreview({
  blob,
  fileName,
  href,
  onDownload,
  onRendered,
}: DocxPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  // Kept in a ref so the effect does not re-run — and re-parse — when the
  // viewer re-renders with a new callback identity.
  const onRenderedRef = useRef(onRendered);
  useEffect(() => {
    onRenderedRef.current = onRendered;
  }, [onRendered]);

  useEffect(() => {
    // Any previous render belongs to a previous file.
    onRenderedRef.current(null);
    setStatus('loading');

    let cancelled = false;

    const render = async () => {
      if (blob.size > DOCX_PREVIEW_LIMIT_BYTES) {
        setStatus('too-large');
        return;
      }

      const bytes = await blob.arrayBuffer();
      if (cancelled) return;

      // `null` means the bytes are not a readable zip — let the parser produce
      // the error, which is the one that knows why.
      const documentXmlSize = uncompressedDocxSize(bytes, DOCUMENT_XML_ENTRY);
      if (documentXmlSize !== null && documentXmlSize > DOCX_DOCUMENT_XML_LIMIT_BYTES) {
        setStatus('too-large');
        return;
      }

      // First dynamic import in the app: the parser is ~190KB, and only a
      // parent who actually opens a Word file should pay for it.
      const { renderAsync } = await import('docx-preview');
      if (cancelled) return;

      const container = containerRef.current;
      if (!container) return;

      // A shadow root belongs to the element it was attached to; if React ever
      // hands us a different host, the cached one points at a detached node.
      if (shadowRef.current && shadowRef.current.host !== container) {
        shadowRef.current = null;
      }
      const shadow =
        shadowRef.current ??
        (shadowRef.current = container.attachShadow({ mode: 'open' }));

      // Rebuilt per render so a previous document leaves nothing behind.
      shadow.replaceChildren();
      const styleHost = document.createElement('div');
      const bodyHost = document.createElement('div');
      shadow.append(styleHost, bodyHost);

      await renderAsync(blob, bodyHost, styleHost, {
        // Alt chunks carry arbitrary HTML *inside* the docx — the library
        // renders them into an iframe with `srcdoc`. Off; the default is on.
        renderAltChunks: false,
        // Embedded images as data URLs rather than blob: URLs this component
        // would then have to revoke by hand.
        useBase64URL: true,
        // Tracked changes and comments are editing furniture, not the document
        // the school sent.
        renderChanges: false,
        renderComments: false,
        // Drops the gray page-gutter chrome from the printout.
        hideWrapperOnPrint: true,
      });

      if (cancelled) return;

      // Scrub before anything is visible, and before the serialization the
      // print path takes — so the print frame inherits clean markup rather
      // than relying only on its own sanitizer.
      for (const anchor of Array.from(bodyHost.querySelectorAll('a'))) {
        if (!isSafeDocxHref(anchor.getAttribute('href') ?? '')) {
          anchor.removeAttribute('href');
          continue;
        }
        // A legitimate link still must not navigate the viewer away, or leak
        // this app's URL as a Referer.
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      }

      const styles = Array.from(styleHost.querySelectorAll('style'));
      for (const style of styles) {
        style.textContent = sanitizeDocxCss(style.textContent ?? '');
      }

      const css = styles.map((style) => style.textContent ?? '').join('\n');

      onRenderedRef.current({ html: bodyHost.innerHTML, css });
      setStatus('ready');
    };

    void render().catch(() => {
      // A corrupt or mislabeled file — the common case being bytes that are
      // not a zip at all.
      if (cancelled) return;
      onRenderedRef.current(null);
      setStatus('error');
    });

    return () => {
      // The dynamic import or the parse can resolve after Radix has dropped
      // `Dialog.Content`, or after next/prev moved to another file.
      cancelled = true;
    };
  }, [blob]);

  useEffect(() => {
    // Unmount is the one case the per-blob cleanup above cannot report: the
    // caller must not keep a render for a viewer that is gone.
    return () => onRenderedRef.current(null);
  }, []);

  return (
    <>
      {status === 'loading' && (
        <div data-testid="attachment-docx-loading">
          <LoadingState message="מכין את המסמך..." className="py-16" />
        </div>
      )}

      {status === 'too-large' && (
        <UnsupportedCard
          fileName={fileName}
          onDownload={onDownload}
          message="הקובץ גדול מדי לתצוגה בתוך האפליקציה"
        />
      )}

      {status === 'error' && (
        <div data-testid="attachment-error" className="space-y-3">
          <ErrorState message="לא ניתן להציג את הקובץ" />
          <p className="text-center text-sm">
            <a
              href={href}
              download={fileName}
              data-testid="attachment-error-fallback-link"
              className="text-primary underline underline-offset-2"
            >
              הורדת הקובץ ישירות
            </a>
          </p>
        </div>
      )}

      {/* Always mounted, in every state: the effect needs this host to exist,
          and unmounting it on failure would strand every later document. */}
      <div
        ref={containerRef}
        data-testid="attachment-preview-docx"
        hidden={status !== 'ready'}
        className="h-full w-full overflow-auto"
      />
    </>
  );
}
