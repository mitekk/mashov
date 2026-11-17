import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How much sync history is worth keeping. Long enough to answer "when did this
 * source last break, and how often"; short enough that the table stays small.
 */
export const RETENTION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Ages out `sync_run`.
 *
 * Nothing pruned this table. The crons in ./tasks open roughly 1,600 rows a
 * day between them -- `notifications` and `mail_counts` every five minutes,
 * `homework` and `behavior` every twelve *per student* -- so it grew without
 * bound from the first deploy. Bounding the reads in `SyncRunService` fixed
 * the request-path symptom; this stops the table itself growing forever.
 */
@Injectable()
export class SyncRunRetentionService {
  private readonly logger = new Logger(SyncRunRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * MS_PER_DAY);

    // The age filter alone is not safe: a source whose rows have all aged out
    // reads back as `never_synced`, which is a louder lie than a stale
    // timestamp. So the two rows `SyncRunService` actually reads per source --
    // the latest run and the latest successful run -- are retained whatever
    // their age, and only the history behind them is deleted.
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM sync_run
      WHERE "startedAt" < ${cutoff}
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
        )
    `;

    if (deleted > 0) {
      this.logger.log(
        `Pruned ${deleted} sync_run rows older than ${RETENTION_DAYS} days.`,
      );
    }

    return deleted;
  }
}
