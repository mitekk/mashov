import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchDigestRecipients, updateDigestRecipient } from '@/api/digest';

/**
 * Deliberately NOT household-scoped.
 *
 * `invalidateHouseholdScopedQueries` exists for data that changes when a
 * school is connected or a household merges. A Telegram subscription is neither
 * -- it is one parent's own delivery preference -- so recipient mutations
 * invalidate this key and nothing else.
 */
export const DIGEST_RECIPIENTS_KEY = ['digest', 'recipients'] as const;

/** Every subscription this parent owns, across all their children. */
export function useDigestRecipients() {
  return useQuery({
    queryKey: DIGEST_RECIPIENTS_KEY,
    queryFn: () => fetchDigestRecipients(),
    staleTime: 60_000,
  });
}

/** The per-child on/off toggle in `/more`. */
export function useUpdateDigestRecipient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateDigestRecipient(id, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DIGEST_RECIPIENTS_KEY });
    },
  });
}
