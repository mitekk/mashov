import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailModule } from '../mail/mail.module';
import { ChildrenModule } from '../children/children.module';
import { TelegramMediaSender } from '../telegram/telegram-media.sender';
import { TelegramMediaService } from './telegram-media.service';
import {
  MEDIA_DELIVERY,
  MediaDelivery,
  NO_MEDIA_DELIVERY,
} from './media-delivery.interface';

/**
 * Mashov attachment bytes -> Telegram, bound behind one token.
 *
 * `@Global()` is the point, not a shortcut. The consumers are DigestService
 * and InboxNotifyService, and neither of their modules may import this one:
 * it imports MailModule and ChildrenModule, and through them
 * MashovSessionModule, which DigestModule's docblock and ADR-0026 forbid in
 * that graph. A global provider lets the token reach them without an import
 * edge, so `digest.module.spec.ts`'s assertion that the Mashov client is
 * unreachable from DigestModule keeps holding -- and the consumers inject the
 * token `@Optional()`, so a module compiled on its own falls back to the
 * no-op rather than failing to resolve.
 *
 * TELEGRAM_MEDIA_ENABLED defaults to TRUE, unlike the digest's own switches:
 * the feature was asked for, and DIGEST_ENABLED / INBOX_NOTIFY_ENABLED still
 * gate everything that would call it.
 */
@Global()
@Module({
  imports: [MailModule, ChildrenModule],
  providers: [
    TelegramMediaSender,
    TelegramMediaService,
    {
      provide: MEDIA_DELIVERY,
      inject: [ConfigService, TelegramMediaService],
      useFactory: (config: ConfigService, media: TelegramMediaService): MediaDelivery =>
        isMediaEnabled(config) ? media : NO_MEDIA_DELIVERY,
    },
  ],
  exports: [MEDIA_DELIVERY],
})
export class TelegramMediaModule {}

/** Defaults to true; only an explicit `false` turns it off. */
export function isMediaEnabled(config: ConfigService): boolean {
  const raw = config.get<string | boolean>('TELEGRAM_MEDIA_ENABLED');
  if (raw === undefined || raw === null || raw === '') return true;
  return String(raw).trim().toLowerCase() !== 'false';
}
