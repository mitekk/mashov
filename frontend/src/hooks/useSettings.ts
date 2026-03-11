import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSourceHealth, fetchProfile } from '@/api/settings';
import { upsertReadState } from '@/api/readState';

export function useSourceHealth() {
  return useQuery({
    queryKey: ['source-health'],
    queryFn: fetchSourceHealth,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
    staleTime: 5 * 60_000,
  });
}

export function useClearAllReadState() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      upsertReadState({
        itemType: 'feed_item',
        itemId: '__clear_all__',
        isRead: false,
        isHandled: false,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['child-homework'] });
      void queryClient.invalidateQueries({ queryKey: ['child-behavior'] });
    },
  });
}
