'use client';

import React, { useCallback, useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, Printer, X } from 'lucide-react';
import { AttachmentPreview } from '@/components/attachments/AttachmentPreview';
import { useAttachmentBlob } from '@/hooks/useAttachmentBlob';
import { printBlob, triggerBlobDownload, triggerHrefDownload } from '@/lib/blob-actions';
import { formatFileSize, isSvg } from '@/lib/mime';
import { getTextDir } from '@/lib/rtl';
import type { Attachment } from '@/types/api';

export interface AttachmentViewerProps {
  files: Attachment[];
  index: number;
  onIndexChange: (index: number) => void;
  buildHref: (fileId: string) => string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Full-screen in-app viewer for one item's attachments.
 *
 * Radix supplies the focus trap, scroll lock, Escape handling and
 * `aria-modal`. Everything added on top is RTL and Hebrew: the title carries
 * the file's own direction (names arrive in both Hebrew and Latin), every icon
 * button has a Hebrew `aria-label`, and navigation reads right-to-left —
 * **ArrowLeft advances, ArrowRight goes back**, matching the on-screen
 * chevrons.
 */
export function AttachmentViewer({
  files,
  index,
  onIndexChange,
  buildHref,
  open,
  onOpenChange,
}: AttachmentViewerProps) {
  const safeIndex = files.length === 0 ? 0 : Math.min(Math.max(index, 0), files.length - 1);
  const file = files[safeIndex];
  const href = useMemo(
    () => (file ? buildHref(file.fileId) : ''),
    [buildHref, file],
  );

  const {
    blob,
    mimeType,
    previewKind,
    objectUrl,
    text,
    isTextTruncated,
    isLoading,
    isError,
    error,
    refetch,
  } = useAttachmentBlob(href, file?.fileName ?? '', { enabled: open && Boolean(file) });

  const hasPrevious = safeIndex > 0;
  const hasNext = safeIndex < files.length - 1;

  const goPrevious = useCallback(() => {
    if (safeIndex > 0) onIndexChange(safeIndex - 1);
  }, [onIndexChange, safeIndex]);

  const goNext = useCallback(() => {
    if (safeIndex < files.length - 1) onIndexChange(safeIndex + 1);
  }, [files.length, onIndexChange, safeIndex]);

  const handleDownload = useCallback(() => {
    if (!file) return;

    // No bytes in hand (the fetch was skipped for a type that can never
    // preview), or bytes the browser must not be given a chance to render:
    // either way, let the endpoint's `Content-Disposition` do the work.
    if (!blob || isSvg(mimeType, file.fileName)) {
      triggerHrefDownload(href, file.fileName);
      return;
    }

    triggerBlobDownload(blob, file.fileName);
  }, [blob, file, href, mimeType]);

  const handlePrint = useCallback(() => {
    if (!blob || !file) return;
    void printBlob(blob, mimeType, file.fileName, href);
  }, [blob, file, href, mimeType]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Don't steal the arrow keys from the browser's PDF viewer, which uses
      // them to scroll the document.
      if (document.activeElement?.tagName === 'IFRAME') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goNext();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goPrevious();
      }
    },
    [goNext, goPrevious],
  );

  if (!file) return null;

  const sizeLabel = blob ? formatFileSize(blob.size) : '';
  // SVG is viewable but not printable: see `printBlob`. Offering the button
  // and then quietly downloading instead would be the worse answer.
  const canPrint =
    Boolean(blob) && previewKind !== 'unsupported' && !isSvg(mimeType, file.fileName);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]" />
        <Dialog.Content
          data-testid="attachment-viewer"
          lang="he-IL"
          dir="rtl"
          onKeyDown={handleKeyDown}
          className="fixed inset-0 z-50 flex flex-col bg-background"
        >
          <header className="flex items-start gap-2 border-b border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <Dialog.Title
                data-testid="attachment-viewer-title"
                dir={getTextDir(file.fileName)}
                className="truncate text-sm font-semibold text-foreground"
              >
                {file.fileName}
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                תצוגה מקדימה של הקובץ המצורף, עם אפשרויות הורדה והדפסה
              </Dialog.Description>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {files.length > 1 && (
                  <span data-testid="attachment-viewer-counter" aria-live="polite">
                    {safeIndex + 1} / {files.length}
                  </span>
                )}
                {sizeLabel && <span>{sizeLabel}</span>}
              </div>
            </div>

            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={handleDownload}
                aria-label="הורדה"
                data-testid="attachment-download-button"
                className="icon-button h-9 w-9"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
              </button>
              {canPrint && (
                <button
                  type="button"
                  onClick={handlePrint}
                  aria-label="הדפסה"
                  data-testid="attachment-print-button"
                  className="icon-button h-9 w-9"
                >
                  <Printer className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="סגור"
                  data-testid="attachment-close-button"
                  className="icon-button h-9 w-9"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            <AttachmentPreview
              fileName={file.fileName}
              href={href}
              previewKind={previewKind}
              objectUrl={objectUrl}
              text={text}
              isTextTruncated={isTextTruncated}
              isLoading={isLoading}
              isError={isError}
              error={error}
              onRetry={refetch}
              onDownload={handleDownload}
            />
          </div>

          {files.length > 1 && (
            // dir="rtl": the first child sits on the right. Previous is the
            // right-hand chevron, next the left-hand one.
            <nav className="flex items-center justify-between border-t border-border px-3 py-2">
              <button
                type="button"
                onClick={goPrevious}
                disabled={!hasPrevious}
                aria-label="הקובץ הקודם"
                data-testid="attachment-prev-button"
                className="icon-button h-9 w-9 disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={!hasNext}
                aria-label="הקובץ הבא"
                data-testid="attachment-next-button"
                className="icon-button h-9 w-9 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
            </nav>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
