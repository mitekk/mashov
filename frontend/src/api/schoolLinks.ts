import { apiFetch } from './client';
import type { SchoolLink, SchoolLinksResponse } from '@/types/api';

export async function fetchSchoolLinks(): Promise<SchoolLink[]> {
  const response = await apiFetch<SchoolLinksResponse>('/school-links');
  return response.data;
}
