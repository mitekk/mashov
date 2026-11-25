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
  unarchiveConversations,
} from '@/api/mail';

/**
 * No component mounts this today -- the unread badge moved into `AppHeader`
 * and reads `useDashboard().data.summary.newConversations`, the same counter
 * `useNavItems` uses, so the two can never disagree.
 *
 * Kept rather than deleted because `'mail-summary'` is one of the shared keys
 * in `lib/query-invalidation.ts` and is invalidated from `useConversation`,
 * `useFeedBulkActions` and the four mutations below; removing the hook alone
 * would leave those pointing at nothing, and removing the key reaches into
 * feed code this change never touched. Unmounted, the `refetchInterval` below
 * costs nothing.
 */
export function useMailSummary() {
  return useQuery({
    queryKey: ['mail-summary'],
    queryFn: fetchMailSummary,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/**
 * The inbox page, optionally narrowed to one school.
 *
 * `schoolId` is part of the key, so the school filter is a different query
 * rather than a client-side pass over one fetched page -- which is what makes
 * pagination and the totals be over the filtered set. Switching chips
 * therefore refetches instead of re-filtering.
 *
 * The four mutation hooks below invalidate the bare `['conversations']`
 * prefix, which still covers every chip.
 */
export function useConversations(
  filter: 'all' | 'new' | 'archived',
  schoolId?: string,
  options?: { enabled?: boolean },
) {
  return useInfiniteQuery({
    queryKey: ['conversations', filter, schoolId ?? null],
    queryFn: ({ pageParam }: { pageParam: unknown }) => fetchConversations(Number(pageParam), 20, filter, schoolId),
    enabled: options?.enabled ?? true,
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

export function useUnarchive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => unarchiveConversations(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
