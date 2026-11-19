'use client';

import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';
import type { ConversationMessage } from '@/types/api';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { mailAttachmentHref } from '@/lib/attachment-routes';
import { formatRelativeHe, formatAbsoluteHe } from '@/lib/dates';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: ConversationMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const rawHtml =
    typeof message.bodyHtmlSanitized === 'string' && message.bodyHtmlSanitized.trim().length > 0
      ? message.bodyHtmlSanitized
      : typeof message.bodyTextPreview === 'string' && message.bodyTextPreview.trim().length > 0
        ? `<p>${message.bodyTextPreview}</p>`
        : '<p>תוכן ההודעה אינו זמין בשלב 1.</p>';

  const sanitizedHtml = useMemo(
    () => DOMPurify.sanitize(rawHtml),
    [rawHtml],
  );

  // Memoized: this identity feeds the viewer's query key.
  const buildAttachmentHref = useMemo(
    () => mailAttachmentHref(message.conversationId, message.messageId),
    [message.conversationId, message.messageId],
  );

  const recipientNames = message.recipients
    .slice(0, 3)
    .map((r) => r.displayName)
    .join(', ');
  const moreRecipients =
    message.recipients.length > 3 ? ` +${message.recipients.length - 3}` : '';

  return (
    <article
      data-testid={`message-${message.messageId}`}
      className="card-base p-4 space-y-3"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {message.senderName}
          </p>
          {message.recipients.length > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              אל: {recipientNames}
              {moreRecipients}
            </p>
          )}
        </div>
        <time
          dateTime={message.sendTime}
          title={formatAbsoluteHe(message.sendTime)}
          className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0"
        >
          {formatRelativeHe(message.sendTime)}
        </time>
      </div>

      {/* Body */}
      <div
        className={cn(
          'prose prose-sm max-w-none text-foreground rtl',
          '[&_a]:text-primary [&_a]:underline',
          '[&_*]:max-w-full',
        )}
        dir="rtl"
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />

      <AttachmentList
        files={message.files}
        buildHref={buildAttachmentHref}
        emptyHint={message.hasAttachments}
      />
    </article>
  );
}
