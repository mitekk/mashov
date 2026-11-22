import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import {
  TelegramEnvelope,
  botPath,
  createTelegramHttp,
  describeTelegramError,
  redact,
} from '../../telegram/telegram-http';
import { DigestSender } from './digest-sender.interface';

/**
 * Delivers a digest through the Telegram Bot API.
 *
 * The axios instance comes from `telegram-http.ts`, which owns the two
 * load-bearing decisions -- `proxy: false` so a parent's message never crosses
 * ADR-0023's Mashov-only residential hop, and the token on the request path
 * rather than in `baseURL` so it stays out of `config.url` in every log line.
 * One place owns them because the link poller makes the same calls.
 */
@Injectable()
export class TelegramSender implements DigestSender {
  readonly channel = 'telegram';

  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = createTelegramHttp();
  }

  async send(address: string, text: string): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token.trim().length === 0) {
      throw new Error('Cannot send a digest: TELEGRAM_BOT_TOKEN is not configured.');
    }

    // The transport call and the ok-check are deliberately not in the same
    // try: a `throw` for ok=false inside it would be caught by its own catch
    // and re-described as a transport failure, losing Telegram's reason.
    let data: TelegramEnvelope<unknown> | undefined;
    try {
      const response = await this.http.post<TelegramEnvelope<unknown>>(
        botPath(token, 'sendMessage'),
        {
          chat_id: address,
          // No parse_mode on purpose: Telegram rejects an entire message whose
          // text contains unbalanced markup, and teacher remarks routinely
          // contain * _ - . and !. Hebrew renders right-to-left without it.
          text,
          disable_web_page_preview: true,
        },
      );
      data = response.data;
    } catch (error) {
      throw new Error(`Telegram send failed: ${redact(describeTelegramError(error), token)}`);
    }

    if (data?.ok !== true) {
      const described =
        data?.description && data.description.length > 0
          ? data.description
          : 'Telegram reported ok=false';
      throw new Error(`Telegram send failed: ${redact(described, token)}`);
    }
  }
}
