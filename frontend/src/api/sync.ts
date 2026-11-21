import { apiFetch } from './client';
import type { SyncRefreshResponse, SyncStatus } from '@/types/api';

/**
 * `schoolId` narrows both endpoints to one connection.
 *
 * Omitted, they cover every school the household has -- which is what the
 * first-login screen wants. Named, they are what the add-school flow wants:
 * the parent is waiting on the school they just linked, not on a re-sync of
 * the one that was already working.
 */
function schoolQuery(schoolId?: string | null): string {
  return schoolId ? `?schoolId=${encodeURIComponent(schoolId)}` : '';
}

export function triggerSyncRefresh(schoolId?: string | null): Promise<SyncRefreshResponse> {
  return apiFetch<SyncRefreshResponse>(`/sync/refresh${schoolQuery(schoolId)}`, {
    method: 'POST',
  });
}

export function getSyncStatus(schoolId?: string | null): Promise<SyncStatus> {
  return apiFetch<SyncStatus>(`/sync/status${schoolQuery(schoolId)}`);
}
