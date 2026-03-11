import { apiFetch } from './client';
import type { SourceHealthResponse, ParentProfile } from '@/types/api';

export function fetchSourceHealth(): Promise<SourceHealthResponse> {
  return apiFetch<SourceHealthResponse>('/settings/source-health');
}

export function fetchProfile(): Promise<ParentProfile> {
  return apiFetch<ParentProfile>('/settings/profile');
}
