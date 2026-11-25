import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FeedbackNotifierService } from '../feedback-notifier.service';

/**
 * The two-minute trigger for the feedback delivery outbox. A shell only -- all
 * logic lives in FeedbackNotifierService, which is also where the 80% coverage
 * gate applies (backend/package.json's collectCoverageFrom excludes task
 * directories).
 *
 * Two minutes because the whole point of the feature is that a parent's report
 * reaches a human promptly, and the tick is cheap: one indexed query against a
 * table bounded at ten rows per household per hour, with no upstream HTTP and
 * no model call when there is nothing to send.
 *
 * The expression is a literal. A `@Cron` expression is evaluated when the
 * decorator runs, so it cannot come from ConfigService. `timeZone` is set for
 * the same reason DigestTask and InboxNotifyTask set it -- the process is
 * pinned to UTC and nothing here should be reasoned about in two clocks --
 * though a fixed-interval expression does not actually depend on it.
 *
 * Gated on having somewhere to deliver to -- FEEDBACK_TELEGRAM_BOT_TOKEN and
 * FEEDBACK_TELEGRAM_CHAT_ID -- with no second `*_ENABLED` var. That diverges
 * from DIGEST_ENABLED / INBOX_NOTIFY_ENABLED deliberately: those two vars are
 * not flags but the two halves of one address, and a third switch only creates
 * a state where delivery is silently off while fully configured. The check
 * itself lives on the notifier so the env var names appear in one place. See
 * the doc comment on FeedbackNotifierService and ADR-0045.
 */
@Injectable()
export class FeedbackNotifyTask {
  private readonly logger = new Logger(FeedbackNotifyTask.name);

  constructor(private readonly notifier: FeedbackNotifierService) {}

  @Cron('*/2 * * * *', { timeZone: 'Asia/Jerusalem' })
  async run(): Promise<void> {
    // Checked here as well as inside deliverPending so an unconfigured stack
    // does no work at all -- not even the one query -- and writes no line per
    // tick.
    if (!this.notifier.isConfigured()) return;

    try {
      const results = await this.notifier.deliverPending();
      if (results.length === 0) return;

      const summary = results.reduce<Record<string, number>>((counts, result) => {
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        return counts;
      }, {});

      this.logger.log(
        `Feedback notification run complete: ${Object.entries(summary)
          .map(([status, count]) => `${status}=${count}`)
          .join(' ')}`,
      );
    } catch (error) {
      this.logger.error(
        `Feedback notification run failed before reaching any row: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
