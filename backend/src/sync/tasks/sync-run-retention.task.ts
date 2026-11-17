import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SyncRunRetentionService } from '../sync-run-retention.service';

/**
 * Daily prune of `sync_run`.
 *
 * Scheduled at 02:45 Jerusalem: clear of the 02:00 session cleanup, the 02:30
 * digest prune, and the 03:00 history backfill, so the nightly jobs do not
 * contend for the same connections. Pinned to an explicit zone for the same
 * reason the digest crons are -- the maintenance window is reasoned about in
 * one clock, not in whatever the container's TZ happens to be.
 */
@Injectable()
export class SyncRunRetentionTask {
  private readonly logger = new Logger(SyncRunRetentionTask.name);

  constructor(private readonly retention: SyncRunRetentionService) {}

  @Cron('45 2 * * *', { timeZone: 'Asia/Jerusalem' })
  async run(): Promise<void> {
    try {
      await this.retention.prune();
    } catch (error) {
      // Never throw out of a cron: an unhandled rejection here would take the
      // scheduler down and silently stop every other sync task.
      this.logger.error(
        `sync_run prune failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
