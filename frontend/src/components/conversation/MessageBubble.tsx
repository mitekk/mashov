'use client';

import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { Paperclip } from 'lucide-react';
import type { ConversationMessage } from '@/types/api';
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

      {message.files.length > 0 && (
        <div className="rounded-xl border border-border/80 bg-muted/35 p-3">
          <p className="mb-2 text-xs font-medium text-foreground">קבצים מצורפים</p>
          <div className="space-y-1.5">
            {message.files.map((file) => (
              <a
                key={file.fileId}
                href={`/api/v1/mail/conversations/${encodeURIComponent(message.conversationId)}/messages/${encodeURIComponent(message.messageId)}/files/${encodeURIComponent(file.fileId)}`}
                download={file.fileName}
                className="flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Paperclip className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate underline-offset-2 hover:underline">{file.fileName}</span>
              </a>
            ))}
          </div>
        </div>
      )}
      {message.hasAttachments && message.files.length === 0 && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Paperclip className="w-3 h-3" />
          <span>יש קבצים מצורפים</span>
        </div>
      )}
    </article>
  );
}
