export type SyncTaskStatus = 'success' | 'failed';
/**
 * `failed` is the school that threw: `POST /sync/refresh` aggregates one
 * `refreshAll` per connection, and a connection whose refresh never returned
 * has no `partial` to report.
 */
export type ManualSyncStatus = 'success' | 'partial' | 'failed';

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
  /**
   * One entry per task **per school**, concatenated.
   *
   * `task` is therefore NOT unique in the aggregated `POST /sync/refresh`
   * response: a two-school household carries two `homework` entries. It is
   * unique in what one `SyncService.refreshAll` returns, which is where this
   * type is also used. A reader that wants one row per task must group by
   * school, not `find` by name -- `tasks.find((t) => t.task === 'homework')`
   * and `key={task.task}` both silently keep one school and drop the other.
   *
   * Kept as a flat list rather than gaining a `schoolId`: the single-school
   * response is byte-identical to the pre-aggregation one, which is what lets
   * the six e2e MOCK constants and old clients keep working.
   */
  tasks: ManualSyncTaskResult[];
}
