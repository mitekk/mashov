'use client';

import React, { useState } from 'react';
import { Paperclip } from 'lucide-react';
import { AttachmentViewer } from '@/components/attachments/AttachmentViewer';
import type { Attachment } from '@/types/api';

export interface AttachmentListProps {
  files: Attachment[];
  buildHref: (fileId: string) => string;
  /** Render the "there are attachments, we just don't have their metadata yet"
   * note. Reachable when upstream hydration is incomplete. */
  emptyHint?: boolean;
  title?: string;
}

/**
 * The shared "קבצים מצורפים" box used by mail, homework and behavior details.
 *
 * Each row stays a real `<a href download>` with an intercepting click rather
 * than becoming a `<button>`. That keeps cmd/ctrl-click and "Save link as"
 * working, gives keyboard semantics for free, degrades with JS off to exactly
 * the previous behaviour, and leaves the existing e2e `href` assertions —
 * which are what actually guard URL construction — passing unchanged.
 */
export function AttachmentList({
  files,
  buildHref,
  emptyHint = false,
  title = 'קבצים מצורפים',
}: AttachmentListProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (files.length === 0) {
    if (!emptyHint) return null;

    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Paperclip className="h-3 w-3" aria-hidden="true" />
        <span>יש קבצים מצורפים</span>
      </div>
    );
  }

  return (
    <>
      <div
        data-testid="attachment-list"
        className="rounded-xl border border-border/80 bg-muted/35 p-3"
      >
        <p className="mb-2 text-xs font-medium text-foreground">{title}</p>
        <div className="space-y-1.5">
          {files.map((file, fileIndex) => (
            <a
              key={file.fileId}
              href={buildHref(file.fileId)}
              download={file.fileName}
              data-testid={`attachment-item-${file.fileId}`}
              onClick={(event) => {
                // Leave every modified click, and any non-primary button, to
                // the browser: open-in-new-tab and "Save link as" keep working.
                if (
                  event.defaultPrevented ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey ||
                  event.button !== 0
                ) {
                  return;
                }
                event.preventDefault();
                setOpenIndex(fileIndex);
              }}
              className="flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Paperclip className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              <span className="truncate underline-offset-2 hover:underline">{file.fileName}</span>
            </a>
          ))}
        </div>
      </div>

      {openIndex !== null && (
        <AttachmentViewer
          files={files}
          index={openIndex}
          onIndexChange={setOpenIndex}
          buildHref={buildHref}
          open
          onOpenChange={(next) => {
            if (!next) setOpenIndex(null);
          }}
        />
      )}
    </>
  );
}
