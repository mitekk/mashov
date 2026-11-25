import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { FeedbackTelegramSender } from './feedback-telegram.sender';
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

/**
 * Refusals that describe the DESTINATION, not the report.
 *
 * Feedback-local on purpose, and deliberately the opposite call to the one
 * `isPermanentTelegramFailure` makes for the digest. A private channel refuses
 * a bot that is not one of its admins with "bot is not a member of the channel
 * chat" or "need administrator rights in the channel chat"; one that IS an
 * admin but lacks the Post Messages right gets "not enough rights to send text
 * messages to the chat". None of those is in PERMANENT_TELEGRAM_FAILURES, so
 * all of them classify as transient -- three attempts, six minutes apart, and
 * then the row is retired for good. During rollout that is exactly what
 * happens if the two env vars are set before the bot is a channel admin with
 * post rights: every report already waiting silently loses its notification
 * forever. The reports survive -- they stay in the table and on
 * /admin/feedback -- but nobody is ever pinged.
 *
 * The test for membership is "is this about the address or the credential, or
 * about this attempt?" Everything that is about the transport -- a 502, a 429,
 * a reset socket, an ok=false with no description -- is left on the
 * three-attempt path, because it recovers on its own and a row that retries
 * forever on a real outage is a worse trade. Telegram's own description is the
 * only thing matched, never the report's text (`describeTelegramError` returns
 * the description, an HTTP status or an axios code -- never the request body),
 * so a parent cannot park their own report by typing one of these phrases.
 *
 * So a failure about the destination parks the row instead of charging it an
 * attempt: same principle as the missing-token gate in `deliverPending`. The
 * row delivers by itself on the first tick after the channel is fixed.
 *
 * This is NOT the right call for the digest, and that classification must not
 * change. There the address is a per-parent chat the parent themselves
 * supplied, so a refusal means that recipient is gone and SHOULD be retired --
 * retrying it forever would re-summarize and re-send on every run, with a
 * model call each time. Here there is a single operator-owned address, no model
 * call, at most 20 sends per two minutes against a table bounded at ten rows
 * per household per hour. Different blast radius, different rule.
 *
 * Accepted cost: a destination that is permanently broken retries forever. It
 * is bounded and cheap, it logs once per run rather than once per row, and the
 * stored `notifyError` is rendered on the admin detail view -- which is where
 * an operator looks.
 */
const FEEDBACK_DESTINATION_FAILURES = [
  // The chat id does not resolve -- most often the leading `-100` dropped.
  'chat not found',
  // The channel/group was migrated and this id no longer addresses it.
  'group chat was upgraded',
  // The bot is not in the channel, or not an admin of it.
  'bot is not a member',
  'need administrator rights',
  'chat_admin_required',
  'bot was kicked',
  // The bot IS an admin but without the "Post Messages" right. The likeliest
  // version of the mistake, because that right is a separate toggle and the
  // runbook tells the operator the other admin rights can be off.
  'not enough rights to send',
  'chat_write_forbidden',
  'have no rights to send a message',
  // The token is wrong or revoked. Included deliberately: it is the same class
  // of mistake as a typo'd chat id, made in the same rollout window, with the
  // same consequence -- and unlike a 502 it never recovers on its own, so
  // spending the three attempts on it only guarantees that the reports already
  // waiting are the ones that lose their notification. `hasToken()` catches a
  // MISSING token before any send; this catches a malformed one.
  'unauthorized',
  'http 401',
];

/** Whether a refusal is about the address rather than this row. */
export function isDestinationFailure(description: string): boolean {
  const text = description.toLowerCase();
  return FEEDBACK_DESTINATION_FAILURES.some((phrase) => text.includes(phrase));
}

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

export type FeedbackNotifyStatus = 'sent' | 'failed' | 'retired' | 'parked';

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
 * Delivery is on when, and only when, there is somewhere to deliver to:
 * `FEEDBACK_TELEGRAM_BOT_TOKEN` (which bot) and `FEEDBACK_TELEGRAM_CHAT_ID`
 * (which chat). Both unset is the off switch, and it is silent.
 *
 * There is deliberately no `FEEDBACK_NOTIFY_ENABLED` on top. That diverges
 * from `DIGEST_ENABLED` and `INBOX_NOTIFY_ENABLED`, which each gate a cron
 * that is otherwise fully configured -- those features have per-parent
 * recipients, so a wrong-on cron messages real households. Here the two vars
 * are not flags but the two halves of one address, and a third switch would
 * only create a state where delivery is off while everything needed for it is
 * set. Two coordinates, no flag.
 */
@Injectable()
export class FeedbackNotifierService {
  private readonly logger = new Logger(FeedbackNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // FeedbackTelegramSender, not TelegramSender: operator notifications go
    // out as a separate bot from the one that talks to parents (ADR-0045).
    // The concrete type is load-bearing twice over -- it carries `hasToken()`
    // for the gate below, and it makes handing this service the parent-facing
    // sender a compile error rather than a silent cross-wire.
    private readonly telegram: FeedbackTelegramSender,
  ) {}

  /**
   * Whether the outbox has a destination: a bot and a chat.
   *
   * The task checks this before doing anything, so an unconfigured stack runs
   * no query and writes no line on any of its 720 ticks a day. The token half
   * is asked of the sender rather than read from config here, so the env var
   * name lives in exactly one place.
   */
  isConfigured(): boolean {
    return this.telegram.hasToken() && this.chatId() !== null;
  }

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
    // Unconfigured is the off switch, and it is silent: no query and no log
    // line per tick. A stack nobody configured must not write 720 lines a day
    // saying so.
    //
    // The token is checked here and not left to the send: a send that throws
    // costs the row an attempt, and three of those retire it permanently. A
    // stack that is merely missing its token would otherwise burn through
    // every pending report in six minutes and retire the lot.
    if (!chatId || !this.telegram.hasToken()) return [];

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

    // Per run, not per row: a channel the bot has not been made an admin of
    // would otherwise write one line for every pending report, every two
    // minutes, forever.
    const run = { destinationFailureLogged: false };

    const results: FeedbackNotifyResult[] = [];
    for (const row of rows) {
      results.push(await this.deliverOne(chatId, row, baseUrl, run));
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
    run: { destinationFailureLogged: boolean },
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

      // Checked BEFORE the permanent-failure test, because the two lists
      // overlap on "chat not found" and the destination reading is the right
      // one here: a chat id with a typo in it is a setup mistake an operator
      // fixes, not a dead recipient. Park the row -- record the error, leave
      // notifyAttempts untouched, stay pending -- so a destination nobody has
      // finished configuring cannot spend the budget of the reports waiting on
      // it. See FEEDBACK_DESTINATION_FAILURES.
      if (isDestinationFailure(message)) {
        if (!run.destinationFailureLogged) {
          run.destinationFailureLogged = true;
          this.logger.error(
            `Feedback notification parked: the destination refused the message, so no attempt ` +
              `was spent and the pending rows stay pending. Further rows this run are parked ` +
              `without another line. Fix the channel (FEEDBACK_TELEGRAM_CHAT_ID, and the bot ` +
              `must be a channel admin) and delivery resumes by itself: ${message}`,
          );
        }

        try {
          await this.prisma.feedback.update({
            where: { id: row.id },
            data: { notifyError: message },
          });
        } catch {
          // Same reasoning as below: the log line is the record and the row is
          // already pending, which is where parking wanted it anyway.
        }
        return { id: row.id, status: 'parked' };
      }

      // A permanent failure -- a recipient who blocked the bot or whose
      // account is gone -- will fail identically twice more. Spend the
      // remaining attempts now so the row is retired on this pass rather than
      // four minutes from now.
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
