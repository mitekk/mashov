import { apiFetch } from './client';
import type {
  DigestRecipient,
  DigestRecipientResponse,
  DigestRecipientsResponse,
} from '@/types/api';

/**
 * Every subscription the caller owns, or just one child's.
 *
 * `studentGuid` is omitted by the `/more` card, whose question is "what am I
 * subscribed to". Names, classes and school labels are joined client-side from
 * the already-cached children list rather than by a server-side join.
 */
export async function fetchDigestRecipients(studentGuid?: string): Promise<DigestRecipient[]> {
  const query = studentGuid ? `?studentGuid=${encodeURIComponent(studentGuid)}` : '';
  const response = await apiFetch<DigestRecipientsResponse>(`/digest/recipients${query}`);
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
