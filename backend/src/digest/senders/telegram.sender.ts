import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import {
  TelegramEnvelope,
  botPath,
  chunkTelegramText,
  createTelegramHttp,
  describeTelegramError,
  telegramRefusal,
  redact,
} from '../../telegram/telegram-http';
import { looksLikeParseFailure, stripTelegramHtml } from '../../telegram/telegram-html';
import { DigestSender, TelegramSendOptions } from './digest-sender.interface';

/**
 * Delivers a digest through the Telegram Bot API.
 *
 * The axios instance comes from `telegram-http.ts`, which owns the two
 * load-bearing decisions -- `proxy: false` so a parent's message never crosses
 * ADR-0023's Mashov-only residential hop, and the token on the request path
 * rather than in `baseURL` so it stays out of `config.url` in every log line.
 * One place owns them because the link poller makes the same calls.
 *
 * Text arrives already rendered. A caller that composed HTML says so with
 * `{ parseMode: 'HTML' }`; everything else keeps the flat send it always had.
 * See ADR-0047 for why HTML is now worth the risk, and `sendOne` for the
 * strip-and-retry that bounds it.
 */
@Injectable()
export class TelegramSender implements DigestSender {
  readonly channel = 'telegram';

  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = createTelegramHttp();
  }

  /**
   * The env var holding the bot token.
   *
   * A method rather than a field so a subclass can override it without
   * depending on field-initialisation order, and read at send time rather than
   * construction so a stack can be configured after boot. FeedbackTelegramSender
   * overrides it to deliver operator notifications as a different bot; see
   * ADR-0045.
   */
  protected tokenVar(): string {
    return 'TELEGRAM_BOT_TOKEN';
  }

  /**
   * Whether a token is configured at all. Callers that treat "unconfigured" as
   * off rather than broken gate on this instead of sending and catching -- a
   * failed send costs an attempt, and for the feedback outbox those are
   * countable and spent.
   */
  hasToken(): boolean {
    const token = this.config.get<string>(this.tokenVar());
    return typeof token === 'string' && token.trim().length > 0;
  }

  /**
   * Whether HTML parse mode is live.
   *
   * A kill switch rather than a constant, so a parse problem in production is
   * a restart rather than a deploy. Default on: unset, empty, or anything
   * other than an explicit falsey word means HTML.
   */
  private htmlEnabled(): boolean {
    const raw = this.config.get<string | boolean>('TELEGRAM_HTML_ENABLED');
    if (raw === undefined || raw === null) return true;
    const normalized = String(raw).trim().toLowerCase();
    if (normalized.length === 0) return true;
    return !['false', '0', 'no', 'off'].includes(normalized);
  }

  async send(address: string, text: string, options: TelegramSendOptions = {}): Promise<void> {
    const token = this.config.get<string>(this.tokenVar());
    if (!token || token.trim().length === 0) {
      throw new Error(`Cannot send a message: ${this.tokenVar()} is not configured.`);
    }

    // The sender, not the template, decides whether markup goes out as markup.
    // Templates always render HTML; with TELEGRAM_HTML_ENABLED off the same
    // message still has to reach the parent, flat. Stripping happens BEFORE
    // chunking, because chunking markup and stripping afterwards would cut the
    // parts to a budget the sent text no longer has.
    const wantsHtml = options.parseMode === 'HTML';
    const asHtml = wantsHtml && this.htmlEnabled();
    const payload = wantsHtml && !asHtml ? stripTelegramHtml(text) : text;

    // Sequential, and it stops at the first refusal rather than pressing on.
    // A part that failed is news the parent did not get, and the orchestrator
    // reads a throw as "nothing was reported" and releases the claims -- so
    // continuing past a failure would confirm items whose text never arrived.
    for (const part of chunkTelegramText(payload)) {
      await this.sendOne(token, address, part, asHtml);
    }
  }

  /**
   * One part, with one retry -- and only for the one failure a retry can fix.
   *
   * A parse complaint is about the payload: the same words stripped flat will
   * be accepted, so the retry costs one call and saves the parent the whole
   * message. This is the belt the old "no parse_mode, ever" rule used to be,
   * and it is why HTML is safe to turn on at all (ADR-0047).
   *
   * Anything else -- a 429, a 502, a blocked bot -- is NOT retried. Sending
   * stripped text after one of those would report success for a message that
   * never arrived, and the digest would confirm its claims and bury the day's
   * news for good.
   */
  private async sendOne(
    token: string,
    address: string,
    text: string,
    asHtml: boolean,
  ): Promise<void> {
    const refusal = await this.post(token, address, text, asHtml);
    if (refusal === null) return;

    if (asHtml && looksLikeParseFailure(refusal)) {
      const retried = await this.post(token, address, stripTelegramHtml(text), false);
      if (retried === null) return;
      throw new Error(`Telegram send failed: ${redact(retried, token)}`);
    }

    throw new Error(`Telegram send failed: ${redact(refusal, token)}`);
  }

  /**
   * Null when Telegram accepted it, otherwise Telegram's own description.
   *
   * A refusal Telegram ANSWERED with is returned, whatever its HTTP status --
   * the Bot API reports a parse error as a 400, and axios rejects it, so a
   * catch that threw every rejection left the retry above unreachable in
   * production. A rejection with no response never reached Telegram and
   * throws straight out, which is what still keeps a 502 out of the retry.
   *
   * The transport call and the ok-check are deliberately not in the same try:
   * a `throw` for ok=false inside it would be caught by its own catch and
   * re-described as a transport failure, losing Telegram's reason.
   */
  private async post(
    token: string,
    address: string,
    text: string,
    asHtml: boolean,
  ): Promise<string | null> {
    let data: TelegramEnvelope<unknown> | undefined;
    try {
      const response = await this.http.post<TelegramEnvelope<unknown>>(
        botPath(token, 'sendMessage'),
        {
          chat_id: address,
          text,
          // Omitted rather than sent as undefined: a caller that rendered no
          // markup gets exactly the flat send it always got.
          ...(asHtml ? { parse_mode: 'HTML' } : {}),
          disable_web_page_preview: true,
        },
      );
      data = response.data;
    } catch (error) {
      // A 400 is Telegram answering, not the transport failing -- and a parse
      // complaint is always a 400. `telegramRefusal` is null only when no
      // response came back at all.
      const refusal = telegramRefusal(error);
      if (refusal !== null) return refusal;
      throw new Error(`Telegram send failed: ${redact(describeTelegramError(error), token)}`);
    }

    if (data?.ok === true) return null;
    return data?.description && data.description.length > 0
      ? data.description
      : 'Telegram reported ok=false';
  }
}
