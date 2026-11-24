import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramSender } from '../digest/senders/telegram.sender';
import { DigestSender } from '../digest/senders/digest-sender.interface';
import { isPermanentTelegramFailure } from '../telegram/telegram-http';
import { resolvePublicBaseUrl } from '../telegram/public-base-url';
import type { FeedbackSchoolSnapshot } from './feedback.service';

/**
 * Attempts a report gets before it is retired.
 *
 * Three, and then never again. A report is not a digest: there is nothing to
 * re-derive and nobody waiting on a retry, so an outbox that retried forever
 * would log the same failure every two minutes for as long as the row exists.
 * The row keeps `notifyError`, and the admin detail view renders it -- so a
 * retired report is visible rather than silently dropped.
 */
export const FEEDBACK_NOTIFY_MAX_ATTEMPTS = 3;

/** Rows one tick will try. The table is tiny; this is a runaway guard. */
export const FEEDBACK_NOTIFY_DEFAULT_LIMIT = 20;

/**
 * Characters of the report's own text that reach the chat.
 *
 * The full text is in the row and on the admin screen the message links to.
 * This is a notification, not the record -- and `chunkTelegramText` splitting
 * one parent's complaint across three messages serves nobody.
 */
export const FEEDBACK_CONTENT_PREVIEW_MAX = 500;

/** What the outbox pass reads. Narrower than the row on purpose. */
export interface FeedbackOutboxRow {
  id: string;
  subject: string;
  subjectOther: string | null;
  contactEmail: string | null;
  content: string;
  pagePath: string | null;
  appVersion: string | null;
  displayName: string;
  username: string;
  schoolsSnapshot: FeedbackSchoolSnapshot[];
  createdAt: Date;
  notifyAttempts: number;
  notifyError?: string | null;
}

export type FeedbackNotifyStatus = 'sent' | 'failed' | 'retired';

export interface FeedbackNotifyResult {
  id: string;
  status: FeedbackNotifyStatus;
}

const OUTBOX_SELECT = {
  id: true,
  subject: true,
  subjectOther: true,
  contactEmail: true,
  content: true,
  pagePath: true,
  appVersion: true,
  displayName: true,
  username: true,
  schoolsSnapshot: true,
  createdAt: true,
  notifyAttempts: true,
} as const;

/**
 * Delivers one Telegram message per new feedback row.
 *
 * Kept out of `FeedbackService` deliberately: that class is about writing the
 * row, and this one is about an egress that can fail. `create()` is untouched
 * -- there is no inline send, no floating promise, and no added latency on the
 * request a parent is waiting for. A two-minute cron calls
 * `deliverPending()`.
 *
 * The single switch is `FEEDBACK_TELEGRAM_CHAT_ID`. This diverges from the
 * house convention on purpose -- `DIGEST_ENABLED` and `INBOX_NOTIFY_ENABLED`
 * each gate a cron that is otherwise fully configured, because those features
 * have per-parent recipients and a wrong-on cron messages real households.
 * Here a configured chat id has no meaning other than "notify this chat", and
 * a second flag would only create a state where delivery is silently off while
 * everything needed for it is set.
 */
@Injectable()
export class FeedbackNotifierService {
  private readonly logger = new Logger(FeedbackNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // Concrete class as the token, interface as the type: the sender is
    // DigestModule's export and the chunking / permanent-failure
    // classification come with it rather than being copied here.
    @Inject(TelegramSender) private readonly telegram: DigestSender,
  ) {}

  /**
   * One outbox pass: undelivered rows under the attempt ceiling, oldest first.
   *
   * Per row, the outcome is persisted in BOTH branches and a throw never
   * escapes -- the loop must not let one unreachable chat or one malformed row
   * stop the rows behind it. Returns one result per row attempted, which the
   * task reduces to a single log line.
   */
  async deliverPending(limit?: number): Promise<FeedbackNotifyResult[]> {
    const chatId = this.chatId();
    // Unset is the off switch, and it is silent: no query and no log line per
    // tick. A stack nobody configured a chat for must not write 720 lines a
    // day saying so.
    if (!chatId) return [];

    const rows = (await this.prisma.feedback.findMany({
      where: {
        notifiedAt: null,
        notifyAttempts: { lt: FEEDBACK_NOTIFY_MAX_ATTEMPTS },
      },
      select: OUTBOX_SELECT,
      orderBy: { createdAt: 'asc' },
      take: limit ?? this.maxPerRun(),
    })) as unknown as FeedbackOutboxRow[];

    const baseUrl = resolvePublicBaseUrl(this.config.get<string>('PUBLIC_BASE_URL'));

    const results: FeedbackNotifyResult[] = [];
    for (const row of rows) {
      results.push(await this.deliverOne(chatId, row, baseUrl));
    }
    return results;
  }

  /**
   * The operator's message. Plain text, no `parse_mode`.
   *
   * `TelegramSender` sends none, and that is load-bearing here: a parent's own
   * words routinely contain `* _ - . !`, and Telegram rejects an entire
   * message whose markup is unbalanced. A report that cannot be sent because
   * the parent used an asterisk is the worst possible failure for this feature.
   */
  buildMessage(row: FeedbackOutboxRow, baseUrl: string | null): string {
    const lines: string[] = [
      'New feedback report',
      '',
      `Subject: ${this.subjectLine(row)}`,
      `From: ${row.displayName} (${row.username})`,
    ];

    // Omitted rather than printed as "none", unlike every other field here.
    // It is the single most identifying value in the message (see ADR-0045),
    // so an absent one leaves no line behind at all.
    if (row.contactEmail) lines.push(`Email: ${row.contactEmail}`);

    lines.push(
      `Schools: ${this.schoolsLine(row.schoolsSnapshot)}`,
      `Page: ${row.pagePath ?? 'none'}`,
      `App: ${row.appVersion ?? 'unknown'}`,
      `Sent: ${row.createdAt.toISOString()}`,
      '',
      this.truncate(row.content),
      '',
    );

    // Null means PUBLIC_BASE_URL is unset or unusable, and then no link line is
    // rendered at all -- the precedent in digest.service.ts and
    // inbox-notify.service.ts. "undefined/admin/feedback/<id>" in a chat is
    // worse than no link.
    if (baseUrl) lines.push(`${baseUrl}/admin/feedback/${row.id}`);

    // Last, and always: the one field that still works when the link does not.
    lines.push(`id: ${row.id}`);

    return lines.join('\n');
  }

  private async deliverOne(
    chatId: string,
    row: FeedbackOutboxRow,
    baseUrl: string | null,
  ): Promise<FeedbackNotifyResult> {
    const attempts = row.notifyAttempts + 1;
    try {
      await this.telegram.send(chatId, this.buildMessage(row, baseUrl));
      await this.prisma.feedback.update({
        where: { id: row.id },
        data: { notifiedAt: new Date(), notifyAttempts: attempts, notifyError: null },
      });
      return { id: row.id, status: 'sent' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A permanent failure -- a bad chat id, a blocked bot -- will fail
      // identically twice more. Spend the remaining attempts now so the row is
      // retired on this pass rather than four minutes from now.
      const permanent = isPermanentTelegramFailure(message);
      const spent = permanent ? FEEDBACK_NOTIFY_MAX_ATTEMPTS : attempts;
      const status: FeedbackNotifyStatus =
        spent >= FEEDBACK_NOTIFY_MAX_ATTEMPTS ? 'retired' : 'failed';

      this.logger.error(
        `Feedback notification ${status} for ${row.id} after ${spent} attempt(s): ${message}`,
      );

      try {
        await this.prisma.feedback.update({
          where: { id: row.id },
          data: { notifyAttempts: spent, notifyError: message },
        });
      } catch {
        // Nothing left to do: the database is where the failure would have been
        // recorded. The log line above is the record, and the row stays
        // pending so the next tick tries again.
      }
      return { id: row.id, status };
    }
  }

  private subjectLine(row: FeedbackOutboxRow): string {
    return row.subjectOther ? `${row.subject} — ${row.subjectOther}` : row.subject;
  }

  /**
   * `schoolsSnapshot` is a Json column: `db push` never validated it, and a
   * hand-edited or pre-feature row can hold anything. Shape is checked rather
   * than assumed -- a notifier that threw here would retire the report over a
   * field nobody reads.
   */
  private schoolsLine(snapshot: FeedbackSchoolSnapshot[]): string {
    if (!Array.isArray(snapshot) || snapshot.length === 0) return 'none';
    const labels = snapshot
      .filter((school) => school && typeof school === 'object')
      .map((school) => `${school.label ?? school.schoolName ?? '?'} (${school.schoolCode})`);
    return labels.length > 0 ? labels.join(', ') : 'none';
  }

  private truncate(content: string): string {
    return content.length <= FEEDBACK_CONTENT_PREVIEW_MAX
      ? content
      : `${content.slice(0, FEEDBACK_CONTENT_PREVIEW_MAX)}…`;
  }

  /** Trimmed, and blank counts as unset: a stray space is not a chat id. */
  private chatId(): string | null {
    const raw = this.config.get<string>('FEEDBACK_TELEGRAM_CHAT_ID');
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  }

  private maxPerRun(): number {
    const raw = Number(this.config.get<string>('FEEDBACK_NOTIFY_MAX_PER_RUN'));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : FEEDBACK_NOTIFY_DEFAULT_LIMIT;
  }
}
