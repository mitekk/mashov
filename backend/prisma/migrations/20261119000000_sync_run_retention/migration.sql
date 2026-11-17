-- getLatestSuccessfulRuns() filters on status and orders by endedAt; the
-- existing (source, startedAt) index cannot serve either, so that query read
-- the whole table on every freshness check.
CREATE INDEX IF NOT EXISTS "sync_run_status_endedAt_idx" ON "sync_run"("status", "endedAt");

-- One-off catch-up for the backlog that accumulated before SyncRunRetentionTask
-- existed. Mirrors the task exactly: keep the two rows per source that
-- SyncRunService reads back, whatever their age, and drop the history behind
-- them.
DELETE FROM sync_run
WHERE "startedAt" < now() - interval '30 days'
  AND id NOT IN (
    SELECT id FROM (
      SELECT DISTINCT ON (source) id
      FROM sync_run
      ORDER BY source, "startedAt" DESC
    ) latest_run
    UNION
    SELECT id FROM (
      SELECT DISTINCT ON (source) id
      FROM sync_run
      WHERE status = 'success'
      ORDER BY source, "endedAt" DESC NULLS LAST
    ) latest_success
  );
