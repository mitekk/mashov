'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { getMe, signOut } from '@/api/auth';
import { ApiError } from '@/api/client';
import type { AppUser } from '@/types/api';

export function useMe() {
  const router = useRouter();

  return useQuery<AppUser>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await getMe();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/auth/sign-in');
        }
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useSignOut() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      queryClient.clear();
      router.push('/auth/sign-in');
    },
    onError: () => {
      // Even on error, clear cache and redirect
      queryClient.clear();
      router.push('/auth/sign-in');
    },
  });
}
