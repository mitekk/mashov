export type SyncTaskStatus = 'success' | 'failed';
export type ManualSyncStatus = 'success' | 'partial';

export interface SyncExecutionContext {
  connectionId?: string;
  /**
   * Fetch and stamp this year instead of the connection's current year. One
   * value feeds both the login year and the row stamp: a Mashov session is
   * scoped to the year in its login body, so a stamp that disagrees with the
   * fetch writes one year's data under another year's label, under a perfectly
   * valid unique key and with no error anywhere.
   */
  schoolYear?: number;
  /**
   * Prefixes `syncRun.source` so a backfill cannot mask live-source health.
   * `FreshnessService` treats `homework:<anything>` as a fresh `homework`
   * success, so a historical run must not be named that way.
   */
  sourcePrefix?: string;
}

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
