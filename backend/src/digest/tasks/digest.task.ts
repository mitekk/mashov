import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DigestService } from '../digest.service';
import { DigestRetentionService } from '../digest-retention.service';

/**
 * The hourly afternoon trigger. A shell only -- all logic lives in
 * DigestService, which is also where the 80% coverage gate applies
 * (backend/package.json's collectCoverageFrom excludes task directories).
 *
 * `timeZone` is load-bearing and new ground: no existing cron in this repo
 * passes one, and there is no TZ env anywhere, so without it the job would
 * fire 10:00-16:00 Israel time in winter and drift with DST. It is set here
 * rather than process-wide on purpose -- a global TZ would reinterpret every
 * naive Mashov timestamp already in the database.
 *
 * No catch-up run: each hour re-derives candidates from the database, so a
 * missed 15:00 is covered by 16:00. Only missing the whole window loses a day,
 * and the digest_delivery history makes that visible.
 */
@Injectable()
export class DigestTask {
  private readonly logger = new Logger(DigestTask.name);

  constructor(
    private readonly digest: DigestService,
    private readonly retention: DigestRetentionService,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 13-19 * * *', { timeZone: 'Asia/Jerusalem' })
  async run(): Promise<void> {
    if (!this.isEnabled()) return;

    // runForChild isolates per-child failures, but runAll's own preamble --
    // listing targets, resolving the school year -- is outside that guard, and
    // a rejection out of a cron callback is an unhandled rejection, which Node
    // treats as fatal by default. One transient database blip at 13:00 would
    // take the whole process down with it.
    try {
      const results = await this.digest.runAll();
      if (results.length === 0) return;

      const summary = results.reduce<Record<string, number>>((counts, result) => {
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        return counts;
      }, {});

      this.logger.log(
        `Digest run complete: ${Object.entries(summary)
          .map(([status, count]) => `${status}=${count}`)
          .join(' ')}`,
      );
    } catch (error) {
      this.logger.error(
        `Digest run failed before reaching any child: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Prunes the digest's own history daily. Not gated on DIGEST_ENABLED: rows
   * written while the feature was on must still age out after it is turned
   * off. Scheduled at 02:30 Jerusalem to sit clear of the 02:00 session
   * cleanup -- pinned to the same zone as the digest run, so the two are not
   * reasoned about in different clocks.
   */
  @Cron('30 2 * * *', { timeZone: 'Asia/Jerusalem' })
  async pruneHistory(): Promise<void> {
    try {
      await this.retention.prune();
    } catch (error) {
      this.logger.error(
        `Digest history prune failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Defaults to false: the cron stays off until it is deliberately enabled. */
  private isEnabled(): boolean {
    const raw = this.config.get<string | boolean>('DIGEST_ENABLED');
    return String(raw ?? 'false').trim().toLowerCase() === 'true';
  }
}
