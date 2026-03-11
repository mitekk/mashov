import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchMailSummary,
  fetchConversations,
  markConversationsUnread,
  archiveConversations,
} from '@/api/mail';

export function useMailSummary() {
  return useQuery({
    queryKey: ['mail-summary'],
    queryFn: fetchMailSummary,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useConversations(
  page: number,
  unreadOnly: boolean,
) {
  return useQuery({
    queryKey: ['conversations', page, unreadOnly],
    queryFn: () => fetchConversations(page, 20, unreadOnly),
    staleTime: 30_000,
  });
}

export function useMarkUnread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => markConversationsUnread(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useArchive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => archiveConversations(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
