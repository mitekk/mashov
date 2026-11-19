'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingState } from '@/components/ui/LoadingState';
import { UnsupportedCard } from '@/components/attachments/UnsupportedCard';
import type { DocxRender } from '@/lib/blob-actions';

// Re-exported so the viewer side of this feature has one import to reach for.
// The type itself lives next to `printBlob`, its only other consumer.
export type { DocxRender };

/**
 * Above this, the file is refused rather than parsed. Nothing upstream tells us
 * a file's size before the transfer — `Attachment` carries only
 * `{ fileId, fileName }` and the Next proxy strips `content-length` — so this
 * check can only happen once the bytes are already in hand. Parsing a 30MB
 * docx happens on the main thread and would freeze the viewer; the text path's
 * own ceiling is 512KB, for the same reason.
 */
export const DOCX_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;

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
 * HTML string is ever injected. That is what makes in-page rendering safe here,
 * and it is the reason `lib/mime.ts` can list `docx` in its allowlist at all.
 * A `blob:` URL in an `<iframe>`/`<object>` inherits this document's origin, so
 * pointing a frame at the bytes would hand a crafted file the session cookie.
 * Do not "simplify" this into a frame.
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

    if (blob.size > DOCX_PREVIEW_LIMIT_BYTES) {
      setStatus('too-large');
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    setStatus('loading');

    let cancelled = false;

    const render = async () => {
      // First dynamic import in the app: the parser is ~1MB, and only a parent
      // who actually opens a Word file should pay for it.
      const { renderAsync } = await import('docx-preview');
      if (cancelled) return;

      const shadow =
        shadowRef.current ??
        (shadowRef.current = container.attachShadow({ mode: 'open' }));

      // Rebuilt per render so a previous document leaves nothing behind.
      shadow.replaceChildren();
      const styleHost = document.createElement('div');
      const bodyHost = document.createElement('div');
      shadow.append(styleHost, bodyHost);

      await renderAsync(blob, bodyHost, styleHost, {
        // Alt chunks carry arbitrary HTML *inside* the docx and are the one
        // real injection vector in this library. Off; the default is on.
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

      const css = Array.from(styleHost.querySelectorAll('style'))
        .map((style) => style.textContent ?? '')
        .join('\n');

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

  if (status === 'too-large') {
    return (
      <UnsupportedCard
        fileName={fileName}
        onDownload={onDownload}
        message="הקובץ גדול מדי לתצוגה בתוך האפליקציה"
      />
    );
  }

  if (status === 'error') {
    return (
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
    );
  }

  return (
    <>
      {status === 'loading' && (
        <div data-testid="attachment-docx-loading">
          <LoadingState message="מכין את המסמך..." className="py-16" />
        </div>
      )}
      {/* Always mounted: the effect needs the host element to exist before the
          parse starts, so this cannot be rendered only once it is ready. */}
      <div
        ref={containerRef}
        data-testid="attachment-preview-docx"
        hidden={status !== 'ready'}
        className="h-full w-full overflow-auto"
      />
    </>
  );
}
