import { apiFetch } from './client';
import type { SourceHealthResponse, ParentProfile } from '@/types/api';

type LegacySourceHealth = Array<{
  source: string;
  status: 'success' | 'failed' | string;
  lastRun?: string;
  errorMessage?: string | null;
}>;

export async function fetchSourceHealth(): Promise<SourceHealthResponse> {
  const response = await apiFetch<SourceHealthResponse | LegacySourceHealth>(
    '/settings/source-health',
  );

  if (Array.isArray(response)) {
    return {
      sources: response.map((item) => ({
        source: item.source,
        status: item.status === 'failed' ? 'failed' : 'fresh',
        lastSuccessAt: item.status === 'failed' ? null : item.lastRun ?? null,
        lastAttemptAt: item.lastRun ?? null,
        lastErrorMessage: item.errorMessage ?? null,
        fetchedCount: null,
        staleThresholdMinutes: 0,
      })),
      overallState: response.some((item) => item.status === 'failed')
        ? 'degraded'
        : 'fresh',
      lastFullSyncAt:
        response
          .map((item) => item.lastRun)
          .filter((value): value is string => typeof value === 'string')
          .sort()
          .at(-1) ?? null,
    };
  }

  return {
    sources: Array.isArray(response.sources) ? response.sources : [],
    overallState: response.overallState,
    lastFullSyncAt: response.lastFullSyncAt,
  };
}

export function fetchProfile(): Promise<ParentProfile> {
  return apiFetch<ParentProfile>('/settings/profile');
}
