import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  fetchMailSummary,
  fetchConversations,
  markConversationsRead,
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

export function useConversations(filter: 'all' | 'new' | 'archived') {
  return useInfiniteQuery({
    queryKey: ['conversations', filter],
    queryFn: ({ pageParam }: { pageParam: unknown }) => fetchConversations(Number(pageParam), 20, filter),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => (
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined
    ),
    staleTime: 30_000,
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => markConversationsRead(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
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
