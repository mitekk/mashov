import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { canSeeStudent } from '../common/student-links';
import { TelegramSender } from '../digest/senders/telegram.sender';
import { TelegramClient } from './telegram.client';

/** 16 random bytes as hex: 32 chars, inside Telegram's 64-char /start payload. */
const CODE_BYTES = 16;
const DEFAULT_TTL_MINUTES = 15;

export interface MintedTelegramLink {
  code: string;
  deepLink: string;
  botUsername: string;
  expiresAt: Date;
}

export type TelegramLinkStatus = 'pending' | 'linked' | 'expired';

/** Only the fields of a Telegram update this project reads. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
}

/**
 * `/start`, `/start <code>`, and the `/start@botname <code>` form Telegram
 * sends in groups. Anything else is ordinary chatter and is ignored.
 */
const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/;

const REPLY_ALREADY_CONNECTED =
  'הטלגרם הזה כבר מחובר לחשבון שלכם ✅ אין צורך לעשות שוב — העדכונים ימשיכו להגיע לכאן.';
const REPLY_LINK_DEAD =
  'הקישור הזה כבר לא בתוקף. פתחו שוב את האפליקציה, היכנסו ל"עוד" → "עדכונים בטלגרם" וקבלו קישור חדש.';
const REPLY_NEEDS_APP =
  'שלום! כדי לקבל עדכונים על הילדים, פתחו את האפליקציה, היכנסו ל"עוד" → "עדכונים בטלגרם" ולחצו על הקישור משם.';

export interface TelegramLinkState {
  status: TelegramLinkStatus;
  linkedAt: Date | null;
  recipientCount: number;
  confirmationSent: boolean;
  confirmationError: string | null;
  /**
   * Whether the server will actually send briefings from here on. The wizard's
   * last step must not promise a parent messages that `DIGEST_ENABLED=false`
   * will never produce, and the flag lives on the server, so this is the only
   * way the browser can know.
   */
  deliveryEnabled: boolean;
}

/**
 * Binding a parent's Telegram chat to their account, both ends of it.
 *
 * A Telegram bot can never start a conversation -- it may only message a chat
 * that has already pressed START on it -- so the parent pressing START is
 * unavoidable in any design. The only real question is what happens to their
 * chat id afterwards, and the answer here is that we read it out of the START
 * itself rather than asking them to find @userinfobot and retype a number,
 * which would buy nothing and verify nothing.
 *
 * All the logic lives in this service and none of it in the poller, so the
 * specs can hand `consume()` an update object with no timer and no network
 * anywhere. See ADR-0033.
 */
@Injectable()
export class TelegramLinkService {
  private readonly logger = new Logger(TelegramLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly client: TelegramClient,
    private readonly sender: TelegramSender,
  ) {}

  /**
   * A one-time code and the deep link that carries it.
   *
   * The chosen children travel on the row because the START arrives
   * server-side with no browser attached. Visibility is checked here and again
   * at consume time, since the roster can change in between.
   */
  async mint(
    userId: string,
    studentGuids: string[],
    now: Date = new Date(),
  ): Promise<MintedTelegramLink> {
    if (!this.client.hasToken()) {
      throw new ServiceUnavailableException({
        error: {
          code: 'TELEGRAM_NOT_CONFIGURED',
          message: 'This server has no Telegram bot configured.',
          details: [],
        },
      });
    }

    const guids = [...new Set(studentGuids.map((guid) => guid.trim()).filter(Boolean))];
    if (guids.length === 0) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Choose at least one child to receive updates about.',
          details: [{ field: 'studentGuids', message: 'Must name at least one child.' }],
        },
      });
    }

    for (const studentGuid of guids) {
      if (!(await canSeeStudent(this.prisma, userId, studentGuid))) {
        throw new ForbiddenException({
          error: {
            code: 'FORBIDDEN',
            message: 'That child belongs to another household.',
            details: [{ field: 'studentGuids', message: studentGuid }],
          },
        });
      }
    }

    // Asked for before the row is written: a getMe failure would otherwise
    // leave a live code behind that the parent was never given a link to.
    let botUsername: string;
    try {
      botUsername = await this.client.getMe();
    } catch (error) {
      this.logger.error(
        `Cannot mint a Telegram link: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException({
        error: {
          code: 'TELEGRAM_UNAVAILABLE',
          message: 'Telegram could not be reached. Try again in a moment.',
          details: [],
        },
      });
    }

    const code = randomBytes(CODE_BYTES).toString('hex');
    const expiresAt = new Date(now.getTime() + this.ttlMinutes() * 60 * 1000);

    await this.prisma.telegramLinkCode.create({
      data: { code, userId, studentGuids: guids, expiresAt },
    });

    return {
      code,
      botUsername,
      deepLink: `https://t.me/${botUsername}?start=${code}`,
      expiresAt,
    };
  }

  /**
   * Where one code stands, for the wizard's third step to poll.
   *
   * Scoped to the caller's own userId as well as the code, so a code is never
   * a bearer token for another user's link status.
   */
  async statusFor(
    userId: string,
    code: string,
    now: Date = new Date(),
  ): Promise<TelegramLinkState> {
    const row = await this.prisma.telegramLinkCode.findFirst({ where: { code, userId } });
    if (!row) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'No such link code.', details: [] },
      });
    }

    const deliveryEnabled = this.isDeliveryEnabled();
    const base = {
      confirmationSent: row.confirmationSentAt !== null,
      confirmationError: row.confirmationError,
      deliveryEnabled,
    };

    if (row.consumedAt) {
      // A consumed code stays 'linked' forever. The wizard polls after the
      // START landed, and a link that worked must not start reading as expired
      // a quarter of an hour later.
      const recipientCount = row.chatId
        ? await this.prisma.digestRecipient.count({
            where: { userId, channel: 'telegram', address: row.chatId },
          })
        : 0;
      return { ...base, status: 'linked', linkedAt: row.consumedAt, recipientCount };
    }

    return {
      ...base,
      status: row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending',
      linkedAt: null,
      recipientCount: 0,
    };
  }

  /**
   * Turns Telegram updates off for this parent entirely.
   *
   * Every recipient row goes, not just the enabled ones -- "ניתוק" means the
   * chat id stops being stored at all, and a parent's chat id is personal data.
   * The codes go with them so nothing left behind could re-bind the chat.
   * Per-child off is `PATCH /digest/recipients/:id`, not this.
   */
  async disconnect(userId: string): Promise<number> {
    const removed = await this.prisma.digestRecipient.deleteMany({
      where: { userId, channel: 'telegram' },
    });
    await this.prisma.telegramLinkCode.deleteMany({ where: { userId } });
    return removed.count;
  }

  /**
   * One Telegram update, from the poller. The chat id in it is the whole point.
   *
   * Never throws: the poller delegates every update here and must survive a bad
   * one, so everything unexpected is ignored or logged. Reprocessing is safe by
   * construction, because claiming the code is a conditional update
   * (`consumedAt: null`) and the recipient writes are upserts -- which is what
   * lets the poller keep its offset in memory and still be handed the last 24
   * hours of unconfirmed updates after a restart.
   */
  async consume(update: TelegramUpdate, now: Date = new Date()): Promise<void> {
    const rawChatId = update.message?.chat?.id;
    const text = update.message?.text?.trim();
    if (rawChatId === undefined || rawChatId === null || !text) return;

    const match = START_COMMAND.exec(text);
    if (!match) return;

    const chatId = String(rawChatId);
    const code = match[1];
    if (!code) {
      // A bare START: somebody found the bot by name. There is no account to
      // bind, and guessing one would be the whole threat this design avoids.
      await this.reply(chatId, REPLY_NEEDS_APP);
      return;
    }

    const row = await this.prisma.telegramLinkCode.findFirst({ where: { code } });
    if (!row) {
      await this.reply(chatId, REPLY_LINK_DEAD);
      return;
    }

    // The claim and the single-use check are one statement on purpose. A second
    // START for the same code -- a replay from Telegram's 24-hour retention, or
    // a parent tapping the link twice -- claims nothing and changes nothing.
    const claimed = await this.prisma.telegramLinkCode.updateMany({
      where: { code, consumedAt: null, expiresAt: { gt: now } },
      data: { chatId, consumedAt: now },
    });
    if (claimed.count === 0) {
      const sameChatAlreadyLinked = row.consumedAt !== null && row.chatId === chatId;
      await this.reply(chatId, sameChatAlreadyLinked ? REPLY_ALREADY_CONNECTED : REPLY_LINK_DEAD);
      return;
    }

    // Re-validated here as well as at mint time: the roster can change in
    // between, and a child who has left must not cost the parent their other
    // children's updates, so a guid that is no longer visible is skipped.
    const visible: string[] = [];
    for (const studentGuid of row.studentGuids) {
      if (await canSeeStudent(this.prisma, row.userId, studentGuid)) visible.push(studentGuid);
    }

    for (const studentGuid of visible) {
      await this.prisma.digestRecipient.upsert({
        where: {
          studentGuid_channel_address: { studentGuid, channel: 'telegram', address: chatId },
        },
        create: { userId: row.userId, studentGuid, channel: 'telegram', address: chatId },
        // The parent just chose this child in the wizard, so an explicit
        // re-subscribe overrides an earlier toggle-off. activeFrom is left
        // alone: resetting it would drop today's items they have not had yet.
        update: { enabled: true },
      });
    }

    await this.sendConfirmation(row.id, chatId, visible, now);
  }

  /**
   * The proof the parent asked for, at the one moment the chat is known
   * reachable. Sent from here rather than by the digest cron because the cron
   * honours DIGEST_DRY_RUN, has an in-process single-run guard, correctly sends
   * nothing on a quiet day, and would consume the dedup claims the 13:00 run
   * needs -- any of which would leave the parent staring at a silent Telegram
   * concluding the link failed.
   */
  private async sendConfirmation(
    codeRowId: string,
    chatId: string,
    studentGuids: string[],
    now: Date,
  ): Promise<void> {
    const students =
      studentGuids.length > 0
        ? await this.prisma.student.findMany({
            where: { studentGuid: { in: studentGuids } },
            select: { studentGuid: true, privateName: true },
          })
        : [];
    const names = students.map((student) => student.privateName).filter(Boolean);

    const text =
      names.length > 0
        ? `הטלגרם שלכם מחובר ✅\n` +
          `מעכשיו תקבלו כאן עדכון יומי על ${names.join(' ו')} — רק בימים שבהם באמת קרה משהו.\n` +
          `אפשר לכבות או להוסיף ילדים בכל רגע במסך "עוד" באפליקציה.`
        : `הטלגרם שלכם מחובר ✅\n` +
          `לא הצלחנו לרשום אף ילד כרגע. פתחו את מסך "עוד" באפליקציה ובחרו מי שתרצו לקבל עליו עדכונים.`;

    try {
      await this.sender.send(chatId, text);
      await this.prisma.telegramLinkCode.update({
        where: { id: codeRowId },
        data: { confirmationSentAt: now, confirmationError: null },
      });
    } catch (error) {
      // The rows are written and the code is spent. A failed confirmation is
      // something the wizard shows the parent, not something that unwinds a
      // link that otherwise worked.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Telegram link confirmation failed: ${message}`);
      await this.prisma.telegramLinkCode.update({
        where: { id: codeRowId },
        data: { confirmationSentAt: null, confirmationError: message },
      });
    }
  }

  /** A courtesy message to a chat we are not binding. Never fatal. */
  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.sender.send(chatId, text);
    } catch (error) {
      this.logger.warn(
        `Could not answer Telegram chat: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private ttlMinutes(): number {
    const raw = Number(this.config.get<string>('TELEGRAM_LINK_CODE_TTL_MINUTES'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MINUTES;
  }

  /**
   * The same two flags `DigestService` reads, with the same defaults: off, and
   * dry-run unless explicitly told otherwise, so a first deploy cannot message
   * a parent by accident.
   */
  private isDeliveryEnabled(): boolean {
    const enabled =
      String(this.config.get<string | boolean>('DIGEST_ENABLED') ?? 'false')
        .trim()
        .toLowerCase() === 'true';
    if (!enabled) return false;

    const dryRun = this.config.get<string | boolean>('DIGEST_DRY_RUN');
    if (dryRun === undefined || dryRun === null || dryRun === '') return false;
    return String(dryRun).trim().toLowerCase() === 'false';
  }
}
