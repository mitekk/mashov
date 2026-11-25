import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { FeedbackNotifierService } from './feedback-notifier.service';
import { FeedbackTelegramSender } from './feedback-telegram.sender';
import { FeedbackNotifyTask } from './tasks/feedback-notify.task';

/**
 * The parent feedback write path, plus the outbox that delivers each new row
 * to the operator's Telegram chat.
 *
 * `FeedbackService` is unchanged by the notifier: the cron-only outbox means
 * `create()` has no hook point, no floating promise, and no added latency on
 * the request a parent is waiting for.
 *
 * It provides its own sender, `FeedbackTelegramSender`, which subclasses
 * DigestModule's `TelegramSender` to swap one value -- the env var holding the
 * bot token -- so operator notifications go out as a different bot from the
 * one that talks to parents (ADR-0045). Subclassing a class it imports rather
 * than consuming a provider it injects means this module needs no `imports`
 * entry for DigestModule at all, while the Bot API chunking, the redaction and
 * the permanent-failure classification still have exactly one implementation.
 *
 * Like DigestModule and InboxNotifyModule it must import nothing that builds a
 * Mashov axios client: ADR-0023's egress hop is a single residential tinyproxy
 * with a 10s AbortSignal and no retry-on-abort, meant only for Mashov, and
 * HTTPS_PROXY is process-wide. A report's text -- which carries a parent's
 * email and their own words -- must never traverse it. Dropping the
 * DigestModule import makes that bound easier to hold, not harder.
 * See ADR-0038 and ADR-0045.
 */
@Module({
  imports: [PrismaModule],
  controllers: [FeedbackController],
  providers: [
    FeedbackService,
    FeedbackTelegramSender,
    FeedbackNotifierService,
    FeedbackNotifyTask,
  ],
})
export class FeedbackModule {}
