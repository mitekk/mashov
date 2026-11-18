'use client';

import React, { useEffect, useState } from 'react';
import { Download, FileQuestion } from 'lucide-react';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingState } from '@/components/ui/LoadingState';
import { describeAttachmentError } from '@/lib/attachment-errors';
import { getTextDir } from '@/lib/rtl';
import type { PreviewKind } from '@/lib/mime';

export interface AttachmentPreviewProps {
  fileName: string;
  /** Direct download URL — the escape hatch shown on every error, which
   * bypasses our fetch (and so the proxy timeout) entirely. */
  href: string;
  previewKind: PreviewKind;
  objectUrl: string | null;
  text: string | null;
  isTextTruncated: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  onDownload: () => void;
}

/** Shown for anything the browser cannot safely render inline: Word, Excel,
 * archives — and anything whose type we could not establish. */
function UnsupportedCard({
  fileName,
  onDownload,
}: {
  fileName: string;
  onDownload: () => void;
}) {
  return (
    <div
      data-testid="attachment-preview-unsupported"
      className="card-base flex flex-col items-center justify-center gap-3 px-4 py-12 text-center"
    >
      <FileQuestion className="h-10 w-10 text-muted-foreground opacity-70" aria-hidden="true" />
      <p className="text-base font-medium text-foreground">לא ניתן להציג את הקובץ בתוך האפליקציה</p>
      <p className="max-w-sm text-sm text-muted-foreground" dir={getTextDir(fileName)}>
        {fileName}
      </p>
      <button
        type="button"
        onClick={onDownload}
        data-testid="attachment-unsupported-download-button"
        className="tap-target mt-2 inline-flex items-center gap-2 rounded-2xl border border-primary/30 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        הורדת הקובץ
      </button>
    </div>
  );
}

/**
 * Renders the loaded bytes according to `previewKind`.
 *
 * The switch is a closed allowlist (see `lib/mime.ts`): `unsupported` is the
 * default branch, and SVG is only ever reachable through the `<img>` arm. Do
 * not add an `<object>`/`<embed>`/`<iframe>` arm for images — a `blob:` URL
 * inherits this document's origin for scripting, which would turn a
 * script-bearing SVG into stored XSS against the session.
 *
 * Note for anyone adding a Content-Security-Policy later (there is none in the
 * repo today): `img-src`, `frame-src` and `object-src` must all include
 * `blob:` or this preview dies silently.
 */
export function AttachmentPreview({
  fileName,
  href,
  previewKind,
  objectUrl,
  text,
  isTextTruncated,
  isLoading,
  isError,
  error,
  onRetry,
  onDownload,
}: AttachmentPreviewProps) {
  // An image whose header lied about its type: fall back to the same card an
  // unsupported file gets rather than showing a broken-image glyph.
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [objectUrl]);

  if (isLoading) {
    return (
      <div data-testid="attachment-loading">
        <LoadingState message="טוען את הקובץ..." className="py-16" />
      </div>
    );
  }

  if (isError) {
    const { message, canRetry } = describeAttachmentError(error);

    return (
      <div data-testid="attachment-error" className="space-y-3">
        <ErrorState message={message} onRetry={canRetry ? onRetry : undefined} />
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

  if (!objectUrl) {
    return (
      <div data-testid="attachment-error" className="space-y-3">
        <ErrorState message="לא ניתן לטעון את הקובץ" onRetry={onRetry} />
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

  if (previewKind === 'image' && !imageFailed) {
    return (
      // A blob: URL cannot go through next/image, and the bytes must stay in an
      // <img> so a script-bearing SVG is held in the UA's secure static mode.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={objectUrl}
        alt={fileName}
        data-testid="attachment-preview-image"
        onError={() => setImageFailed(true)}
        className="mx-auto max-h-full max-w-full object-contain"
      />
    );
  }

  if (previewKind === 'pdf') {
    return (
      <iframe
        src={objectUrl}
        title={fileName}
        referrerPolicy="no-referrer"
        data-testid="attachment-preview-pdf"
        className="h-full w-full border-0"
      />
    );
  }

  if (previewKind === 'text') {
    return (
      <div className="h-full w-full overflow-auto">
        <pre
          data-testid="attachment-preview-text"
          dir={getTextDir(text ?? '')}
          className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground"
        >
          {text ?? ''}
        </pre>
        {isTextTruncated && (
          <p className="px-3 pb-3 text-xs text-muted-foreground">
            הקובץ גדול מדי לתצוגה מלאה
          </p>
        )}
      </div>
    );
  }

  return <UnsupportedCard fileName={fileName} onDownload={onDownload} />;
}
