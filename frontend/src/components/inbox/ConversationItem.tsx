import React from 'react';
import Link from 'next/link';
import { Paperclip, MessageSquareOff } from 'lucide-react';
import type { ConversationListItem } from '@/types/api';
import { formatAbsoluteHe, formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';

interface ConversationItemProps {
  conversation: ConversationListItem;
  selected: boolean;
  onToggleSelect: (conversationId: string, checked: boolean) => void;
}

export function ConversationItem({
  conversation,
  selected,
  onToggleSelect,
}: ConversationItemProps) {
  const isNew = conversation.isNew;
  const safeHref = getPhase1HrefOrNull(
    conversation.conversationId
      ? `/inbox/${conversation.conversationId}`
      : null,
  );

  const content = (
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-2 mb-1">
        <p
          className={cn(
            'text-sm truncate flex-1',
            isNew ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground',
          )}
        >
          {conversation.senderNamePreview}
        </p>
        <time
          dateTime={conversation.sendTime}
          title={formatAbsoluteHe(conversation.sendTime)}
          className="text-xs text-muted-foreground flex-shrink-0 whitespace-nowrap"
        >
          {formatRelativeHe(conversation.sendTime)}
        </time>
      </div>
      <p
        className={cn(
          'text-sm truncate',
          isNew ? 'font-medium text-foreground' : 'text-muted-foreground',
        )}
      >
        {conversation.subject}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {formatAbsoluteHe(conversation.sendTime)}
      </p>
      <div className="flex items-center gap-2 mt-1">
        {conversation.hasAttachments && (
          <Paperclip className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        )}
        {conversation.preventReply && (
          <MessageSquareOff className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        )}
        {isNew && (
          <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0 me-auto" />
        )}
      </div>
      {!safeHref && (
        <p className="text-[11px] text-muted-foreground mt-1">
          קישור זה אינו זמין בשלב 1
        </p>
      )}
    </div>
  );

  const className =
    'card-base p-4 flex gap-3 items-start tap-target transition-colors';

  if (!safeHref) {
    return (
      <div
        data-testid={`conversation-item-disabled-${conversation.conversationId}`}
        aria-disabled
        className={cn(className, 'opacity-70 cursor-not-allowed')}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onToggleSelect(conversation.conversationId, event.target.checked)}
          data-testid={`conversation-select-${conversation.conversationId}`}
          className="mt-1 h-4 w-4 flex-shrink-0 rounded border-border text-primary focus:ring-primary"
          aria-label="בחר שיחה"
        />
        {content}
      </div>
    );
  }

  return (
    <div className={className}>
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onToggleSelect(conversation.conversationId, event.target.checked)}
        data-testid={`conversation-select-${conversation.conversationId}`}
        className="mt-1 h-4 w-4 flex-shrink-0 rounded border-border text-primary focus:ring-primary"
        aria-label="בחר שיחה"
      />
      <Link
        href={safeHref}
        data-testid={`conversation-item-${conversation.conversationId}`}
        className="min-w-0 flex-1 rounded-xl p-1 transition-colors hover:bg-accent/30"
      >
        {content}
      </Link>
    </div>
  );
}
