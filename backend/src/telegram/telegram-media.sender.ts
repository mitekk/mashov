import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import FormData = require('form-data');
import {
  TelegramEnvelope,
  botPath,
  createTelegramHttp,
  describeTelegramError,
  telegramRefusal,
  redact,
} from './telegram-http';
import {
  DEFAULT_PHOTO_MAX_BYTES,
  chooseTelegramMediaMethod,
} from './telegram-media-method';
import { looksLikeParseFailure, stripTelegramHtml } from './telegram-html';

/** Telegram's own ceiling for a caption, in UTF-16 code units. */
const CAPTION_LIMIT = 1024;

/** Truncated below the ceiling: a caption cannot be chunked the way text can. */
const CAPTION_BUDGET = 1000;

/**
 * Well under Telegram's 50 MB document / 10 MB photo bot-upload ceilings.
 *
 * The bound exists for the host, not for Telegram: the bytes are buffered in
 * memory between the Mashov download and the upload, and a cron that fetches
 * several of them per run is the one thing here that can move the process's
 * memory profile.
 */
const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

export interface TelegramMediaFile {
  fileName: string;
  buffer: Buffer;
  /** From the download's `content-type`; null when upstream sent none. */
  contentType: string | null;
  /** One line. Telegram caps it at 1024 and it cannot be split. */
  caption?: string;
  /**
   * Set by a caller that rendered the caption as Telegram HTML -- which the
   * digest and inbox captions now do, because a caption anchors a deep link
   * to the item the file came from. The sender still decides whether the
   * markup goes out as markup, and owns the strip-and-retry. See ADR-0047.
   */
  captionParseMode?: 'HTML';
}

/**
 * Sending a file to a chat.
 *
 * A separate interface from `DigestSender` on purpose: that contract is two
 * members and every implementation of it is a text channel. A sender that can
 * also upload bytes is a different capability, and the dry-run `LogSender`
 * implements the text one honestly without pretending to the other.
 */
export interface MediaSender {
  sendMedia(address: string, file: TelegramMediaFile): Promise<void>;
}

/**
 * Uploads a file into a Telegram chat.
 *
 * Built on `createTelegramHttp()` so the two load-bearing Bot API decisions
 * are inherited rather than restated: `proxy: false`, because ADR-0023's
 * residential hop is Mashov-only and HTTPS_PROXY is process-wide; and the
 * token on the request path rather than in `baseURL`, because an axios error
 * carries `config.url` into every log line.
 *
 * `sendMediaGroup` is deliberately not used. Only the first item's caption
 * renders, and one bad item fails the whole group -- the opposite of the
 * per-file isolation the callers need, where a single unreadable attachment
 * must not cost the parent the other two. Captions carrying a deep link each
 * do not change that reasoning (ADR-0047 leaves ADR-0039 standing).
 */
@Injectable()
export class TelegramMediaSender implements MediaSender {
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = createTelegramHttp({
      // axios defaults both to 10 MB and REJECTS a larger body locally, before
      // any request is made, with an error that does not mention the size.
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  }

  async sendMedia(address: string, file: TelegramMediaFile): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token.trim().length === 0) {
      throw new Error('Cannot send media: TELEGRAM_BOT_TOKEN is not configured.');
    }

    if (file.buffer.byteLength === 0) {
      throw new Error(`Refusing to send an empty file: ${file.fileName}`);
    }

    // Checked here rather than left to Telegram: the point is not to push
    // tens of megabytes across the wire to be told no. The caller turns this
    // into a "open it on the site" line instead.
    const maxBytes = this.readBytes('TELEGRAM_MEDIA_MAX_BYTES', DEFAULT_MEDIA_MAX_BYTES);
    if (file.buffer.byteLength > maxBytes) {
      throw new Error(
        `File too large to send: ${file.fileName} (${file.buffer.byteLength} bytes, limit ${maxBytes})`,
      );
    }

    const method = chooseTelegramMediaMethod(
      file.contentType,
      file.buffer.byteLength,
      this.readBytes('TELEGRAM_PHOTO_MAX_BYTES', DEFAULT_PHOTO_MAX_BYTES),
    );

    // Same bargain as the text sender. A caption that anchors a link has to be
    // parsed; a caption Telegram cannot parse must not cost the parent the
    // file, so the one failure a retry can fix is retried flat and nothing
    // else is. The bytes are already in memory, so the retry re-uploads them
    // -- which is the price of a parse complaint, and it is rare.
    const wantsHtml = file.captionParseMode === 'HTML';
    const asHtml = wantsHtml && this.htmlEnabled();
    const caption = truncateCaption(
      wantsHtml && !asHtml ? stripTelegramHtml(file.caption ?? '') : file.caption,
    );

    const refusal = await this.upload(token, address, method, file, caption, asHtml);
    if (refusal === null) return;

    if (asHtml && looksLikeParseFailure(refusal)) {
      const flat = truncateCaption(stripTelegramHtml(file.caption ?? ''));
      const retried = await this.upload(token, address, method, file, flat, false);
      if (retried === null) return;
      throw new Error(`Telegram ${method} failed: ${redact(retried, token)}`);
    }

    throw new Error(`Telegram ${method} failed: ${redact(refusal, token)}`);
  }

  /** Null when Telegram accepted it, otherwise its own description. */
  private async upload(
    token: string,
    address: string,
    method: string,
    file: TelegramMediaFile,
    caption: string | undefined,
    asHtml: boolean,
  ): Promise<string | null> {
    const field = method === 'sendPhoto' ? 'photo' : 'document';

    const form = new FormData();
    form.append('chat_id', address);
    // Appended only when there is one: an empty caption field is a field
    // Telegram has to parse for nothing. The same goes for parse_mode, so a
    // flat caption is byte-for-byte the upload this project always sent.
    if (caption) form.append('caption', caption);
    if (caption && asHtml) form.append('parse_mode', 'HTML');
    form.append(field, file.buffer, {
      filename: safeFileName(file.fileName),
      contentType: file.contentType ?? 'application/octet-stream',
    });

    let data: TelegramEnvelope<unknown> | undefined;
    try {
      const response = await this.http.post<TelegramEnvelope<unknown>>(
        botPath(token, method),
        form,
        { headers: form.getHeaders() },
      );
      data = response.data;
    } catch (error) {
      // A 400 is Telegram answering -- and an unparseable caption is always a
      // 400, which axios rejects -- so its description is returned and the
      // caption retry above can actually reach it.
      const refusal = telegramRefusal(error);
      if (refusal !== null) return refusal;
      // No response at all: the transport failed, so this is thrown rather
      // than returned. Re-uploading after a 502 would be a second upload, not
      // a fix.
      throw new Error(`Telegram ${method} failed: ${redact(describeTelegramError(error), token)}`);
    }

    if (data?.ok === true) return null;
    return data?.description && data.description.length > 0
      ? data.description
      : 'Telegram reported ok=false';
  }

  /** Mirrors `TelegramSender.htmlEnabled`: the kill switch is one env var. */
  private htmlEnabled(): boolean {
    const raw = this.config.get<string | boolean>('TELEGRAM_HTML_ENABLED');
    if (raw === undefined || raw === null) return true;
    const normalized = String(raw).trim().toLowerCase();
    if (normalized.length === 0) return true;
    return !['false', '0', 'no', 'off'].includes(normalized);
  }

  private readBytes(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string | number>(key));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}

/**
 * A filename safe to put in a multipart header.
 *
 * Control characters, quotes and path separators come out; the readable name
 * survives, including Hebrew, which is the reason this uses form-data
 * explicitly rather than whatever axios would infer. A name that is nothing
 * but separators still has to produce something, or the upload has no
 * filename at all.
 */
export function safeFileName(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\]/g, '')
    .split(/[/\\]/)
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .pop();

  const trimmed = (cleaned ?? '').trim();
  if (trimmed.length === 0) return 'file';
  // Long enough for any real name; short enough that no header is unbounded.
  return trimmed.length > 150 ? trimmed.slice(0, 150) : trimmed;
}

/** A caption cannot be chunked, so it is cut rather than allowed to fail. */
export function truncateCaption(caption: string | undefined): string | undefined {
  const trimmed = caption?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= CAPTION_LIMIT) return trimmed;
  return `${trimmed.slice(0, CAPTION_BUDGET)}…`;
}
