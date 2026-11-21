import { apiFetch } from './client';
import type {
  TelegramLink,
  TelegramLinkResponse,
  TelegramLinkState,
  TelegramLinkStateResponse,
} from '@/types/api';

/**
 * Mints the one-time code the parent's deep link carries.
 *
 * The chosen children go with it: the START arrives at the backend with no
 * browser attached, so the choice cannot stay in component state.
 */
export async function createTelegramLink(studentGuids: string[]): Promise<TelegramLink> {
  const response = await apiFetch<TelegramLinkResponse>('/digest/telegram-links', {
    method: 'POST',
    body: JSON.stringify({ studentGuids }),
  });
  return response.data;
}

/** Where one link stands. Polled by the wizard while it waits for the START. */
export async function fetchTelegramLinkState(code: string): Promise<TelegramLinkState> {
  const response = await apiFetch<TelegramLinkStateResponse>(
    `/digest/telegram-links/${encodeURIComponent(code)}`,
  );
  return response.data;
}

/** Stops Telegram updates entirely and forgets the chat id. */
export function disconnectTelegram(): Promise<void> {
  return apiFetch<void>('/digest/telegram-links', { method: 'DELETE' });
}
