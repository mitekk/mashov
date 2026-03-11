import { apiFetch } from './client';
import type { ReadStateRequest, ReadStateResponse } from '@/types/api';

export function upsertReadState(req: ReadStateRequest): Promise<ReadStateResponse> {
  return apiFetch<ReadStateResponse>('/read-state', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}
