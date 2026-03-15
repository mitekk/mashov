export type SyncTaskStatus = 'success' | 'failed';
export type ManualSyncStatus = 'success' | 'partial';

export interface SyncTaskSummary {
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  failedCount: number;
}

export interface SyncTaskRunResult {
  status: SyncTaskStatus;
  summary: SyncTaskSummary;
  errorMessages: string[];
}

export interface ManualSyncTaskResult extends SyncTaskRunResult {
  task: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface ManualSyncRefreshResponse {
  status: ManualSyncStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  tasks: ManualSyncTaskResult[];
}
