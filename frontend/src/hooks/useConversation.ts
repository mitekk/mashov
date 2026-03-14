import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchConversationDetail } from '@/api/mail';
import { upsertReadState } from '@/api/readState';
import type { ReadStateRequest } from '@/types/api';

export function useConversation(conversationId: string) {
  return useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => fetchConversationDetail(conversationId),
    staleTime: 0, // Always fresh — body may be lazily fetched
    enabled: Boolean(conversationId),
  });
}

export function useMarkConversationHandled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: ReadStateRequest) => upsertReadState(req),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['conversation', variables.itemId],
      });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
    },
  });
}

export function useMarkConversationRead() {
  return useMutation({
    mutationFn: (req: ReadStateRequest) => upsertReadState(req),
  });
}
