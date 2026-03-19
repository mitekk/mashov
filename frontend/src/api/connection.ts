import { apiFetch } from './client';

export function deleteConnection(): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/connection', { method: 'DELETE' });
}
