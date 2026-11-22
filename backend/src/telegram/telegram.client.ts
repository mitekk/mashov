import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import {
  TelegramEnvelope,
  botPath,
  createTelegramHttp,
  describeTelegramError,
  redact,
} from './telegram-http';

interface TelegramBot {
  username?: string;
}

/** How much longer than the long poll the HTTP read is allowed to take. */
const READ_SLACK_SECONDS = 15;

/**
 * The inbound half of the Bot API: who we are, and what people have said to us.
 *
 * Outbound sending stays in `TelegramSender`, which the digest already owns.
 * Both go through `telegram-http.ts`, so neither can traverse ADR-0023's
 * Mashov-only residential proxy and neither puts the token in a log line.
 */
@Injectable()
export class TelegramClient {
  private readonly http: AxiosInstance;

  /**
   * Cached for the process lifetime. The username cannot change without the
   * token changing, and a token change is a redeploy.
   */
  private botUsername: string | null = null;

  constructor(private readonly config: ConfigService) {
    this.http = createTelegramHttp();
  }

  hasToken(): boolean {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    return typeof token === 'string' && token.trim().length > 0;
  }

  /**
   * The bot's @username, for building `https://t.me/<bot>?start=<code>`.
   *
   * Read from Telegram rather than configured: `NEXT_PUBLIC_*` is inlined at
   * build time by Next, so a username set as a runtime compose variable would
   * never reach the browser -- and asking the bot itself means the username can
   * never drift from whatever token is actually deployed.
   */
  async getMe(): Promise<string> {
    if (this.botUsername) return this.botUsername;

    const bot = await this.call<TelegramBot>('getMe');
    const username = bot?.username?.trim();
    if (!username) {
      throw new Error('Telegram returned a bot with no username; cannot build a deep link.');
    }

    // Assigned only on success: caching a failure would turn a transient
    // outage into a permanently broken wizard until the next redeploy.
    this.botUsername = username;
    return username;
  }

  /**
   * One long poll. `offset` is `lastUpdateId + 1`, and passing it is what
   * confirms the updates before it: Telegram then drops them, and keeps
   * anything unconfirmed for 24 hours. That retention is why the poller can
   * hold its offset in memory -- a restart is handed back whatever it had not
   * confirmed, and reprocessing is safe by construction in the link service.
   */
  async getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<unknown[]> {
    const updates = await this.call<unknown[]>(
      'getUpdates',
      {
        ...(offset === undefined ? {} : { offset }),
        timeout: timeoutSeconds,
      },
      // The transport must outlast the long poll it is carrying: a 15s read
      // timeout would abort every 30s poll before Telegram answered, turning
      // this into a hot reconnect loop.
      (timeoutSeconds + READ_SLACK_SECONDS) * 1000,
    );
    return updates ?? [];
  }

  /** One Bot API GET, with the token on the path and off every error. */
  protected async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T | undefined> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token.trim().length === 0) {
      throw new Error(`Cannot call Telegram ${method}: TELEGRAM_BOT_TOKEN is not configured.`);
    }

    let data: TelegramEnvelope<T> | undefined;
    try {
      const response = await this.http.get<TelegramEnvelope<T>>(botPath(token, method), {
        params,
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      });
      data = response.data;
    } catch (error) {
      throw new Error(
        `Telegram ${method} failed: ${redact(describeTelegramError(error), token)}`,
      );
    }

    if (data?.ok !== true) {
      const described =
        data?.description && data.description.length > 0
          ? data.description
          : 'Telegram reported ok=false';
      throw new Error(`Telegram ${method} failed: ${redact(described, token)}`);
    }

    return data.result;
  }
}
