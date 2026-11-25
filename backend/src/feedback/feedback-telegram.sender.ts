import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramSender } from '../digest/senders/telegram.sender';

/**
 * Sends operator feedback notifications as a **separate bot** from the one that
 * talks to parents.
 *
 * Everything about the transport is inherited: the chunking, the `proxy: false`
 * axios instance that keeps a report off ADR-0023's Mashov-only residential
 * hop, the token-on-the-path rule that keeps it out of log lines, and the
 * redaction on the way out. The only difference is which env var holds the
 * token, so there is exactly one copy of the hard parts.
 *
 * Why a second bot at all (ADR-0045): the operator is also a parent user. With
 * one bot, pointing the feedback chat at the operator's own DM interleaves
 * every parent's bug report with that operator's own children's digests in a
 * single conversation. A distinct bot keeps the two streams visibly apart and
 * means revoking the feedback credential cannot stop a parent's digest.
 *
 * This sender is send-only. The `getUpdates` long poll that handles a parent
 * linking their account stays on TELEGRAM_BOT_TOKEN and is not duplicated --
 * nothing ever replies to this bot.
 */
@Injectable()
export class FeedbackTelegramSender extends TelegramSender {
  constructor(config: ConfigService) {
    super(config);
  }

  protected override tokenVar(): string {
    return 'FEEDBACK_TELEGRAM_BOT_TOKEN';
  }
}
