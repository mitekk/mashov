import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { UpstreamMail } from './media-delivery.interface';

/**
 * Pulls a mail conversation's bodies and attachment metadata from Mashov.
 *
 * It calls `MailService.getConversationDetail`, which is the same method the
 * HTTP route uses: it asserts visibility with the `userId`, fetches upstream
 * only when no message in the thread has a renderable body, and persists what
 * it gets. So this adds no new upstream call pattern and no new authorization
 * path -- it reaches the existing one from a cron instead of from a request,
 * with the subscribing parent's own id.
 *
 * Lives here rather than in `inbox-notify/` because this module is the one
 * allowed to import `MailModule`, and through it `MashovSessionModule`. See
 * ADR-0038 and ADR-0039.
 */
@Injectable()
export class UpstreamMailService implements UpstreamMail {
  private readonly logger = new Logger(UpstreamMailService.name);

  readonly enabled = true;

  constructor(private readonly mail: MailService) {}

  async hydrateConversation(conversationId: string, userId: string): Promise<void> {
    try {
      await this.mail.getConversationDetail(conversationId, userId);
    } catch (error) {
      // Swallowed deliberately. A dead session or a 403 must cost the parent
      // the body of the notification, never the notification itself: they
      // still learn mail arrived, from whom, and about what.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not hydrate conversation ${conversationId}: ${reason}`);
    }
  }
}
