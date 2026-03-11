import React from 'react';
import Link from 'next/link';
import { Paperclip, MessageSquareOff } from 'lucide-react';
import type { ConversationListItem } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';

interface ConversationItemProps {
  conversation: ConversationListItem;
}

export function ConversationItem({ conversation }: ConversationItemProps) {
  const isUnread = conversation.isUnread;

  return (
    <Link
      href={`/inbox/${conversation.conversationId}`}
      data-testid={`conversation-item-${conversation.conversationId}`}
      className={cn(
        'card-base p-4 flex gap-3 items-start tap-target hover:bg-accent/30 transition-colors',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 mb-1">
          <p
            className={cn(
              'text-sm truncate flex-1',
              isUnread ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground',
            )}
          >
            {conversation.senderNamePreview}
          </p>
          <span className="text-xs text-muted-foreground flex-shrink-0 whitespace-nowrap">
            {formatRelativeHe(conversation.sendTime)}
          </span>
        </div>
        <p
          className={cn(
            'text-sm truncate',
            isUnread ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {conversation.subject}
        </p>
        <div className="flex items-center gap-2 mt-1">
          {conversation.hasAttachments && (
            <Paperclip className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          )}
          {conversation.preventReply && (
            <MessageSquareOff className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          )}
          {isUnread && (
            <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0 me-auto" />
          )}
        </div>
      </div>
    </Link>
  );
}
