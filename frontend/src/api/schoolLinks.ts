import { apiFetch } from './client';
import type { SchoolLink, SchoolLinksResponse } from '@/types/api';

export async function fetchSchoolLinks(): Promise<SchoolLink[]> {
  const response = await apiFetch<SchoolLinksResponse>('/school-links');
  return response.data;
}

export interface CreateSchoolLinkRequest {
  semel: number;
  username: string;
  password: string;
  /**
   * The parent's explicit yes to absorbing another household's school.
   *
   * Omitted on the first submit: the backend then answers `409
   * MERGE_AVAILABLE` and the form shows what the merge would do. The confirm
   * re-sends the same credentials with this set.
   */
  confirmMerge?: boolean;
}

export function createSchoolLink(body: CreateSchoolLinkRequest): Promise<SchoolLink> {
  return apiFetch<SchoolLink>('/school-links', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteSchoolLink(id: string): Promise<void> {
  return apiFetch<void>(`/school-links/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function deleteAllSchoolLinks(): Promise<void> {
  return apiFetch<void>('/school-links', { method: 'DELETE' });
}

export interface UpdateSchoolLinkRequest {
  username?: string;
  password?: string;
}

/**
 * Re-point one school link at fresh credentials.
 *
 * The healing path for `credentialStale`: a password reset done through the
 * in-app recovery flow leaves the stored `encryptedPassword` dead, and this is
 * how a parent who is already signed in hands us the new one without signing
 * out of a household that may hold another school too.
 */
export function updateSchoolLink(
  id: string,
  body: UpdateSchoolLinkRequest,
): Promise<SchoolLink> {
  return apiFetch<SchoolLink>(`/school-links/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
