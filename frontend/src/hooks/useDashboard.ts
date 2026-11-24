import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchDashboard } from '@/api/dashboard';
import { triggerSyncRefresh } from '@/api/sync';

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: fetchDashboard,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/**
 * Shared by every sync trigger, so they report ONE pending state.
 *
 * The app header mounts two at once at every width -- the inline
 * `RefreshButton` and the overflow menu's sync item, with Tailwind hiding one.
 * Two bare `useMutation`s keep separate `isPending` flags, so a parent who
 * fires a sync from the phone menu and then crosses `sm` (rotation, or a
 * tablet) sees the inline button idle and enabled mid-sync, one tap from a
 * second concurrent household sync.
 */
const SYNC_REFRESH_KEY = ['sync-refresh'] as const;

export function useSyncRefresh() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationKey: SYNC_REFRESH_KEY,
    // Explicitly argument-free: the header's refresh button refreshes the
    // whole household, and passing the function directly would make its
    // optional schoolId a required mutate() variable.
    mutationFn: () => triggerSyncRefresh(),
    onSuccess: async () => {
      // Keep mutation pending until active queries have been invalidated and refetched.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['feed'] }),
        queryClient.invalidateQueries({ queryKey: ['source-health'] }),
      ]);
    },
  });

  // A sync started by ANY consumer, not only this instance's own.
  const running = useIsMutating({ mutationKey: SYNC_REFRESH_KEY }) > 0;

  const { mutate, mutateAsync, reset, isError, error } = mutation;

  // Deliberately narrow, and NOT `{ ...mutation, isPending: running }`:
  // spreading would leave `status`, `isIdle`, `isSuccess` and friends
  // describing only this instance, so a consumer writing the
  // equivalent-looking `status === 'pending'` would silently get the
  // un-shared answer and bring the double-sync back. What is not exposed
  // cannot disagree.
  //
  // Memoised so the object is safe to put in a dependency array; without it
  // every consumer's effects would re-run on each render of this hook.
  return useMemo(
    () => ({ mutate, mutateAsync, reset, isError, error, isPending: running }),
    [mutate, mutateAsync, reset, isError, error, running],
  );
}
