import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createTelegramLink,
  disconnectTelegram,
  fetchTelegramLinkState,
} from '@/api/telegram';
import type { TelegramLinkState } from '@/types/api';
import { DIGEST_RECIPIENTS_KEY } from './useDigestRecipients';

/**
 * Fast enough that the wizard feels like it noticed the START by itself, slow
 * enough not to be a request per second for the minute a parent spends in
 * Telegram.
 */
export const TELEGRAM_LINK_POLL_MS = 2_000;

export function telegramLinkQueryKey(code: string) {
  return ['telegram-link', code] as const;
}

/**
 * Stop as soon as the link has resolved either way.
 *
 * The same shape `/auth/syncing` uses against `GET /sync/status`: a
 * `refetchInterval` that reads the last answer and returns `false` once there
 * is nothing left to wait for. Without it the tab keeps polling a settled code
 * for as long as it stays open.
 */
export function telegramLinkPollInterval(
  state: TelegramLinkState | undefined,
): number | false {
  if (state?.status === 'linked' || state?.status === 'expired') return false;
  return TELEGRAM_LINK_POLL_MS;
}

/** The wizard's third step: waiting for the parent to press START. */
export function useTelegramLinkState(code: string | null) {
  return useQuery({
    queryKey: telegramLinkQueryKey(code ?? ''),
    queryFn: () => fetchTelegramLinkState(code as string),
    enabled: code !== null,
    staleTime: 0,
    refetchInterval: (query) => telegramLinkPollInterval(query.state.data),
  });
}

export function useCreateTelegramLink() {
  return useMutation({
    mutationFn: (studentGuids: string[]) => createTelegramLink(studentGuids),
  });
}

export function useDisconnectTelegram() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: disconnectTelegram,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DIGEST_RECIPIENTS_KEY });
    },
  });
}
