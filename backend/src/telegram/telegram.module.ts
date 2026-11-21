import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DigestModule } from '../digest/digest.module';
import { TelegramClient } from './telegram.client';
import { TelegramLinkService } from './telegram-link.service';
import { TelegramPollerService } from './telegram-poller.service';

/**
 * The inbound Telegram path: a parent presses START and we learn their chat id.
 *
 * It imports `DigestModule` for `TelegramSender`, which the confirmation
 * message goes out through -- one direction only, so there is no circular edge
 * to forwardRef around. `telegram-http.ts` is a plain factory rather than a
 * provider, which is why the sender could adopt it without a module dependency
 * running the other way.
 *
 * Like `DigestModule`, it deliberately imports nothing that builds a Mashov
 * axios client. HTTPS_PROXY is process-wide and ADR-0023's egress hop is a
 * single residential tinyproxy meant only for Mashov; a parent's chat id must
 * never traverse it.
 */
@Module({
  imports: [PrismaModule, DigestModule],
  providers: [TelegramClient, TelegramLinkService, TelegramPollerService],
  exports: [TelegramLinkService],
})
export class TelegramModule {}
