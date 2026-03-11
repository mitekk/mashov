import { apiFetch } from './client';
import type { SyncRefreshResponse } from '@/types/api';

export function triggerSyncRefresh(): Promise<SyncRefreshResponse> {
  return apiFetch<SyncRefreshResponse>('/sync/refresh', { method: 'POST' });
}
