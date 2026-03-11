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
    <div data-testid="conversation-list" className="space-y-2 px-4">
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
          className="w-full py-2.5 text-sm text-primary font-medium border border-primary/30 rounded-xl hover:bg-primary/5 transition-colors tap-target"
        >
          טען עוד
        </button>
      )}
    </div>
  );
}
