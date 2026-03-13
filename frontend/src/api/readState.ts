import { apiFetch } from './client';
import type { ReadStateRequest, ReadStateResponse } from '@/types/api';

export function upsertReadState(req: ReadStateRequest): Promise<ReadStateResponse> {
  return apiFetch<ReadStateResponse>('/read-state', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export function clearAllReadState(): Promise<{ deleted: number }> {
  return apiFetch<{ deleted: number }>('/read-state', {
    method: 'POST',
    body: JSON.stringify({ clearAll: true }),
  });
}
