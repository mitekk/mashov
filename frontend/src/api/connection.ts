import { apiFetch } from './client';

export interface UpdateConnectionBody {
  username?: string;
  password?: string;
}

export function updateConnection(body: UpdateConnectionBody): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/connection', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function deleteConnection(): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/connection', { method: 'DELETE' });
}
