import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { DigestSender } from './digest-sender.interface';

const TELEGRAM_API_ROOT = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 15_000;

interface TelegramResponse {
  ok: boolean;
  description?: string;
}

/**
 * Delivers a digest through the Telegram Bot API.
 *
 * Two things here are deliberate and load-bearing.
 *
 * `proxy: false` -- HTTPS_PROXY is process-wide and plain axios honours it.
 * ADR-0023's egress hop is a single residential tinyproxy with a 10s
 * AbortSignal and no retry-on-abort, meant only for Mashov. A parent's message
 * must never traverse it, so the proxy is switched off explicitly rather than
 * left to the environment.
 *
 * The bot token is kept out of `baseURL` and put on each request path instead.
 * An axios error carries `config.url`, which ends up in logs and error
 * trackers; a token in the base URL would be in every one of them.
 */
@Injectable()
export class TelegramSender implements DigestSender {
  readonly channel = 'telegram';

  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: TELEGRAM_API_ROOT,
      timeout: SEND_TIMEOUT_MS,
      proxy: false,
    });
  }

  async send(address: string, text: string): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token.trim().length === 0) {
      throw new Error('Cannot send a digest: TELEGRAM_BOT_TOKEN is not configured.');
    }

    // The transport call and the ok-check are deliberately not in the same
    // try: a `throw` for ok=false inside it would be caught by its own catch
    // and re-described as a transport failure, losing Telegram's reason.
    let data: TelegramResponse | undefined;
    try {
      const response = await this.http.post<TelegramResponse>(
        `/bot${token.trim()}/sendMessage`,
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
      throw new Error(`Telegram send failed: ${redact(describeError(error), token)}`);
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

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const description = (error.response?.data as TelegramResponse | undefined)?.description;
    return description ?? `HTTP ${error.response?.status ?? 'unknown'}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Axios puts the request URL into both the error message and `config.url`, and
 * those reach logs and error trackers. The token is redacted from whatever text
 * we extract rather than trusted not to be in it.
 */
function redact(text: string, token: string): string {
  return text.split(token.trim()).join('[redacted]');
}
