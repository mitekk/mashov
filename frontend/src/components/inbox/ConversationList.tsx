'use client';

import React from 'react';
import type { ConversationListItem, PaginationMeta } from '@/types/api';
import { ConversationItem } from './ConversationItem';

interface ConversationListProps {
  conversations: ConversationListItem[];
  pagination: PaginationMeta;
  onLoadMore: () => void;
}

export function ConversationList({ conversations, pagination, onLoadMore }: ConversationListProps) {
  return (
    <div data-testid="conversation-list" className="space-y-2">
      {conversations.map((conversation) => (
        <ConversationItem
          key={conversation.conversationId}
          conversation={conversation}
        />
      ))}
      {pagination.page < pagination.totalPages && (
        <button
          onClick={onLoadMore}
          data-testid="load-more-conversations"
          className="tap-target w-full rounded-2xl border border-primary/30 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
        >
          טען עוד
        </button>
      )}
    </div>
  );
}
