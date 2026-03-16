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

export function getMe(): Promise<AppUser> {
  return apiFetch<AppUser>('/auth/me');
}
