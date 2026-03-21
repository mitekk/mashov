'use client';

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { sanitizeRichTextHtml } from '@/lib/richText';
import { cn } from '@/lib/utils';

export interface RichTextContentProps {
  html: string;
  collapsible?: boolean;
  previewLines?: number;
  className?: string;
  contentTestId?: string;
  previewTestId?: string;
  toggleTestId?: string;
}

export function RichTextContent({
  html,
  collapsible = false,
  previewLines = 2,
  className,
  contentTestId,
  previewTestId,
  toggleTestId,
}: RichTextContentProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { sanitizedHtml, plainTextPreview } = useMemo(
    () => sanitizeRichTextHtml(html),
    [html],
  );

  if (!collapsible) {
    return (
      <div
        data-testid={contentTestId}
        className={cn('prose-rtl text-sm text-foreground', className)}
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    );
  }

  const safePreviewLines = Number.isFinite(previewLines) ? Math.max(1, Math.floor(previewLines)) : 2;

  return (
    <div className={cn('space-y-2.5', className)}>
      {!isExpanded && (
        <p
          data-testid={previewTestId}
          className="rich-text-preview text-sm text-muted-foreground"
          style={{ WebkitLineClamp: safePreviewLines }}
        >
          {plainTextPreview}
        </p>
      )}

      <button
        type="button"
        data-testid={toggleTestId}
        onClick={() => setIsExpanded((value) => !value)}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
        aria-expanded={isExpanded}
      >
        {isExpanded ? (
          <>
            <ChevronUp className="h-3.5 w-3.5" />
            הסתר פירוט
          </>
        ) : (
          <>
            <ChevronDown className="h-3.5 w-3.5" />
            הצג פירוט
          </>
        )}
      </button>

      {isExpanded && (
        <div
          data-testid={contentTestId}
          className="prose-rtl text-sm text-foreground"
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      )}
    </div>
  );
}
