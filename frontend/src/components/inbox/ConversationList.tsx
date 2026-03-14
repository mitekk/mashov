'use client';

import React from 'react';
import type { ConversationListItem } from '@/types/api';
import { ConversationItem } from './ConversationItem';

interface ConversationListProps {
  conversations: ConversationListItem[];
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  selectedConversationIds: string[];
  onToggleSelect: (conversationId: string, checked: boolean) => void;
}

export function ConversationList({
  conversations,
  hasMore,
  isLoadingMore,
  onLoadMore,
  selectedConversationIds,
  onToggleSelect,
}: ConversationListProps) {
  return (
    <div data-testid="conversation-list" className="space-y-2">
      {conversations.map((conversation) => (
        <ConversationItem
          key={conversation.conversationId}
          conversation={conversation}
          selected={selectedConversationIds.includes(conversation.conversationId)}
          onToggleSelect={onToggleSelect}
        />
      ))}
      {hasMore && (
        <button
          onClick={onLoadMore}
          data-testid="load-more-conversations"
          disabled={isLoadingMore}
          className="tap-target w-full rounded-2xl border border-primary/30 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
        >
          {isLoadingMore ? 'טוען...' : 'טען עוד'}
        </button>
      )}
    </div>
  );
}
