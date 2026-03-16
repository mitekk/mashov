import { apiFetch } from './client';
import type { SyncRefreshResponse, SyncStatus } from '@/types/api';

export function triggerSyncRefresh(): Promise<SyncRefreshResponse> {
  return apiFetch<SyncRefreshResponse>('/sync/refresh', { method: 'POST' });
}

export function getSyncStatus(): Promise<SyncStatus> {
  return apiFetch<SyncStatus>('/sync/status');
}
