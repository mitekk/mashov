import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailModule } from '../mail/mail.module';
import { ChildrenModule } from '../children/children.module';
import { TelegramMediaSender } from '../telegram/telegram-media.sender';
import { TelegramMediaService } from './telegram-media.service';
import { UpstreamMailService } from './upstream-mail.service';
import {
  MEDIA_DELIVERY,
  MediaDelivery,
  NO_MEDIA_DELIVERY,
  NO_UPSTREAM_MAIL,
  UPSTREAM_MAIL,
  UpstreamMail,
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
 *
 * It holds two tokens, not one: MEDIA_DELIVERY for attachment bytes, and
 * UPSTREAM_MAIL for a mail conversation's detail. Both are here for the same
 * reason -- they are the Mashov-touching work the push features need, and the
 * push features may not reach Mashov themselves.
 */
@Global()
@Module({
  imports: [MailModule, ChildrenModule],
  providers: [
    TelegramMediaSender,
    TelegramMediaService,
    UpstreamMailService,
    {
      // Gated by the same switch as the media itself: both exist to put a
      // school's actual attachment in front of a parent, and a body fetched
      // for a notification nobody can receive an attachment from is work for
      // nothing.
      provide: UPSTREAM_MAIL,
      inject: [ConfigService, UpstreamMailService],
      useFactory: (config: ConfigService, upstream: UpstreamMailService): UpstreamMail =>
        isMediaEnabled(config) ? upstream : NO_UPSTREAM_MAIL,
    },
    {
      provide: MEDIA_DELIVERY,
      inject: [ConfigService, TelegramMediaService],
      useFactory: (config: ConfigService, media: TelegramMediaService): MediaDelivery =>
        isMediaEnabled(config) ? media : NO_MEDIA_DELIVERY,
    },
  ],
  exports: [MEDIA_DELIVERY, UPSTREAM_MAIL],
})
export class TelegramMediaModule {}

/** Defaults to true; only an explicit `false` turns it off. */
export function isMediaEnabled(config: ConfigService): boolean {
  const raw = config.get<string | boolean>('TELEGRAM_MEDIA_ENABLED');
  if (raw === undefined || raw === null || raw === '') return true;
  return String(raw).trim().toLowerCase() !== 'false';
}
