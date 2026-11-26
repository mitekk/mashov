import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service';
import { ChildrenService } from '../children/children.service';
import {
  MediaSender,
  TelegramMediaFile,
  TelegramMediaSender,
} from '../telegram/telegram-media.sender';
import {
  FetchedMedia,
  MediaAttachmentRef,
  MediaDelivery,
  MediaFetchResult,
  MediaSendResult,
} from './media-delivery.interface';

/** Matches TelegramMediaSender's own default; both read the same env var. */
const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/**
 * How many files one message will carry.
 *
 * A school mail with eleven attachments is a mail with a link to the site, not
 * eleven Telegram uploads. The overflow becomes a note, which the caller turns
 * into a line in the text.
 */
const DEFAULT_MAX_FILES_PER_MESSAGE = 3;

/**
 * The byte budget for one batch of downloads.
 *
 * The bytes are buffered in memory between the Mashov download and the
 * Telegram upload, so this is a bound on the process rather than on Telegram.
 */
const DEFAULT_TOTAL_BYTES_PER_RUN = 50 * 1024 * 1024;

/**
 * Telegram allows roughly one message per second per chat, and tighter in
 * groups. A burst of three uploads with no pause is the documented way to be
 * rate-limited.
 */
const DEFAULT_SEND_DELAY_MS = 1100;

/** Ten seconds is right for a JSON read and wrong for a multi-megabyte PDF. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 45_000;

/**
 * Mashov attachment bytes, into a Telegram chat.
 *
 * Its own module because of a boundary: this needs MailModule and
 * ChildrenModule, and through them MashovSessionModule -- which DigestModule's
 * docblock and ADR-0026 forbid it to pull into its own graph. The digest and
 * the inbox notifier depend on the MEDIA_DELIVERY token instead, so neither
 * acquires a path to the residential egress hop.
 *
 * The downloads go through MailService and ChildrenService rather than the
 * Mashov client. Their 4th argument is an `AppUser.id`, not a session: it
 * drives `requireStudent`, `assertVisible` and `canSee`, and scopes the
 * credential fallback. The credentials themselves come out of
 * HouseholdConnection, and MashovSessionService logs in by itself. So the cron
 * passes the DigestRecipient's `userId` and needs nothing it does not already
 * hold -- and a download for a child the parent no longer owns still throws,
 * which is exactly why there is no "system" overload here.
 *
 * Nothing in this class throws. A failed attachment can neither fail nor
 * re-queue the text message, which remains the only thing gating ledger
 * confirmation. See ADR-0039.
 */
@Injectable()
export class TelegramMediaService implements MediaDelivery {
  private readonly logger = new Logger(TelegramMediaService.name);

  readonly enabled = true;

  constructor(
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly children: ChildrenService,
    @Inject(TelegramMediaSender) private readonly sender: MediaSender,
  ) {}

  budgetBytes(): number {
    return this.readBytes('MEDIA_TOTAL_BYTES_PER_RUN', DEFAULT_TOTAL_BYTES_PER_RUN);
  }

  async fetch(
    userId: string,
    refs: MediaAttachmentRef[],
    remainingBytes: number,
  ): Promise<MediaFetchResult> {
    const maxFiles = this.readPositiveInt(
      'MEDIA_MAX_FILES_PER_MESSAGE',
      DEFAULT_MAX_FILES_PER_MESSAGE,
    );
    const maxBytes = this.readBytes('TELEGRAM_MEDIA_MAX_BYTES', DEFAULT_MEDIA_MAX_BYTES);
    const timeoutMs = this.readPositiveInt(
      'MEDIA_DOWNLOAD_TIMEOUT_MS',
      DEFAULT_DOWNLOAD_TIMEOUT_MS,
    );

    const items: FetchedMedia[] = [];
    let budget = remainingBytes;

    for (const [index, ref] of refs.entries()) {
      if (index >= maxFiles) {
        items.push({ ref, note: `too many files on one message: ${ref.fileName} not sent` });
        continue;
      }
      // Checked before, spent after. No size is known anywhere until the file
      // has been downloaded, so the budget can overshoot by at most one file
      // -- which TELEGRAM_MEDIA_MAX_BYTES already bounds.
      if (budget <= 0) {
        items.push({ ref, note: `media byte budget spent: ${ref.fileName} not sent` });
        continue;
      }

      // Each file in its own try. One attachment Mashov has lost, or one the
      // parent no longer has visibility of, must not cost them the others.
      try {
        const file = await this.download(userId, ref, timeoutMs);
        if (file.buffer.byteLength > maxBytes) {
          items.push({
            ref,
            tooLarge: true,
            note: `file too large to send: ${ref.fileName} (${file.buffer.byteLength} bytes)`,
          });
          continue;
        }
        budget -= file.buffer.byteLength;
        items.push({ ref, file });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Media download failed for ${ref.kind}/${ref.fileId}: ${reason}`);
        items.push({ ref, note: `${ref.fileName}: ${reason}` });
      }
    }

    return { items, remainingBytes: budget };
  }

  async send(address: string, items: FetchedMedia[]): Promise<MediaSendResult> {
    const delayMs = this.readDelayMs();
    const notes: string[] = [];
    let sent = 0;
    let first = true;

    for (const item of items) {
      if (!item.file) continue;

      // Paced, and the pause goes BEFORE each upload after the first rather
      // than after each one, so a single file costs nothing.
      if (!first && delayMs > 0) await sleep(delayMs);
      first = false;

      try {
        await this.sender.sendMedia(address, item.file);
        sent += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // A 429 is not a failure of this attachment; it is Telegram asking for
        // a pause this run will not take. Skipped, and named as such, so a
        // reader of the delivery row does not go looking for a broken file.
        const note = isRateLimit(reason)
          ? `rate limited while sending ${item.ref.fileName}; skipped`
          : `${item.ref.fileName}: ${reason}`;
        this.logger.warn(`Media send failed for ${item.ref.fileId}: ${reason}`);
        notes.push(note);
      }
    }

    return { sent, notes };
  }

  /**
   * The existing downloaders, reused as-is.
   *
   * Deliberately no "system" overload and no bypass: the visibility checks
   * inside these methods are the only thing standing between the cron and a
   * file belonging to a child the parent has since unlinked.
   */
  private async download(
    userId: string,
    ref: MediaAttachmentRef,
    timeoutMs: number,
  ): Promise<TelegramMediaFile> {
    const options = { timeoutMs };
    const downloaded =
      ref.kind === 'mail'
        ? await this.mail.downloadMessageAttachment(
            ref.ownerId,
            ref.itemId,
            ref.fileId,
            userId,
            options,
          )
        : ref.kind === 'homework'
          ? await this.children.downloadHomeworkAttachment(
              ref.ownerId,
              ref.itemId,
              ref.fileId,
              userId,
              options,
            )
          : await this.children.downloadBehaviorAttachment(
              ref.ownerId,
              ref.itemId,
              ref.fileId,
              userId,
              options,
            );

    return {
      // Upstream's own `content-disposition` name when it sent one, else the
      // name the enumeration found.
      fileName: downloaded.fileName ?? ref.fileName,
      buffer: downloaded.buffer,
      contentType: downloaded.contentType,
      ...(ref.caption ? { caption: ref.caption } : {}),
      ...(ref.caption && ref.captionParseMode ? { captionParseMode: ref.captionParseMode } : {}),
    };
  }

  private readDelayMs(): number {
    const raw = this.config.get<string | number>('MEDIA_SEND_DELAY_MS');
    const parsed = Number(raw);
    // Zero is meaningful here (the specs use it), so this cannot go through
    // readPositiveInt, which would substitute the default.
    if (raw === undefined || raw === null || raw === '' || !Number.isInteger(parsed) || parsed < 0) {
      return DEFAULT_SEND_DELAY_MS;
    }
    return parsed;
  }

  private readBytes(key: string, fallback: number): number {
    return this.readPositiveInt(key, fallback);
  }

  private readPositiveInt(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string | number>(key));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(reason: string): boolean {
  return /too many requests|retry after|retry_after|429/i.test(reason);
}
