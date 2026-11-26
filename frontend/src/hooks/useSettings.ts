import { useQuery } from '@tanstack/react-query';
import { fetchSourceHealth, fetchProfile } from '@/api/settings';
import { getSyncStatus } from '@/api/sync';

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

/**
 * The in-flight refresh, polled only while one is actually in flight.
 *
 * `enabled` is the whole point: `/more` is a page a parent can leave open, and
 * an always-on 2s poll of `/sync/status` would be a request every two seconds
 * forever for an answer that is `idle`.
 */
export function useSyncStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['sync-status'],
    queryFn: () => getSyncStatus(),
    enabled,
    refetchInterval: 2_000,
    // The answer is about right now; a cached one is worthless.
    staleTime: 0,
    gcTime: 0,
  });
}
