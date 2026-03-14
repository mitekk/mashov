import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MailBulkActionResponse } from '@/types/api';
import {
  fetchConversationDetail,
  markConversationsRead,
  markConversationsUnread,
} from '@/api/mail';

export function useConversation(conversationId: string) {
  return useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => fetchConversationDetail(conversationId),
    staleTime: 0, // Always fresh — body may be lazily fetched
    enabled: Boolean(conversationId),
  });
}

export function useMarkConversationNew() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, isNew }: { conversationId: string; isNew: boolean }) => {
      if (!isNew) {
        return markConversationsRead([conversationId]);
      }
      return markConversationsUnread([conversationId]);
    },
    onSuccess: (_data: MailBulkActionResponse, variables: { conversationId: string; isNew: boolean }) => {
      void queryClient.invalidateQueries({
        queryKey: ['conversation', variables.conversationId],
      });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
    },
  });
}

export function useMarkConversationRead() {
  return useMutation({
    mutationFn: (conversationId: string) => markConversationsRead([conversationId]),
  });
}
