import { apiFetch } from './client';
import type {
  DigestRecipient,
  DigestRecipientResponse,
  DigestRecipientsResponse,
} from '@/types/api';

/** The route's maximum page size, which is also the whole list in practice. */
const RECIPIENT_PAGE_LIMIT = 100;

/**
 * Every subscription the caller owns, or just one child's.
 *
 * `studentGuid` is omitted by the `/more` card, whose question is "what am I
 * subscribed to". Names, classes and school labels are joined client-side from
 * the already-cached children list rather than by a server-side join.
 *
 * `limit` is sent explicitly because the route's own default page is 20: the
 * card is not a paged list, and a silent truncation would show a child as
 * unsubscribed while messages about them keep arriving.
 */
export async function fetchDigestRecipients(studentGuid?: string): Promise<DigestRecipient[]> {
  const params = new URLSearchParams({ limit: String(RECIPIENT_PAGE_LIMIT) });
  if (studentGuid) params.set('studentGuid', studentGuid);
  const response = await apiFetch<DigestRecipientsResponse>(`/digest/recipients?${params}`);
  return response.data;
}

export async function updateDigestRecipient(
  id: string,
  body: { enabled?: boolean; displayName?: string },
): Promise<DigestRecipient> {
  const response = await apiFetch<DigestRecipientResponse>(
    `/digest/recipients/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return response.data;
}
