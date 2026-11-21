/**
 * Parent-driven Telegram linking — integration tests.
 *
 * These run against a real Postgres because every guarantee being proved here
 * is a database-level one that a mocked Prisma cannot show:
 *
 *  1. A START binds the chat and writes one recipient row per chosen child,
 *     through the `@@unique([studentGuid, channel, address])` upsert.
 *  2. A replayed START changes nothing. Telegram retains unconfirmed updates
 *     for 24 hours and the poller's offset is in memory, so reprocessing is not
 *     a hypothetical — it is what a restart does. The single conditional
 *     `UPDATE ... WHERE consumed_at IS NULL` is the whole mechanism, and under
 *     genuine concurrency only the constraint can be asked to prove it.
 *  3. A second parent cannot mint a link for the first parent's child, nor
 *     create a recipient row for them. That is the ADR-0026 hole ADR-0033
 *     closes, and it is a join across `StudentConnection` — exactly the edge a
 *     unit test with a hand-stubbed `canSeeStudent` cannot exercise.
 *  4. A child who leaves the roster between minting and START is skipped
 *     rather than failing the whole link.
 *
 * No network call is made: the client and the sender are both stubbed, so
 * nothing here depends on a bot token existing.
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '../../backend/node_modules/@nestjs/common';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { TelegramLinkService } from '../../backend/src/telegram/telegram-link.service';
import { DigestRecipientService } from '../../backend/src/digest/digest-recipient.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { ConfigService } from '../../backend/node_modules/@nestjs/config';
import type { TelegramClient } from '../../backend/src/telegram/telegram.client';
import type { TelegramSender } from '../../backend/src/digest/senders/telegram.sender';

const PARENT_A = 'tg-user-a';
const PARENT_B = 'tg-user-b';
const CONN_A = 'tg-conn-a';
const CONN_B = 'tg-conn-b';
const CHILD_A1 = 'tg-child-a1';
const CHILD_A2 = 'tg-child-a2';
const CHILD_B1 = 'tg-child-b1';
const CHAT_ID = '555000111';

const USER_IDS = [PARENT_A, PARENT_B];
const GUIDS = [CHILD_A1, CHILD_A2, CHILD_B1];

/** Records what would have been delivered, so assertions can read the text. */
class CapturingSender {
  readonly channel = 'telegram';
  readonly sent: { address: string; text: string }[] = [];
  shouldFail = false;

  async send(address: string, text: string): Promise<void> {
    if (this.shouldFail) throw new Error('Telegram send failed: chat not found');
    this.sent.push({ address, text });
  }
}

function startUpdate(code: string, chatId: string = CHAT_ID) {
  return { update_id: 1, message: { chat: { id: chatId }, text: `/start ${code}` } };
}

describe('Parent-driven Telegram linking', () => {
  let prisma: PrismaClient;
  let links: TelegramLinkService;
  let recipients: DigestRecipientService;
  let sender: CapturingSender;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.digestRecipient.deleteMany({ where: { userId: { in: USER_IDS } } });
    await prisma.telegramLinkCode.deleteMany({ where: { userId: { in: USER_IDS } } });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.householdConnection.deleteMany({ where: { id: { in: [CONN_A, CONN_B] } } });
    await prisma.appUser.deleteMany({ where: { id: { in: USER_IDS } } });

    let index = 0;
    for (const userId of USER_IDS) {
      index += 1;
      await prisma.appUser.create({
        data: {
          id: userId,
          mashovUserId: `tg-mashov-${index}`,
          semel: 990000 + index,
          username: userId,
          displayName: userId,
        },
      });
    }

    for (const [id, userId, schoolCode] of [
      [CONN_A, PARENT_A, 111111],
      [CONN_B, PARENT_B, 222222],
    ] as const) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId,
          schoolCode,
          schoolYear: 2027,
          username: `${userId}-login`,
          encryptedPassword: 'not-a-real-secret',
          active: true,
        },
      });
    }

    for (const [guid, connectionId, privateName] of [
      [CHILD_A1, CONN_A, 'אבי'],
      [CHILD_A2, CONN_A, 'נועה'],
      [CHILD_B1, CONN_B, 'דנה'],
    ] as const) {
      await prisma.student.create({
        data: {
          studentGuid: guid,
          privateName,
          familyName: 'כהן',
          fullName: `${privateName} כהן`,
          classCode: 'ג',
          classNum: 3,
          gender: 'M',
          isActive: true,
        },
      });
      await prisma.studentConnection.create({
        data: {
          studentGuid: guid,
          householdConnectionId: connectionId,
          firstSeenAt: new Date(),
          lastSeenInRosterAt: new Date(),
        },
      });
    }

    const prismaService = prisma as unknown as PrismaService;
    const config = { get: () => undefined } as unknown as ConfigService;
    const client = {
      hasToken: () => true,
      getMe: async () => 'mashov_test_bot',
    } as unknown as TelegramClient;
    sender = new CapturingSender();

    links = new TelegramLinkService(
      prismaService,
      config,
      client,
      sender as unknown as TelegramSender,
    );
    recipients = new DigestRecipientService(prismaService);
  });

  describe('linking', () => {
    it('binds the chat and subscribes every chosen child', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1, CHILD_A2]);

      await links.consume(startUpdate(minted.code));

      const rows = await prisma.digestRecipient.findMany({
        where: { userId: PARENT_A },
        orderBy: { studentGuid: 'asc' },
      });
      expect(rows.map((row) => row.studentGuid)).toEqual([CHILD_A1, CHILD_A2]);
      expect(rows.every((row) => row.channel === 'telegram' && row.address === CHAT_ID)).toBe(
        true,
      );
      expect(rows.every((row) => row.enabled)).toBe(true);
    });

    it('marks the code consumed and records the chat it bound', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1]);

      await links.consume(startUpdate(minted.code));

      const row = await prisma.telegramLinkCode.findUnique({ where: { code: minted.code } });
      expect(row?.consumedAt).not.toBeNull();
      expect(row?.chatId).toBe(CHAT_ID);
    });

    it('sends the confirmation and records that it went out', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1]);

      await links.consume(startUpdate(minted.code));

      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].address).toBe(CHAT_ID);
      expect(sender.sent[0].text).toContain('אבי');

      const row = await prisma.telegramLinkCode.findUnique({ where: { code: minted.code } });
      expect(row?.confirmationSentAt).not.toBeNull();
      expect(row?.confirmationError).toBeNull();
    });

    it('keeps the link when the confirmation cannot be delivered', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1]);
      sender.shouldFail = true;

      await links.consume(startUpdate(minted.code));

      const row = await prisma.telegramLinkCode.findUnique({ where: { code: minted.code } });
      expect(row?.consumedAt).not.toBeNull();
      expect(row?.confirmationError).toContain('chat not found');
      expect(await prisma.digestRecipient.count({ where: { userId: PARENT_A } })).toBe(1);
    });

    it('reports the link as linked once the START has landed', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1, CHILD_A2]);
      await links.consume(startUpdate(minted.code));

      const state = await links.statusFor(PARENT_A, minted.code);

      expect(state.status).toBe('linked');
      expect(state.recipientCount).toBe(2);
      expect(state.confirmationSent).toBe(true);
    });
  });

  describe('replay', () => {
    it('changes nothing when the same START arrives twice', async () => {
      // What a restarted poller does: its offset is in memory, and Telegram
      // keeps unconfirmed updates for 24 hours.
      const minted = await links.mint(PARENT_A, [CHILD_A1]);
      await links.consume(startUpdate(minted.code));
      const first = await prisma.telegramLinkCode.findUnique({ where: { code: minted.code } });

      await links.consume(startUpdate(minted.code));

      const second = await prisma.telegramLinkCode.findUnique({ where: { code: minted.code } });
      expect(second?.consumedAt?.toISOString()).toBe(first?.consumedAt?.toISOString());
      expect(await prisma.digestRecipient.count({ where: { userId: PARENT_A } })).toBe(1);
      // One confirmation, plus one courtesy "already connected" reply.
      expect(sender.sent).toHaveLength(2);
    });

    it('claims the code exactly once when two STARTs race', async () => {
      // The conditional UPDATE is the whole single-use mechanism. ADR-0017
      // rules out a Redis lock, so there is nothing else holding the line.
      const minted = await links.mint(PARENT_A, [CHILD_A1]);

      await Promise.all([
        links.consume(startUpdate(minted.code)),
        links.consume(startUpdate(minted.code)),
      ]);

      expect(await prisma.digestRecipient.count({ where: { userId: PARENT_A } })).toBe(1);
      const row = await prisma.telegramLinkCode.findUnique({ where: { code: minted.code } });
      expect(row?.consumedAt).not.toBeNull();
    });

    it('does not bind a second chat to a code the first chat already used', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1]);
      await links.consume(startUpdate(minted.code, CHAT_ID));

      await links.consume(startUpdate(minted.code, '999888777'));

      const rows = await prisma.digestRecipient.findMany({ where: { userId: PARENT_A } });
      expect(rows.map((row) => row.address)).toEqual([CHAT_ID]);
    });
  });

  describe('cross-household refusal', () => {
    it("refuses to mint a link for another parent's child", async () => {
      await expect(links.mint(PARENT_B, [CHILD_A1])).rejects.toThrow(ForbiddenException);
      expect(await prisma.telegramLinkCode.count({ where: { userId: PARENT_B } })).toBe(0);
    });

    it("refuses to create a recipient row for another parent's child", async () => {
      // ADR-0026 accepted this hole while recipients were operator-only rows;
      // ADR-0033 closes it.
      await expect(
        recipients.create(PARENT_B, {
          studentGuid: CHILD_A1,
          channel: 'telegram',
          address: CHAT_ID,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(await prisma.digestRecipient.count({ where: { userId: PARENT_B } })).toBe(0);
    });

    it('lets each parent link their own child', async () => {
      const a = await links.mint(PARENT_A, [CHILD_A1]);
      const b = await links.mint(PARENT_B, [CHILD_B1]);

      await links.consume(startUpdate(a.code, '111'));
      await links.consume(startUpdate(b.code, '222'));

      expect(
        (await prisma.digestRecipient.findMany({ where: { userId: PARENT_A } })).map(
          (row) => row.studentGuid,
        ),
      ).toEqual([CHILD_A1]);
      expect(
        (await prisma.digestRecipient.findMany({ where: { userId: PARENT_B } })).map(
          (row) => row.studentGuid,
        ),
      ).toEqual([CHILD_B1]);
    });

    it("refuses to read another parent's link status", async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1]);

      // Asserted by type, not by message: Nest renders an object body as the
      // generic "Not Found Exception", so the text would prove nothing.
      await expect(links.statusFor(PARENT_B, minted.code)).rejects.toThrow(NotFoundException);
    });
  });

  describe('a child who leaves between minting and START', () => {
    it('subscribes the children who remain rather than failing the link', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1, CHILD_A2]);
      // The roster moves on: this child is now listed only by the other
      // household's connection.
      await prisma.studentConnection.deleteMany({ where: { studentGuid: CHILD_A2 } });
      await prisma.studentConnection.create({
        data: {
          studentGuid: CHILD_A2,
          householdConnectionId: CONN_B,
          firstSeenAt: new Date(),
          lastSeenInRosterAt: new Date(),
        },
      });

      await links.consume(startUpdate(minted.code));

      const rows = await prisma.digestRecipient.findMany({ where: { userId: PARENT_A } });
      expect(rows.map((row) => row.studentGuid)).toEqual([CHILD_A1]);
      expect(sender.sent).toHaveLength(1);
    });
  });


  describe('an unattributed child belongs to nobody (review finding 1)', () => {
    it('refuses to mint for a child no connection lists', async () => {
      // The exact repro from the whole-branch review: canSeeStudent admits an
      // unlinked child, so before ownsStudentForDelivery existed, PARENT_A
      // could mint for PARENT_B's child simply by catching it between roster
      // syncs -- and would then receive that child's conduct digests daily.
      await prisma.studentConnection.deleteMany({ where: { studentGuid: CHILD_B1 } });

      await expect(links.mint(PARENT_A, [CHILD_B1])).rejects.toThrow(ForbiddenException);
      expect(await prisma.telegramLinkCode.count({ where: { userId: PARENT_A } })).toBe(0);
    });

    it("refuses to create a recipient row for a child no connection lists", async () => {
      await prisma.studentConnection.deleteMany({ where: { studentGuid: CHILD_B1 } });

      await expect(
        recipients.create(PARENT_A, {
          studentGuid: CHILD_B1,
          channel: 'telegram',
          address: CHAT_ID,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('skips a child whose links vanish between minting and START', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1, CHILD_A2]);
      await prisma.studentConnection.deleteMany({ where: { studentGuid: CHILD_A2 } });

      await links.consume(startUpdate(minted.code));

      const rows = await prisma.digestRecipient.findMany({ where: { userId: PARENT_A } });
      expect(rows.map((row) => row.studentGuid)).toEqual([CHILD_A1]);
    });
  });

  describe('the roster is checked on this path too (review finding 2)', () => {
    it('refuses a guid that names no student at all', async () => {
      // digest_recipient has no FK on studentGuid, so nothing in the database
      // would have caught this.
      await expect(links.mint(PARENT_A, ['no-such-child'])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a child who has been retired from the roster', async () => {
      await prisma.student.update({
        where: { studentGuid: CHILD_A1 },
        data: { isActive: false },
      });

      await expect(links.mint(PARENT_A, [CHILD_A1])).rejects.toThrow(BadRequestException);
    });
  });

  describe('only a private chat is bound (review finding 3)', () => {
    it('refuses a group chat, which a forwarded deep link would reach', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1]);

      await links.consume({
        update_id: 1,
        message: {
          chat: { id: -1001234567890, type: 'supergroup' },
          text: `/start@mashov_test_bot ${minted.code}`,
        },
      });

      expect(await prisma.digestRecipient.count({ where: { userId: PARENT_A } })).toBe(0);
      const row = await prisma.telegramLinkCode.findUnique({ where: { code: minted.code } });
      expect(row?.consumedAt).toBeNull();
    });

    it('leaves the code usable afterwards, so the parent can still link', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1]);
      await links.consume({
        update_id: 1,
        message: { chat: { id: -100123, type: 'group' }, text: `/start ${minted.code}` },
      });

      await links.consume(startUpdate(minted.code));

      expect(await prisma.digestRecipient.count({ where: { userId: PARENT_A } })).toBe(1);
    });
  });

  describe('the expiry is enforced by the database, not only by a mock', () => {
    it('refuses a code whose expiresAt has passed', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1]);
      await prisma.telegramLinkCode.update({
        where: { code: minted.code },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await links.consume(startUpdate(minted.code));

      expect(await prisma.digestRecipient.count({ where: { userId: PARENT_A } })).toBe(0);
      const row = await prisma.telegramLinkCode.findUnique({ where: { code: minted.code } });
      expect(row?.consumedAt).toBeNull();
    });

    it('reports that code as expired to the wizard', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1]);
      await prisma.telegramLinkCode.update({
        where: { code: minted.code },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      expect((await links.statusFor(PARENT_A, minted.code)).status).toBe('expired');
    });
  });

  describe('disconnect', () => {
    it('removes every telegram row and every code the parent had', async () => {
      const minted = await links.mint(PARENT_A, [CHILD_A1, CHILD_A2]);
      await links.consume(startUpdate(minted.code));

      const removed = await links.disconnect(PARENT_A);

      expect(removed).toBe(2);
      expect(await prisma.digestRecipient.count({ where: { userId: PARENT_A } })).toBe(0);
      expect(await prisma.telegramLinkCode.count({ where: { userId: PARENT_A } })).toBe(0);
    });

    it('leaves the other household alone', async () => {
      const b = await links.mint(PARENT_B, [CHILD_B1]);
      await links.consume(startUpdate(b.code, '222'));

      await links.disconnect(PARENT_A);

      expect(await prisma.digestRecipient.count({ where: { userId: PARENT_B } })).toBe(1);
    });
  });
});
