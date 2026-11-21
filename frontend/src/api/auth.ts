import { apiFetch } from './client';
import type { AppUser, School, LoginRequest, LoginResponse } from '@/types/api';

export function getSchools(): Promise<School[]> {
  return apiFetch<School[]>('/auth/schools');
}

export function login(body: LoginRequest): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function signOut(): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/auth/session', { method: 'DELETE' });
}

export async function getMe(): Promise<AppUser> {
  const response = await apiFetch<AppUser>('/auth/me');
  // Same reason as `fetchProfile`'s `children`: a backend without the field
  // yet must render a header with no count, not `undefined ילדים`.
  return {
    ...response,
    childrenCount: typeof response.childrenCount === 'number' ? response.childrenCount : 0,
  };
}
