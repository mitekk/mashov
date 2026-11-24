import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DigestModule } from '../digest/digest.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { FeedbackNotifierService } from './feedback-notifier.service';
import { FeedbackNotifyTask } from './tasks/feedback-notify.task';

/**
 * The parent feedback write path, plus the outbox that delivers each new row
 * to the operator's Telegram chat.
 *
 * `FeedbackService` is unchanged by the notifier: the cron-only outbox means
 * `create()` has no hook point, no floating promise, and no added latency on
 * the request a parent is waiting for.
 *
 * It imports DigestModule for TelegramSender only -- and so inherits the Bot
 * API chunking and the permanent-failure classification rather than growing a
 * second copy of either. Like DigestModule and InboxNotifyModule it must
 * import nothing that builds a Mashov axios client: ADR-0023's egress hop is a
 * single residential tinyproxy with a 10s AbortSignal and no retry-on-abort,
 * meant only for Mashov, and HTTPS_PROXY is process-wide. A report's text --
 * which carries a parent's email and their own words -- must never traverse
 * it. See ADR-0038 and ADR-0045.
 */
@Module({
  imports: [PrismaModule, DigestModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, FeedbackNotifierService, FeedbackNotifyTask],
})
export class FeedbackModule {}
