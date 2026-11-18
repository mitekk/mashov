import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

export function useSyncRefresh() {
  const queryClient = useQueryClient();
  return useMutation({
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
}
