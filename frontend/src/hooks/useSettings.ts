import { useQuery } from '@tanstack/react-query';
import { fetchSourceHealth, fetchProfile } from '@/api/settings';

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
