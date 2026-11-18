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
