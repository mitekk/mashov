import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DigestModule } from '../digest/digest.module';
import { InboxNotifyService } from './inbox-notify.service';
import { InboxNotifyTask } from './tasks/inbox-notify.task';

/**
 * Household mail -> Telegram, as its own message.
 *
 * Its own module rather than a part of DigestModule, deliberately: mail is
 * household-scoped rather than per child, it needs no model call, it runs on a
 * ten-minute cadence rather than hourly in the afternoon, and the requirement
 * was explicitly a separate message. Folding it in would have meant a
 * DigestService that sometimes is not about a child.
 *
 * It imports DigestModule for TelegramSender only -- and so inherits the Bot
 * API chunking and the permanent-failure classification rather than growing a
 * second copy of either. Like DigestModule it imports nothing that builds a
 * Mashov axios client: ADR-0023's egress hop is a residential tinyproxy meant
 * only for Mashov, HTTPS_PROXY is process-wide, and a parent's mail must never
 * traverse it. See ADR-0037.
 */
@Module({
  imports: [PrismaModule, DigestModule],
  providers: [InboxNotifyService, InboxNotifyTask],
  exports: [InboxNotifyService],
})
export class InboxNotifyModule {}
