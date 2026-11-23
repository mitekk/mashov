import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InboxNotifyService } from '../inbox-notify.service';

/**
 * The ten-minute trigger for inbox notifications. A shell only -- all logic
 * lives in InboxNotifyService, which is also where the 80% coverage gate
 * applies (backend/package.json's collectCoverageFrom excludes task
 * directories).
 *
 * The cadence is a compromise: mail from a school is news a parent wants
 * promptly, and a cron is cheap because the run is four narrow local queries
 * with no upstream HTTP and no model call. Quiet hours are checked inside the
 * service rather than expressed here -- a `@Cron` expression is evaluated when
 * the decorator runs, so it cannot come from ConfigService, and mail arriving
 * at 02:00 must be held over rather than dropped.
 *
 * `timeZone` is set for the same reason DigestTask sets it: the process is
 * pinned to UTC, and the quiet-hours check reads the same zone, so the two are
 * not reasoned about in different clocks.
 */
@Injectable()
export class InboxNotifyTask {
  private readonly logger = new Logger(InboxNotifyTask.name);

  constructor(
    private readonly notifier: InboxNotifyService,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/10 * * * *', { timeZone: 'Asia/Jerusalem' })
  async run(): Promise<void> {
    if (!this.isEnabled()) return;

    // A rejection out of a cron callback is an unhandled rejection, which Node
    // treats as fatal by default. The service isolates per chat, but its own
    // preamble -- listing subscriptions -- is outside that guard, so one
    // database blip would otherwise take the process down.
    try {
      const results = await this.notifier.notifyAll();
      if (results.length === 0) return;

      const summary = results.reduce<Record<string, number>>((counts, result) => {
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        return counts;
      }, {});

      this.logger.log(
        `Inbox notification run complete: ${Object.entries(summary)
          .map(([status, count]) => `${status}=${count}`)
          .join(' ')}`,
      );
    } catch (error) {
      this.logger.error(
        `Inbox notification run failed before reaching any chat: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Defaults to false: the cron stays off until it is deliberately enabled. */
  private isEnabled(): boolean {
    const raw = this.config.get<string | boolean>('INBOX_NOTIFY_ENABLED');
    return String(raw ?? 'false').trim().toLowerCase() === 'true';
  }
}
