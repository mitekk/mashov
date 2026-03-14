import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
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

export function useConversations(unreadOnly: boolean) {
  return useInfiniteQuery({
    queryKey: ['conversations', unreadOnly],
    queryFn: ({ pageParam }) => fetchConversations(Number(pageParam), 20, unreadOnly),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => (
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined
    ),
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
