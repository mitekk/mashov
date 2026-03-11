import { useQuery } from '@tanstack/react-query';
import { fetchChildren } from '@/api/children';

export function useChildren() {
  return useQuery({
    queryKey: ['children'],
    queryFn: fetchChildren,
    staleTime: 60_000,
  });
}
