/**
 * Per-user digest isolation — integration tests.
 *
 * A digest run used to be one per child, which in a household where both
 * parents subscribe meant one dedup ledger, one delivery row and one rendered
 * message between them. Every guarantee that replaced it is a database-level
 * one that a mocked Prisma cannot show:
 *
 *  1. Two parents of one child each get their own message, and the ledger
 *     holds a row per parent per item — the unique key carries the userId, so
 *     the constraint itself is what makes the second claim possible.
 *  2. One parent's failed send releases only their own claims, so the retry
 *     reaches them and nobody else.
 *  3. One parent's completed run does not suppress the other's first run, and
 *     one parent's abandoned claim is invisible to the other's takeover. Both
 *     are predicate scoping that only real rows can prove.
 *  4. A consent form reaches the parent whose form it is, once across their
 *     children — the dedup for forms deliberately omits studentGuid, so the
 *     userId is the only thing keeping it inside one household.
 *  5. `GET /digest/deliveries` answers with one parent's own runs, never the
 *     other parent's rendered message.
 *  6. The migration backfills and copies as designed, twice over.
 *
 * No model is called: with no ANTHROPIC_API_KEY the summarizer renders the
 * deterministic Hebrew fallback.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { DigestService } from '../../backend/src/digest/digest.service';
import { DigestCheckerService, STALE_CLAIM_MS } from '../../backend/src/digest/digest-checker.service';
import { DigestCollectorService } from '../../backend/src/digest/digest-collector.service';
import { DigestDismissalService } from '../../backend/src/digest/digest-dismissal.service';
import { DigestDeadlineService } from '../../backend/src/digest/digest-deadline.service';
import { DigestSummarizerService } from '../../backend/src/digest/digest-summarizer.service';
import { DigestRecipientService } from '../../backend/src/digest/digest-recipient.service';
import { DigestAttachmentResolver } from '../../backend/src/digest/digest-attachment.resolver';
import { jerusalemDayBounds } from '../../backend/src/digest/digest-deadline.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { ConfigService } from '../../backend/node_modules/@nestjs/config';
import type { SchoolYearService } from '../../backend/src/common/school-year/school-year.service';
import type { DigestSender } from '../../backend/src/digest/senders/digest-sender.interface';

const MUM = 'iso-user-mum';
const DAD = 'iso-user-dad';
const CONN_MUM = 'iso-conn-mum';
const CONN_DAD = 'iso-conn-dad';
/** Both parents' connections list this child. */
const SHARED = 'iso-child-shared';
/** Only the mother's connection lists this one. */
const MUM_ONLY = 'iso-child-mum-only';

const CHAT_MUM = 'chat-mum';
const CHAT_DAD = 'chat-dad';

const USER_IDS = [MUM, DAD];
const GUIDS = [SHARED, MUM_ONLY];
const SCHOOL_YEAR = 2027;
const TIMEZONE = 'Asia/Jerusalem';

const NOW = new Date();
const { todayStart } = jerusalemDayBounds(NOW, TIMEZONE);
const LONG_AGO = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);
/** Mum opted in first; dad a week later. Both long before anything seeded. */
const MUM_SUBSCRIBED = LONG_AGO;
const DAD_SUBSCRIBED = new Date(LONG_AGO.getTime() + 7 * 24 * 60 * 60 * 1000);

function migrationFile(): string {
  return path.join(
    __dirname,
    '../../backend/prisma/migrations/20261124000000_digest_per_user/migration.sql',
  );
}

/**
 * Splits the migration into executable statements, respecting `DO $$ ... $$`.
 *
 * `backfill-school-year`'s `parseSqlStatements` splits on every semicolon,
 * which would shred this file's dollar-quoted blocks into invalid fragments.
 */
function sqlStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;

  for (let i = 0; i < withoutComments.length; i += 1) {
    if (withoutComments.startsWith('$$', i)) {
      inDollarQuote = !inDollarQuote;
      current += '$$';
      i += 1;
      continue;
    }
    const char = withoutComments[i];
    if (char === ';' && !inDollarQuote) {
      statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) statements.push(current.trim());

  return statements.filter((statement) => statement.length > 0);
}

/** Captures deliveries, and can be told which chat is unreachable. */
class CapturingSender implements DigestSender {
  readonly channel = 'telegram';
  readonly sent: { address: string; text: string }[] = [];
  failFor: string | null = null;

  async send(address: string, text: string): Promise<void> {
    if (this.failFor === address) {
      // Transient on purpose. A permanent refusal ("bot was blocked by the
      // user", "chat not found") confirms the claims and disables the
      // recipient instead of releasing, so it would prove the opposite of
      // what the retry test below is about.
      throw new Error('Telegram send failed: HTTP 502');
    }
    this.sent.push({ address, text });
  }

  textsTo(address: string): string[] {
    return this.sent.filter((entry) => entry.address === address).map((entry) => entry.text);
  }
}

/**
 * This fixture's own runs.
 *
 * The suites share one database and the cron deliberately runs every opted-in
 * child, so an unscoped `runAll` also picks up whatever another suite left
 * subscribed. Filtering here keeps that from reading as a failure.
 */
function ours<T extends { studentGuid: string }>(results: T[]): T[] {
  return results.filter((result) => GUIDS.includes(result.studentGuid));
}

function makeConfig(): ConfigService {
  const values: Record<string, string> = {
    DIGEST_TIMEZONE: TIMEZONE,
    DIGEST_DRY_RUN: 'false',
    DIGEST_DUE_LOOKBACK_DAYS: '14',
    DIGEST_ACTIVITY_WINDOW_DAYS: '7',
    // Deliberately absent: ANTHROPIC_API_KEY.
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function makeService(prisma: PrismaClient, sender: DigestSender) {
  const prismaService = prisma as unknown as PrismaService;
  const config = makeConfig();
  const schoolYear = {
    currentSchoolYearFor: async () => SCHOOL_YEAR,
  } as unknown as SchoolYearService;
  const deadlines = new DigestDeadlineService(prismaService);

  return new DigestService(
    prismaService,
    config,
    schoolYear,
    new DigestCheckerService(prismaService, config, deadlines),
    new DigestCollectorService(prismaService),
    new DigestSummarizerService(config),
    new DigestRecipientService(prismaService),
    // The real service against the real database: these fixtures seed no
    // timetable rows, so the gate opens for every child and the suite reads
    // exactly as it did before the gate existed (ADR-0040).
    new DigestDismissalService(prismaService, config),
    sender,
    sender,
    new DigestAttachmentResolver(prismaService),
    // No media binding: these tests are about the ledger and the text, and the
    // @Optional() injection falls back to the no-op, so nothing is downloaded
    // or uploaded. src/telegram-media/** has its own specs.
  );
}

describe('Per-user digest isolation', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    // Torn down, not just set up. The suites share one database and the cron
    // deliberately runs every opted-in child, so a recipient row left behind
    // here makes the NEXT suite's unscoped `runAll` send this fixture's
    // messages and fail on the count.
    await wipe();
    await prisma.$disconnect();
  });

  beforeEach(wipe);

  async function wipe(): Promise<void> {
    await prisma.digestReportedItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.digestDelivery.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.digestRecipient.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.behaviorItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.schoolActivity.deleteMany({ where: { userId: { in: USER_IDS } } });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.householdConnection.deleteMany({
      where: { id: { in: [CONN_MUM, CONN_DAD] } },
    });
    await prisma.appUser.deleteMany({ where: { id: { in: USER_IDS } } });
    // Each migration test simulates a fresh deploy, and the ledger copy is
    // guarded by a marker row that is deliberately permanent in production.
    await prisma.dataBackfill.deleteMany({
      where: { id: 'digest-per-user-ledger-copy' },
    });
  }

  beforeEach(async () => {
    let index = 0;
    for (const userId of USER_IDS) {
      index += 1;
      await prisma.appUser.create({
        data: {
          id: userId,
          mashovUserId: `iso-mashov-${index}`,
          semel: 997700 + index,
          username: userId,
          displayName: userId,
        },
      });
    }

    // Two parents, their own Mashov accounts, the same school (ADR-0031).
    for (const [id, userId] of [
      [CONN_MUM, MUM],
      [CONN_DAD, DAD],
    ] as const) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId,
          schoolCode: 997788,
          schoolYear: SCHOOL_YEAR,
          username: `${userId}-login`,
          encryptedPassword: 'not-a-real-secret',
          active: true,
        },
      });
    }

    for (const [guid, privateName] of [
      [SHARED, 'אבי'],
      [MUM_ONLY, 'נועה'],
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
    }

    for (const [guid, connectionId] of [
      [SHARED, CONN_MUM],
      [SHARED, CONN_DAD],
      [MUM_ONLY, CONN_MUM],
    ] as const) {
      await prisma.studentConnection.create({
        data: {
          studentGuid: guid,
          householdConnectionId: connectionId,
          firstSeenAt: new Date(),
          lastSeenInRosterAt: new Date(),
        },
      });
    }

    // Distinct activeFrom values, so "earliest subscriber" is decided by the
    // column the code orders on rather than by a cuid tiebreak.
    for (const [userId, guid, address, activeFrom] of [
      [MUM, SHARED, CHAT_MUM, MUM_SUBSCRIBED],
      [DAD, SHARED, CHAT_DAD, DAD_SUBSCRIBED],
      [MUM, MUM_ONLY, CHAT_MUM, MUM_SUBSCRIBED],
    ] as const) {
      await prisma.digestRecipient.create({
        data: { userId, studentGuid: guid, channel: 'telegram', address, activeFrom },
      });
    }

    // One behaviour event per child, today: the news both parents are owed.
    let lessonId = 7000;
    for (const guid of GUIDS) {
      lessonId += 1;
      await prisma.behaviorItem.create({
        data: {
          studentGuid: guid,
          schoolYear: SCHOOL_YEAR,
          lessonId,
          groupId: 70,
          eventCode: 11,
          achvaCode: 1,
          achvaName: 'איחור',
          classification: 'negative',
          justifiable: true,
          lessonDate: todayStart,
          lesson: 2,
          subject: 'מתמטיקה',
          reporter: 'מורה רחל לוי',
          remark: 'הגיע באיחור של 10 דקות',
          eventAt: new Date(todayStart.getTime() + 11 * 60 * 60 * 1000),
        },
      });
    }
  });

  it('tells both parents of a shared child, each from their own ledger', async () => {
    const sender = new CapturingSender();

    const results = ours(await makeService(prisma, sender).runAll({ now: NOW }));

    // Mum has two children, dad has one: three runs, not two.
    expect(results).toHaveLength(3);
    expect(results.map((result) => `${result.userId}/${result.studentGuid}`).sort()).toEqual([
      `${DAD}/${SHARED}`,
      `${MUM}/${MUM_ONLY}`,
      `${MUM}/${SHARED}`,
    ]);
    expect(sender.textsTo(CHAT_DAD)).toHaveLength(1);
    expect(sender.textsTo(CHAT_MUM)).toHaveLength(2);

    // One ledger row per parent per item, which the widened unique key is
    // what permits -- before it, the second claim was a duplicate and lost.
    const rows = await prisma.digestReportedItem.findMany({
      where: { studentGuid: SHARED },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort()).toEqual([DAD, MUM]);
    expect(rows.every((row) => row.confirmedAt !== null)).toBe(true);
  });

  it('says nothing the second time it runs', async () => {
    const sender = new CapturingSender();
    const service = makeService(prisma, sender);

    await service.runAll({ now: NOW });
    const second = ours(await service.runAll({ now: NOW }));

    expect(sender.textsTo(CHAT_MUM)).toHaveLength(2);
    expect(sender.textsTo(CHAT_DAD)).toHaveLength(1);
    expect(second.every((result) => result.status === 'skipped_empty')).toBe(true);
  });

  it('retries only the parent whose send failed', async () => {
    const sender = new CapturingSender();
    sender.failFor = CHAT_DAD;

    const first = ours(await makeService(prisma, sender).runAll({ now: NOW }));

    expect(first.find((result) => result.userId === DAD)?.status).toBe('failed');
    // Mum's claim is confirmed; dad's is released, so it comes back.
    const afterFirst = await prisma.digestReportedItem.findMany({
      where: { studentGuid: SHARED },
    });
    expect(afterFirst.map((row) => row.userId)).toEqual([MUM]);

    const retry = new CapturingSender();
    const second = ours(await makeService(prisma, retry).runAll({ now: NOW }));

    expect(retry.textsTo(CHAT_DAD)).toHaveLength(1);
    // Mum is not told the same thing twice because dad's send failed.
    expect(retry.textsTo(CHAT_MUM)).toHaveLength(0);
    expect(second.find((result) => result.userId === DAD)?.status).toBe('sent');
  });

  it('does not let one parent’s completed run suppress the other’s first', async () => {
    const sender = new CapturingSender();
    const service = makeService(prisma, sender);

    await service.runAll({ now: NOW, userId: MUM });
    await service.runAll({ now: NOW, userId: DAD });

    expect(sender.textsTo(CHAT_MUM)).toHaveLength(2);
    expect(sender.textsTo(CHAT_DAD)).toHaveLength(1);
  });

  it('leaves another parent’s abandoned claim for that parent’s own run', async () => {
    // An unconfirmed claim past the staleness window is a run that died
    // before sending, and the takeover is the one claim write not already
    // scoped by claimedBy. Unscoped, mum's run restamps dad's row -- and
    // dad's own confirm then matches nothing, so he is told the same thing
    // again half an hour later.
    //
    // Dad's row is produced by a real run of his, so it carries the content
    // hash mum's run will really compute. A hand-written hash would not be in
    // the `contentHash: { in: hashes }` list the takeover filters on, and the
    // assertion would hold whether or not the predicate is scoped by user.
    await makeService(prisma, new CapturingSender()).runAll({ now: NOW, userId: DAD });
    const dadsRows = await prisma.digestReportedItem.findMany({
      where: { userId: DAD, studentGuid: SHARED },
    });
    expect(dadsRows).toHaveLength(1);

    // Forced back to how a run that died between claiming and sending leaves
    // it: claimed long enough ago to be stale, never confirmed.
    const zombie = await prisma.digestReportedItem.update({
      where: { id: dadsRows[0].id },
      data: {
        claimedAt: new Date(NOW.getTime() - STALE_CLAIM_MS - 60_000),
        claimedBy: 'dad-run-that-died',
        confirmedAt: null,
      },
    });

    await makeService(prisma, new CapturingSender()).runAll({ now: NOW, userId: MUM });

    const after = await prisma.digestReportedItem.findUnique({ where: { id: zombie.id } });
    expect(after?.claimedBy).toBe('dad-run-that-died');
    expect(after?.confirmedAt).toBeNull();
    expect(after?.claimedAt).toEqual(zombie.claimedAt);
  });

  it('reports a consent form to the parent whose form it is, and to nobody else', async () => {
    await prisma.schoolActivity.create({
      data: {
        userId: MUM,
        householdConnectionId: CONN_MUM,
        activityId: 4242,
        schoolYear: SCHOOL_YEAR,
        title: 'טיול שנתי לגליל',
        activityStartDate: new Date(todayStart.getTime() + 10 * 24 * 60 * 60 * 1000),
        activityEndDate: new Date(todayStart.getTime() + 11 * 24 * 60 * 60 * 1000),
        endAnswerDate: new Date(todayStart.getTime() + 3 * 24 * 60 * 60 * 1000),
        isAnswered: false,
      },
    });
    const sender = new CapturingSender();

    await makeService(prisma, sender).runAll({ now: NOW });

    // Once across mum's two children: the form belongs to her, not to either
    // of them, so the dedup for it deliberately ignores studentGuid.
    const mumMentions = sender
      .textsTo(CHAT_MUM)
      .filter((text) => text.includes('טיול שנתי לגליל'));
    expect(mumMentions).toHaveLength(1);
    // And never in dad's message, which is what the single per-child run used
    // to get wrong: he was told forms awaited his answer that were not his.
    expect(sender.textsTo(CHAT_DAD).join('\n')).not.toContain('טיול שנתי לגליל');
  });

  it('never shows one parent the message the other parent was sent', async () => {
    // Scoping the history by child let the second parent of a shared child
    // read the first parent's rendered message -- which now carries the first
    // parent's own unanswered consent forms. A form is what makes the two
    // messages distinguishable, so it is what this asserts on.
    await prisma.schoolActivity.create({
      data: {
        userId: MUM,
        householdConnectionId: CONN_MUM,
        activityId: 4343,
        schoolYear: SCHOOL_YEAR,
        title: 'הצגה בתיאטרון הקאמרי',
        activityStartDate: new Date(todayStart.getTime() + 10 * 24 * 60 * 60 * 1000),
        activityEndDate: new Date(todayStart.getTime() + 11 * 24 * 60 * 60 * 1000),
        endAnswerDate: new Date(todayStart.getTime() + 3 * 24 * 60 * 60 * 1000),
        isAnswered: false,
      },
    });
    await makeService(prisma, new CapturingSender()).runAll({ now: NOW });
    const recipients = new DigestRecipientService(prisma as unknown as PrismaService);

    const dadsHistory = await recipients.listDeliveries(DAD, { limit: 100 });

    expect(dadsHistory.data.length).toBeGreaterThan(0);
    expect(dadsHistory.data.every((row) => row.userId === DAD)).toBe(true);
    expect(dadsHistory.data.map((row) => row.messageText).join('\n')).not.toContain(
      'הצגה בתיאטרון הקאמרי',
    );

    // And mum's own history does have it, so the scoping is not just empty.
    const mumsHistory = await recipients.listDeliveries(MUM, { limit: 100 });
    expect(mumsHistory.data.map((row) => row.messageText).join('\n')).toContain(
      'הצגה בתיאטרון הקאמרי',
    );
  });

  it('leaves a trail when a parent’s ownership of a child has ended', async () => {
    // The adoption path repoints a connection to another AppUser and leaves
    // the old owner's recipient rows behind, so the send-time guard is what
    // stops the digest. Without a row for it, that parent's history just ends
    // and support has nothing to look at.
    await prisma.studentConnection.deleteMany({
      where: { studentGuid: SHARED, householdConnectionId: CONN_DAD },
    });
    const sender = new CapturingSender();

    const results = ours(await makeService(prisma, sender).runAll({ now: NOW }));

    // Mum is unaffected; dad's run is recorded as refused and sends nothing.
    expect(sender.textsTo(CHAT_DAD)).toHaveLength(0);
    expect(sender.textsTo(CHAT_MUM)).toHaveLength(2);
    expect(results.find((result) => result.userId === DAD)).toMatchObject({
      studentGuid: SHARED,
      status: 'skipped_unowned',
    });

    const recipients = new DigestRecipientService(prisma as unknown as PrismaService);
    const dadsHistory = await recipients.listDeliveries(DAD, { limit: 100 });
    expect(dadsHistory.data.map((row) => row.status)).toEqual(['skipped_unowned']);
    expect(dadsHistory.data[0].errorMessage).toMatch(/no longer owns/i);
    // Nothing was mutated: revocation is the unlink path's job, and a
    // transient roster gap must not delete a subscription.
    expect(
      await prisma.digestRecipient.count({ where: { userId: DAD, studentGuid: SHARED } }),
    ).toBe(1);
  });

  it('records that refusal once a day, however many times the cron runs', async () => {
    await prisma.studentConnection.deleteMany({
      where: { studentGuid: SHARED, householdConnectionId: CONN_DAD },
    });
    const service = makeService(prisma, new CapturingSender());

    await service.runAll({ now: NOW });
    await service.runAll({ now: NOW });

    const rows = await prisma.digestDelivery.findMany({
      where: { userId: DAD, studentGuid: SHARED },
    });
    expect(rows).toHaveLength(1);
  });

  describe('the per-user migration', () => {
    /** Executes the file, statement by statement, `times` times over. */
    async function runMigration(times: number): Promise<number> {
      const statements = sqlStatements(fs.readFileSync(migrationFile(), 'utf-8'));
      expect(statements.length).toBeGreaterThan(5);
      for (let pass = 0; pass < times; pass += 1) {
        for (const statement of statements) {
          await prisma.$executeRawUnsafe(statement);
        }
      }
      return statements.length;
    }

    /**
     * The pre-deploy state: ledger and delivery rows with no owner, which is
     * what `prisma db push` leaves behind when it adds the columns.
     */
    async function seedPreState(options: { toggledOff?: string } = {}): Promise<void> {
      // One of the two chats is off. By default it is dad's, the LATER
      // subscriber, so mum -- earliest and enabled -- is the owner the
      // pre-deploy code would have used, and dad's rows are the copy.
      await prisma.digestRecipient.updateMany({
        where: { userId: options.toggledOff ?? DAD, studentGuid: SHARED },
        data: { enabled: false },
      });

      for (const [itemType, itemId, contentHash, confirmed] of [
        ['behavior', 'beh-1', 'pre-hash-beh', true],
        ['homework_new', 'hw-1', 'pre-hash-hw', true],
        ['activity', '4242', 'pre-hash-activity', true],
        ['behavior', 'beh-2', 'pre-hash-inflight', false],
      ] as const) {
        await prisma.digestReportedItem.create({
          data: {
            userId: '',
            studentGuid: SHARED,
            itemType,
            itemId,
            contentHash,
            reportedFor: todayStart,
            confirmedAt: confirmed ? new Date() : null,
            claimedBy: confirmed ? null : 'a-run-still-working',
          },
        });
      }

      await prisma.digestDelivery.create({
        data: { userId: '', studentGuid: SHARED, reportFor: todayStart, status: 'sent' },
      });
    }

    it('runs every statement twice without error', async () => {
      await seedPreState();

      await runMigration(2);
    });

    it('hands the existing rows to the child’s earliest subscriber', async () => {
      await seedPreState();

      await runMigration(2);

      const ledger = await prisma.digestReportedItem.findMany({
        where: { studentGuid: SHARED, contentHash: 'pre-hash-beh' },
      });
      // Mum subscribed first in the fixture, and she is who the pre-deploy
      // run reported consent forms for and logged deliveries as.
      expect(ledger.map((row) => row.userId).sort()).toEqual([DAD, MUM]);

      const deliveries = await prisma.digestDelivery.findMany({
        where: { studentGuid: SHARED },
      });
      expect(deliveries.map((row) => row.userId)).toEqual([MUM]);
    });

    it('copies a confirmed item to the child’s other subscriber, once', async () => {
      await seedPreState();

      await runMigration(2);

      const copies = await prisma.digestReportedItem.findMany({
        where: { studentGuid: SHARED, userId: DAD },
      });
      // Running twice must not double it: ON CONFLICT DO NOTHING is what
      // makes the file safe on the boot after the one that ran it.
      expect(copies.map((row) => row.contentHash).sort()).toEqual([
        'pre-hash-beh',
        'pre-hash-hw',
      ]);
      expect(copies.every((row) => row.claimedBy === null)).toBe(true);
      expect(copies.every((row) => row.confirmedAt !== null)).toBe(true);
    });

    it('does not copy a consent form, whose hash belongs to one parent', async () => {
      await seedPreState();

      await runMigration(2);

      const forms = await prisma.digestReportedItem.findMany({
        where: { studentGuid: SHARED, contentHash: 'pre-hash-activity' },
      });
      // The hash embeds the owning userId, so a copy is a row the other
      // parent could never compute, never match and never be suppressed by.
      expect(forms.map((row) => row.userId)).toEqual([MUM]);
    });

    it('does not copy an item another run is still working on', async () => {
      await seedPreState();

      await runMigration(2);

      const inflight = await prisma.digestReportedItem.findMany({
        where: { studentGuid: SHARED, contentHash: 'pre-hash-inflight' },
      });
      // Unconfirmed means nothing was delivered, so there is nothing for the
      // other parent to have already received.
      expect(inflight.map((row) => row.userId)).toEqual([MUM]);
    });

    it('attributes the rows to the earliest ENABLED subscriber', async () => {
      // The owner has to be whoever the pre-deploy code would have reported
      // for: `listDeliveryTargets` read `where: { enabled: true }` and then
      // took the earliest activeFrom among those rows. Resolving over all
      // rows instead hands every historic `digest_delivery` row -- and its
      // `messageText`, which holds the ENABLED parent's unanswered consent
      // forms -- to a parent whose chat was switched off, who can then read it
      // through GET /digest/deliveries. That is this branch's own leak, for
      // history.
      await seedPreState({ toggledOff: MUM });

      await runMigration(2);

      const deliveries = await prisma.digestDelivery.findMany({
        where: { studentGuid: SHARED },
      });
      expect(deliveries.map((row) => row.userId)).toEqual([DAD]);

      // And the consent form, whose hash embeds its owner, stays with the
      // parent whose form it was -- the one the run was for.
      const forms = await prisma.digestReportedItem.findMany({
        where: { studentGuid: SHARED, contentHash: 'pre-hash-activity' },
      });
      expect(forms.map((row) => row.userId)).toEqual([DAD]);
    });

    it('copies the ledger once, not on every container boot', async () => {
      // backend/Dockerfile executes this file on EVERY boot, and the copy's
      // justification -- "pre-deploy, one per-child run delivered to every
      // enabled recipient" -- stops being true the moment the per-user code
      // is live. Unguarded, the next restart re-shares a freshly confirmed
      // row with a parent who has not been told, whose own run then finds it
      // already reported: exactly the silence this branch exists to remove,
      // re-created by the backfill.
      await seedPreState();
      await runMigration(1);

      // Life after the deploy: dad subscribes to the other child today, and
      // mum's run confirms today's behaviour for that child.
      await prisma.digestRecipient.create({
        data: {
          userId: DAD,
          studentGuid: MUM_ONLY,
          channel: 'telegram',
          address: CHAT_DAD,
          activeFrom: NOW,
        },
      });
      await prisma.digestReportedItem.create({
        data: {
          userId: MUM,
          studentGuid: MUM_ONLY,
          itemType: 'behavior',
          itemId: 'beh-after-deploy',
          contentHash: 'post-deploy-hash',
          reportedFor: todayStart,
          confirmedAt: new Date(),
        },
      });

      await runMigration(1);

      const dadsCopies = await prisma.digestReportedItem.findMany({
        where: { userId: DAD, studentGuid: MUM_ONLY },
      });
      expect(dadsCopies).toEqual([]);
    });

    it('leaves a row it cannot attribute alone rather than deleting it', async () => {
      // A child with no recipient row at all: the retention sweep clears it
      // within ninety days, and a DELETE here would be this file's one
      // irreversible statement.
      await prisma.digestReportedItem.create({
        data: {
          userId: '',
          studentGuid: MUM_ONLY,
          itemType: 'behavior',
          itemId: 'beh-orphan',
          contentHash: 'pre-hash-orphan',
          reportedFor: todayStart,
          confirmedAt: new Date(),
        },
      });
      await prisma.digestRecipient.deleteMany({ where: { studentGuid: MUM_ONLY } });

      await runMigration(2);

      const orphan = await prisma.digestReportedItem.findMany({
        where: { contentHash: 'pre-hash-orphan' },
      });
      expect(orphan.map((row) => row.userId)).toEqual(['']);
    });
  });
});
