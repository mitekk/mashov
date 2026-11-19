'use client';

import React from 'react';
import { Download, FileQuestion } from 'lucide-react';
import { getTextDir } from '@/lib/rtl';

export interface UnsupportedCardProps {
  fileName: string;
  onDownload: () => void;
  /** Overrides the headline. The default says the app cannot display this kind
   * of file at all; `DocxPreview` passes a size-specific message instead, for a
   * file whose *type* is fine. */
  message?: string;
}

/**
 * Shown for anything the browser cannot safely render inline: Excel,
 * PowerPoint, legacy Word, archives — and anything whose type we could not
 * establish.
 *
 * Lifted out of `AttachmentPreview` so `DocxPreview` can reuse it for a Word
 * file that is too large to parse, without the two modules importing each
 * other.
 */
export function UnsupportedCard({ fileName, onDownload, message }: UnsupportedCardProps) {
  return (
    <div
      data-testid="attachment-preview-unsupported"
      className="card-base flex flex-col items-center justify-center gap-3 px-4 py-12 text-center"
    >
      <FileQuestion className="h-10 w-10 text-muted-foreground opacity-70" aria-hidden="true" />
      <p className="text-base font-medium text-foreground">
        {message ?? 'לא ניתן להציג את הקובץ בתוך האפליקציה'}
      </p>
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
