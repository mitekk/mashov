/**
 * Per-child daily digest — integration tests.
 *
 * These run against a real Postgres because every guarantee being proved here
 * is a database-level one that a mocked Prisma cannot show:
 *
 *  1. A child with news gets exactly one delivery; a quiet child gets a
 *     `skipped_empty` row rather than silence, which is the only way to tell a
 *     quiet day from a broken job.
 *  2. Running twice sends once. The dedup ledger's unique constraint is the
 *     whole at-most-once mechanism — ADR-0017 rules out a Redis lock, so there
 *     is nothing else holding the line.
 *  3. Two runners racing the same child produce one message, not two. That is
 *     the constraint doing its job under genuine concurrency, which an
 *     in-process guard cannot be asked to prove.
 *  4. A teacher editing homework text re-reports it, because contentHash is
 *     part of the unique key.
 *
 * No model is called: with no ANTHROPIC_API_KEY the summarizer renders the
 * deterministic Hebrew fallback, which is also the path a timeout takes.
 */

import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { DigestService } from '../../backend/src/digest/digest.service';
import { DigestCheckerService } from '../../backend/src/digest/digest-checker.service';
import { DigestCollectorService } from '../../backend/src/digest/digest-collector.service';
import { DigestDismissalService } from '../../backend/src/digest/digest-dismissal.service';
import { DigestDeadlineService } from '../../backend/src/digest/digest-deadline.service';
import { DigestSummarizerService } from '../../backend/src/digest/digest-summarizer.service';
import { DigestRecipientService } from '../../backend/src/digest/digest-recipient.service';
import { DigestRetentionService } from '../../backend/src/digest/digest-retention.service';
import { DigestAttachmentResolver } from '../../backend/src/digest/digest-attachment.resolver';
import {
  jerusalemDayBounds,
  mashovDayFromJsDate,
} from '../../backend/src/digest/digest-deadline.service';
import { formatSchoolDate } from '../../backend/src/digest/digest-report.template';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { TelegramSendOptions } from '../../backend/src/digest/senders/digest-sender.interface';
import type { ConfigService } from '../../backend/node_modules/@nestjs/config';
import type { SchoolYearService } from '../../backend/src/common/school-year/school-year.service';
import type { DigestSender } from '../../backend/src/digest/senders/digest-sender.interface';

const CHILD_WITH_NEWS = 'digest-child-news';
const QUIET_CHILD = 'digest-child-quiet';
const USER_ID = 'digest-user-1';
const MASHOV_USER_ID = 'digest-mashov-1';
const CONNECTION_ID = 'digest-conn-1';
const SCHOOL_YEAR = 2027;
const TIMEZONE = 'Asia/Jerusalem';

const NOW = new Date();
const { todayStart } = jerusalemDayBounds(NOW, TIMEZONE);

/** How many times `needle` appears in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Captures what would have been delivered, so assertions can read the text. */
class CapturingSender implements DigestSender {
  readonly channel = 'telegram';
  readonly sent: { address: string; text: string; options?: TelegramSendOptions }[] = [];

  async send(address: string, text: string, options?: TelegramSendOptions): Promise<void> {
    this.sent.push({ address, text, options });
  }
}

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    DIGEST_TIMEZONE: TIMEZONE,
    DIGEST_DRY_RUN: 'false',
    DIGEST_DUE_LOOKBACK_DAYS: '14',
    // Deliberately absent: ANTHROPIC_API_KEY. The summarizer then renders the
    // deterministic fallback and no network call is made. Also deliberately
    // absent by default: PUBLIC_BASE_URL, so most of these assertions read a
    // message with no anchors in it.
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function makeService(
  prisma: PrismaClient,
  sender: DigestSender,
  configOverrides: Record<string, string> = {},
) {
  const prismaService = prisma as unknown as PrismaService;
  const config = makeConfig(configOverrides);
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

describe('Per-child daily digest', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const guids = [CHILD_WITH_NEWS, QUIET_CHILD];
    await prisma.digestReportedItem.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.digestDelivery.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.digestRecipient.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.timetableEntry.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.behaviorItem.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.studentRelease.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.schoolActivity.deleteMany({ where: { userId: USER_ID } });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.householdConnection.deleteMany({ where: { id: CONNECTION_ID } });
    await prisma.appUser.deleteMany({ where: { id: USER_ID } });

    await prisma.appUser.create({
      data: {
        id: USER_ID,
        mashovUserId: MASHOV_USER_ID,
        semel: 998877,
        username: 'digest-test',
        displayName: 'Digest Test',
      },
    });

    // The connection that lists these children, and the links recording it.
    // Not decoration: a run re-checks at send time that the subscribing
    // parent still owns the child, and an unattributed child belongs to
    // nobody (ADR-0035, ownsStudentForDelivery).
    await prisma.householdConnection.create({
      data: {
        id: CONNECTION_ID,
        userId: USER_ID,
        schoolCode: 998877,
        schoolYear: SCHOOL_YEAR,
        username: 'digest-test-login',
        encryptedPassword: 'not-a-real-secret',
        active: true,
      },
    });

    for (const [guid, privateName] of [
      [CHILD_WITH_NEWS, 'אבי'],
      [QUIET_CHILD, 'נועה'],
    ]) {
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
          householdConnectionId: CONNECTION_ID,
          firstSeenAt: new Date(),
          lastSeenInRosterAt: new Date(),
        },
      });

      await prisma.digestRecipient.create({
        data: {
          userId: USER_ID,
          studentGuid: guid,
          channel: 'telegram',
          address: `chat-${guid}`,
          enabled: true,
          // Well before the seeded items, so activeFrom excludes nothing.
          activeFrom: new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000),
        },
      });
    }

    // The child with news: one behavior event and one homework item, both today.
    await prisma.behaviorItem.create({
      data: {
        studentGuid: CHILD_WITH_NEWS,
        schoolYear: SCHOOL_YEAR,
        lessonId: 5001,
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

    await prisma.homeworkItem.create({
      data: {
        studentGuid: CHILD_WITH_NEWS,
        schoolYear: SCHOOL_YEAR,
        lessonId: 6001,
        groupId: 70,
        lessonDate: todayStart,
        lesson: 3,
        subjectName: 'חשבון',
        homeworkText: 'לפתור עמוד 42',
      },
    });
  });

  it('holds a child who is still in class without consuming anything, then reports it in full', async () => {
    // The one unrecoverable defect this feature could have: if a held tick
    // claimed, the items would be marked reported and the post-dismissal tick
    // would find a quiet day -- a permanent loss, not a delay. Proved here
    // against the real schema as well as against a mocked Prisma, because the
    // claim rows and the unique constraint behind them are database objects.
    await prisma.timetableEntry.create({
      data: {
        studentGuid: CHILD_WITH_NEWS,
        schoolYear: SCHOOL_YEAR,
        groupId: 70,
        day: mashovDayFromJsDate(todayStart),
        lesson: 8,
        groupName: 'חשבון 70',
        subjectName: 'חשבון',
      },
    });

    // Default schedule: lesson 8 ends 15:00, so release is 15:30. These two
    // instants are 08:00-09:00 and 18:00-19:00 in Jerusalem -- on the right
    // side of 15:30 whether the offset is +2 or +3, so the test does not
    // depend on the time of year.
    const beforeDismissal = new Date(todayStart.getTime() + 6 * 60 * 60 * 1000);
    const afterDismissal = new Date(todayStart.getTime() + 16 * 60 * 60 * 1000);

    const held = new CapturingSender();
    const heldResults = await makeService(prisma, held).runAll({
      now: beforeDismissal,
      studentGuid: CHILD_WITH_NEWS,
    });

    expect(heldResults.find((r) => r.studentGuid === CHILD_WITH_NEWS)?.status).toBe(
      'skipped_before_dismissal',
    );
    expect(held.sent).toHaveLength(0);
    // Nothing claimed and nothing recorded: the next tick must see the day as
    // untouched, and the parent's history must not fill with held hours.
    expect(
      await prisma.digestReportedItem.count({ where: { studentGuid: CHILD_WITH_NEWS } }),
    ).toBe(0);
    expect(
      await prisma.digestDelivery.count({ where: { studentGuid: CHILD_WITH_NEWS } }),
    ).toBe(0);

    const released = new CapturingSender();
    const sentResults = await makeService(prisma, released).runAll({
      now: afterDismissal,
      studentGuid: CHILD_WITH_NEWS,
    });

    expect(sentResults.find((r) => r.studentGuid === CHILD_WITH_NEWS)?.status).toBe('sent');
    expect(released.sent).toHaveLength(1);
    // Both of the day's items, the ones the held tick would have reported.
    const confirmed = await prisma.digestReportedItem.findMany({
      where: { studentGuid: CHILD_WITH_NEWS, confirmedAt: { not: null } },
      select: { itemType: true },
    });
    expect(confirmed.map((row) => row.itemType).sort()).toEqual(['behavior', 'homework_new']);
  });

  it('never holds a child whose timetable has nothing for today', async () => {
    // Missing data must never hold a digest back. No timetable row is seeded
    // for this child, and the early tick sends exactly as it did before the
    // gate existed.
    const sender = new CapturingSender();

    const results = await makeService(prisma, sender).runAll({
      now: new Date(todayStart.getTime() + 6 * 60 * 60 * 1000),
      studentGuid: CHILD_WITH_NEWS,
    });

    expect(results.find((r) => r.studentGuid === CHILD_WITH_NEWS)?.status).toBe('sent');
    expect(sender.sent).toHaveLength(1);
  });

  it('sends to the child with news and records a quiet day for the other', async () => {
    const sender = new CapturingSender();

    const results = await makeService(prisma, sender).runAll({ now: NOW });

    const byChild = new Map(results.map((result) => [result.studentGuid, result]));
    expect(byChild.get(CHILD_WITH_NEWS)?.status).toBe('sent');
    expect(byChild.get(QUIET_CHILD)?.status).toBe('skipped_empty');

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].address).toBe(`chat-${CHILD_WITH_NEWS}`);

    // The quiet child's row is the whole point: silence is otherwise
    // indistinguishable from a broken job.
    const quietRows = await prisma.digestDelivery.findMany({
      where: { studentGuid: QUIET_CHILD },
    });
    expect(quietRows).toHaveLength(1);
    expect(quietRows[0].status).toBe('skipped_empty');
  });

  it('writes the Hebrew report, with the first name and no family name', async () => {
    const sender = new CapturingSender();

    await makeService(prisma, sender).runAll({ now: NOW });

    const text = sender.sent[0].text;
    expect(text).toContain('אבי');
    expect(text).toContain('איחור');
    expect(text).toContain('לפתור עמוד 42');
    // First names only, and never the reporting teacher. See ADR-0026.
    expect(text).not.toContain('כהן');
    expect(text).not.toContain('רחל לוי');
    // No anchors are rendered at all here, because this config sets no
    // PUBLIC_BASE_URL -- so the guid cannot appear. The test below is the one
    // that reads a message with links in it.
    expect(text).not.toContain(CHILD_WITH_NEWS);
  });

  it('structures the report as HTML the sender is told to parse', async () => {
    const sender = new CapturingSender();

    await makeService(prisma, sender).runAll({ now: NOW });

    const { text, options } = sender.sent[0];
    expect(options).toEqual({ parseMode: 'HTML' });
    // A bold emoji-marked title and one bullet per item -- see ADR-0047.
    expect(text).toContain('<b>');
    expect(text).toContain('⚠️');
    expect(text.split('\n').some((line) => line.startsWith('\u200F• '))).toBe(true);
    // The weekday, which is deterministic and the cheapest readability win.
    expect(text.split('\n')[0]).toMatch(/^אבי · (יום \S+|שבת), \d{2}\/\d{2}\/\d{4}$/);
  });

  it('links the report to the item it is about, guid and all', async () => {
    // The deliberate reversal of the identifier-free rule. A parent told about
    // an unexcused absence used to land on /home and have to find the child
    // and the note themselves. See ADR-0047.
    const sender = new CapturingSender();
    const service = makeService(prisma, sender, {
      PUBLIC_BASE_URL: 'https://mashov.example',
    });

    await service.runAll({ now: NOW });

    const text = sender.sent[0].text;
    expect(text).toContain(`https://mashov.example/children/${CHILD_WITH_NEWS}/behavior/`);
    // Items link; headers do not. A header could only point at the section
    // list, which leaves the parent to find the thing the message was about.
    for (const line of text.split('\n')) {
      if (line.startsWith('<b>')) expect(line).not.toContain('<a href');
    }
    // Every URL is an anchor's href: no bare link, and no /home line.
    expect(text).not.toMatch(/\/home(?!work)/);
    for (const line of text.split('\n')) {
      expect(line.replace(/href="[^"]*"/g, '')).not.toContain('http');
    }
  });

  it('keeps a hostile teacher remark visible and escaped rather than losing the message', async () => {
    await prisma.behaviorItem.updateMany({
      where: { studentGuid: CHILD_WITH_NEWS },
      data: { remark: 'אמר <b>שלום</b> & חייך' },
    });
    const sender = new CapturingSender();

    await makeService(prisma, sender).runAll({ now: NOW });

    const text = sender.sent[0].text;
    expect(text).toContain('&lt;b&gt;שלום&lt;/b&gt; &amp; חייך');
    expect(text).not.toContain('<b>שלום</b>');
  });

  it('records the delivery against the school day and keeps the sent text', async () => {
    const sender = new CapturingSender();

    await makeService(prisma, sender).runAll({ now: NOW });

    const row = await prisma.digestDelivery.findFirst({
      where: { studentGuid: CHILD_WITH_NEWS },
    });
    expect(row?.status).toBe('sent');
    expect(row?.itemCount).toBe(2);
    expect(row?.recipientCount).toBe(1);
    // No API key was configured, so the deterministic renderer produced it.
    expect(row?.usedLlm).toBe(false);
    expect(row?.messageText).toBe(sender.sent[0].text);
  });

  it('sends once when run twice', async () => {
    const sender = new CapturingSender();
    const service = makeService(prisma, sender);

    await service.runAll({ now: NOW });
    const second = await service.runAll({ now: NOW });

    expect(sender.sent).toHaveLength(1);
    expect(second.find((r) => r.studentGuid === CHILD_WITH_NEWS)?.status).toBe('skipped_empty');
  });

  it('confirms the claim so a later run can tell it was delivered', async () => {
    const sender = new CapturingSender();

    await makeService(prisma, sender).runAll({ now: NOW });

    const claims = await prisma.digestReportedItem.findMany({
      where: { studentGuid: CHILD_WITH_NEWS },
    });
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      expect(claim.confirmedAt).not.toBeNull();
      expect(claim.reportedFor).toEqual(todayStart);
    }
  });

  it('delivers each item exactly once when two runners race the same child', async () => {
    // The unique constraint plus `claimedBy` is the whole mechanism:
    // RedisService has no SET NX and ADR-0017 forbids durable state there, so
    // two instances cannot take a lock. Separate service instances, because the
    // in-process guard only covers one.
    //
    // The guarantee is per *item*, not per message. Each run claims rows,
    // reads back the ones it actually won, and reports only those -- so an
    // interleaving where one run wins the behavior row and the other wins the
    // homework row produces two messages between them, and still tells the
    // parent each thing exactly once. Asserting "one message" would be
    // asserting an accident of timing.
    const senderA = new CapturingSender();
    const senderB = new CapturingSender();

    await Promise.all([
      makeService(prisma, senderA).runAll({ now: NOW }),
      makeService(prisma, senderB).runAll({ now: NOW }),
    ]);

    const everythingSent = [...senderA.sent, ...senderB.sent].map((m) => m.text).join('\n');
    // Counted on the remark and the homework text, not on the event name:
    // 'איחור' is a substring of 'באיחור' inside the remark, so it occurs twice
    // in a single correct message.
    expect(occurrences(everythingSent, 'הגיע באיחור של 10 דקות')).toBe(1);
    expect(occurrences(everythingSent, 'לפתור עמוד 42')).toBe(1);

    // And every claim ends up owned by nobody and marked delivered.
    const claims = await prisma.digestReportedItem.findMany({
      where: { studentGuid: CHILD_WITH_NEWS },
    });
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      expect(claim.confirmedAt).not.toBeNull();
      expect(claim.claimedBy).toBeNull();
    }
  });

  it('takes over a claim left behind by a run that died before sending', async () => {
    // Simulates a container killed between claiming and sending: rows exist,
    // unconfirmed, older than the staleness window. Without an explicit
    // takeover these items are stuck forever and every run reports a quiet day.
    const first = new CapturingSender();
    const service = makeService(prisma, first);

    // Claim everything, then abandon it.
    await service.runAll({ now: NOW });
    await prisma.digestReportedItem.updateMany({
      where: { studentGuid: CHILD_WITH_NEWS },
      data: {
        confirmedAt: null,
        claimedBy: 'a-run-that-died',
        claimedAt: new Date(NOW.getTime() - 45 * 60 * 1000),
      },
    });

    const second = new CapturingSender();
    const results = await makeService(prisma, second).runAll({ now: NOW });

    expect(results.find((r) => r.studentGuid === CHILD_WITH_NEWS)?.status).toBe('sent');
    expect(second.sent).toHaveLength(1);
  });

  it('defers a deadline that is not tomorrow instead of burying or re-asking', async () => {
    // The burying case, end to end. A hint-matched homework whose next lesson
    // is not tomorrow must not be marked fully reported -- that is what would
    // mean the parent is never warned on the day it really is due. Instead the
    // resolved date is written to the ledger row, so the model is not asked
    // again every hour and the checker re-admits the item on that day.
    const tomorrowDayOfWeek = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).getUTCDay();
    // Any school weekday that is not tomorrow. Saturday (Mashov 7) is skipped
    // because no lesson can ever fall on it.
    let chosen = (tomorrowDayOfWeek + 2) % 7;
    if (chosen === 6) chosen = 0;
    const mashovDay = chosen + 1;

    await prisma.timetableEntry.create({
      data: {
        studentGuid: QUIET_CHILD,
        schoolYear: SCHOOL_YEAR,
        groupId: 80,
        day: mashovDay,
        lesson: 4,
        groupName: 'היסטוריה 80',
        subjectName: 'היסטוריה',
      },
    });

    await prisma.homeworkItem.create({
      data: {
        studentGuid: QUIET_CHILD,
        schoolYear: SCHOOL_YEAR,
        lessonId: 6100,
        groupId: 80,
        // Old enough to be out of the "newly assigned" window, so it can only
        // arrive as a due-tomorrow candidate.
        lessonDate: new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000),
        lesson: 4,
        subjectName: 'היסטוריה',
        homeworkText: 'יש להגיש את העבודה',
      },
    });

    const sender = new CapturingSender();
    // Scoped to this child: the other one has real news in every test, and this
    // assertion is about what the deferred item does, not about the roster.
    const results = await makeService(prisma, sender).runAll({
      now: NOW,
      studentGuid: QUIET_CHILD,
    });

    expect(results.find((r) => r.studentGuid === QUIET_CHILD)?.status).toBe('skipped_empty');
    expect(sender.sent).toHaveLength(0);

    const row = await prisma.digestReportedItem.findFirst({
      where: { studentGuid: QUIET_CHILD, itemType: 'homework_due' },
    });
    expect(row).not.toBeNull();
    // Deferred, not fully reported: a recorded date is what distinguishes the two.
    expect(row!.resolvedDueDate).not.toBeNull();
    expect(row!.confirmedAt).not.toBeNull();
    expect(row!.claimedBy).toBeNull();
  });

  it('re-reports homework whose text a teacher has edited', async () => {
    const sender = new CapturingSender();
    const service = makeService(prisma, sender);

    await service.runAll({ now: NOW });
    expect(sender.sent).toHaveLength(1);

    // contentHash is part of the dedup unique key, so new text is a new row.
    await prisma.homeworkItem.updateMany({
      where: { studentGuid: CHILD_WITH_NEWS, lessonId: 6001 },
      data: { homeworkText: 'לפתור עמוד 43 במקום 42' },
    });

    const second = await service.runAll({ now: NOW });

    expect(second.find((r) => r.studentGuid === CHILD_WITH_NEWS)?.status).toBe('sent');
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1].text).toContain('43');
  });

  it('reports a behavior event a teacher entered today about yesterday', async () => {
    // lessonDate is yesterday, eventAt is today. A lessonDate-only window
    // would drop it, and it is exactly the news a parent wants today.
    await prisma.behaviorItem.deleteMany({ where: { studentGuid: QUIET_CHILD } });
    await prisma.behaviorItem.create({
      data: {
        studentGuid: QUIET_CHILD,
        schoolYear: SCHOOL_YEAR,
        lessonId: 5002,
        groupId: 71,
        eventCode: 12,
        achvaCode: 2,
        achvaName: 'חיסור',
        classification: 'negative',
        justifiable: false,
        lessonDate: new Date(todayStart.getTime() - 24 * 60 * 60 * 1000),
        lesson: 1,
        subject: 'אנגלית',
        reporter: 'מורה דנה',
        eventAt: new Date(todayStart.getTime() + 12 * 60 * 60 * 1000),
      },
    });

    const sender = new CapturingSender();
    const results = await makeService(prisma, sender).runAll({ now: NOW });

    expect(results.find((r) => r.studentGuid === QUIET_CHILD)?.status).toBe('sent');
    expect(sender.sent.some((message) => message.text.includes('חיסור'))).toBe(true);
  });

  it('never messages a child with no enabled recipient', async () => {
    await prisma.digestRecipient.updateMany({
      where: { studentGuid: CHILD_WITH_NEWS },
      data: { enabled: false },
    });
    const sender = new CapturingSender();

    const results = await makeService(prisma, sender).runAll({ now: NOW });

    expect(results.find((r) => r.studentGuid === CHILD_WITH_NEWS)).toBeUndefined();
    expect(sender.sent).toHaveLength(0);
  });

  it('ignores items dated before the recipient opted in', async () => {
    // Stops a new recipient being blasted with the whole school year.
    await prisma.digestRecipient.updateMany({
      where: { studentGuid: CHILD_WITH_NEWS },
      data: { activeFrom: new Date(todayStart.getTime() + 23 * 60 * 60 * 1000) },
    });
    const sender = new CapturingSender();

    const results = await makeService(prisma, sender).runAll({ now: NOW });

    expect(results.find((r) => r.studentGuid === CHILD_WITH_NEWS)?.status).toBe('skipped_empty');
    expect(sender.sent).toHaveLength(0);
  });

  it('prunes its own history past the retention window', async () => {
    await prisma.digestDelivery.create({
      data: {
        studentGuid: CHILD_WITH_NEWS,
        reportFor: new Date(todayStart.getTime() - 200 * 24 * 60 * 60 * 1000),
        status: 'sent',
      },
    });

    const removed = await new DigestRetentionService(
      prisma as unknown as PrismaService,
    ).prune(NOW);

    expect(removed.deliveries).toBeGreaterThanOrEqual(1);
    const remaining = await prisma.digestDelivery.findMany({
      where: { studentGuid: CHILD_WITH_NEWS },
    });
    expect(remaining.every((row) => row.reportFor >= todayStart)).toBe(true);
  });
});

/**
 * Releases and consent forms, against real Postgres.
 *
 * The household-wide dedup for a consent form is the thing a unit test with a
 * mocked Prisma cannot honestly show: it depends on a query that deliberately
 * does *not* filter by studentGuid, so what proves it is two children of one
 * parent and one letter.
 */
describe('Digest releases and school activities', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const GUIDS = [CHILD_WITH_NEWS, QUIET_CHILD];

  beforeEach(async () => {
    await prisma.studentRelease.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.schoolActivity.deleteMany({ where: { userId: USER_ID } });
    await prisma.digestReportedItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.digestDelivery.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.digestRecipient.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.behaviorItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.householdConnection.deleteMany({ where: { id: CONNECTION_ID } });
    await prisma.appUser.deleteMany({ where: { id: USER_ID } });

    // Both children opted in under one parent, and nothing else to report --
    // so whatever these tests assert comes from releases and consent forms
    // alone. Hooks do not cross describe blocks, so this household is built
    // here rather than inherited.
    await prisma.appUser.create({
      data: {
        id: USER_ID,
        mashovUserId: MASHOV_USER_ID,
        semel: 998877,
        username: 'digest-test',
        displayName: 'Digest Test',
      },
    });

    // The connection that lists these children, and the links recording it.
    // Not decoration: a run re-checks at send time that the subscribing
    // parent still owns the child, and an unattributed child belongs to
    // nobody (ADR-0035, ownsStudentForDelivery).
    await prisma.householdConnection.create({
      data: {
        id: CONNECTION_ID,
        userId: USER_ID,
        schoolCode: 998877,
        schoolYear: SCHOOL_YEAR,
        username: 'digest-test-login',
        encryptedPassword: 'not-a-real-secret',
        active: true,
      },
    });

    for (const [guid, privateName] of [
      [CHILD_WITH_NEWS, 'אבי'],
      [QUIET_CHILD, 'נועה'],
    ]) {
      await prisma.student.create({
        data: {
          studentGuid: guid,
          privateName,
          familyName: 'כהן',
          fullName: `${privateName} כהן`,
          classCode: 'ג',
          classNum: 3,
          gender: privateName === 'נועה' ? 'נ' : 'ז',
          isActive: true,
        },
      });

      await prisma.studentConnection.create({
        data: {
          studentGuid: guid,
          householdConnectionId: CONNECTION_ID,
          firstSeenAt: new Date(),
          lastSeenInRosterAt: new Date(),
        },
      });

      await prisma.digestRecipient.create({
        data: {
          userId: USER_ID,
          studentGuid: guid,
          channel: 'telegram',
          address: `chat-${guid}`,
          enabled: true,
          activeFrom: new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000),
        },
      });
    }
  });

  it('reminds about a release scheduled for tomorrow, without the remark', async () => {
    await prisma.studentRelease.create({
      data: {
        studentGuid: CHILD_WITH_NEWS,
        releaseId: 64,
        schoolYear: SCHOOL_YEAR,
        releaseDate: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000),
        startHour: '11:30:00',
        remark: 'אבקש לשחרר את אבי, יש לו תור לרופא',
        status: 1,
      },
    });

    const sender = new CapturingSender();
    const results = await makeService(prisma, sender).runAll({
      now: NOW,
      studentGuid: CHILD_WITH_NEWS,
    });

    expect(results[0].status).toBe('sent');
    const message = sender.sent[0].text;
    expect(message).toContain('שחרור מוקדם');
    expect(message).toContain('11:30');
    // The parent's own remark went with the item bullets: they wrote it, and it
    // was the only other place the child's name appeared in the message.
    expect(message).not.toContain('תור לרופא');
    expect(occurrences(message, 'אבי')).toBe(1);
  });

  it('never reports a release the parent cancelled', async () => {
    await prisma.studentRelease.create({
      data: {
        studentGuid: CHILD_WITH_NEWS,
        releaseId: 65,
        schoolYear: SCHOOL_YEAR,
        releaseDate: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000),
        startHour: '09:00:00',
        status: 1,
        isDeleted: true,
      },
    });

    const sender = new CapturingSender();
    const results = await makeService(prisma, sender).runAll({
      now: NOW,
      studentGuid: CHILD_WITH_NEWS,
    });

    expect(results[0].status).toBe('skipped_empty');
    expect(sender.sent).toHaveLength(0);
  });

  it('reports a consent form to one child only, not once per sibling', async () => {
    await prisma.schoolActivity.create({
      data: {
        userId: USER_ID,
        activityId: 7,
        schoolYear: SCHOOL_YEAR,
        activityType: 1,
        title: 'טיול שנתי לגליל',
        activityStartDate: new Date(todayStart.getTime() + 8 * 24 * 60 * 60 * 1000),
        activityEndDate: new Date(todayStart.getTime() + 8 * 24 * 60 * 60 * 1000),
        endAnswerDate: new Date(todayStart.getTime() + 3 * 24 * 60 * 60 * 1000),
        isAnswered: false,
      },
    });

    const sender = new CapturingSender();
    const results = await makeService(prisma, sender).runAll({ now: NOW });

    // Both children are opted in and share the parent, so the letter must be
    // claimed by whichever child's run reached it first and by nobody else.
    const withForm = sender.sent.filter((message) => message.text.includes('טיול שנתי לגליל'));
    expect(withForm).toHaveLength(1);

    const rows = await prisma.digestReportedItem.findMany({ where: { itemType: 'activity' } });
    expect(rows).toHaveLength(1);
    expect(results.filter((result) => result.status === 'sent')).toHaveLength(1);
  });

  it('stops reporting a consent form once it has been answered', async () => {
    await prisma.schoolActivity.create({
      data: {
        userId: USER_ID,
        activityId: 8,
        schoolYear: SCHOOL_YEAR,
        activityType: 1,
        title: 'הצגה בתיאטרון',
        activityStartDate: new Date(todayStart.getTime() + 5 * 24 * 60 * 60 * 1000),
        activityEndDate: new Date(todayStart.getTime() + 5 * 24 * 60 * 60 * 1000),
        endAnswerDate: new Date(todayStart.getTime() + 2 * 24 * 60 * 60 * 1000),
        isAnswered: true,
      },
    });

    const sender = new CapturingSender();
    const results = await makeService(prisma, sender).runAll({ now: NOW });

    expect(results.every((result) => result.status === 'skipped_empty')).toBe(true);
    expect(sender.sent).toHaveLength(0);
  });

  it('ignores a consent deadline beyond the window', async () => {
    await prisma.schoolActivity.create({
      data: {
        userId: USER_ID,
        activityId: 9,
        schoolYear: SCHOOL_YEAR,
        activityType: 2,
        title: 'חווה חקלאית',
        activityStartDate: new Date(todayStart.getTime() + 90 * 24 * 60 * 60 * 1000),
        activityEndDate: new Date(todayStart.getTime() + 90 * 24 * 60 * 60 * 1000),
        endAnswerDate: new Date(todayStart.getTime() + 60 * 24 * 60 * 60 * 1000),
        isAnswered: false,
      },
    });

    const sender = new CapturingSender();
    const results = await makeService(prisma, sender).runAll({ now: NOW });

    expect(results.every((result) => result.status === 'skipped_empty')).toBe(true);
  });
});

/**
 * Grades — the producer side, end to end against a real Postgres.
 *
 * Two things here only a real database shows. The checker windows
 * `enteredAt` while the message prints `eventDate`, and the two are weeks
 * apart on a real row — a mocked Prisma that ignores its own where-clause
 * cannot tell the two apart. And a grade is the first digest input that gets
 * **corrected** upstream after it is reported, which is the content hash and
 * the dedup unique key doing their job, not application code.
 */
describe('Digest grades', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const GUIDS = [CHILD_WITH_NEWS, QUIET_CHILD];
  /** Three weeks before the test was marked — the ordinary shape of a row. */
  const EVENT_DATE = new Date(todayStart.getTime() - 21 * 24 * 60 * 60 * 1000);
  const TEACHER = 'מורה רחל לוי';

  async function seedGrade(overrides: Record<string, unknown> = {}) {
    return prisma.gradeItem.create({
      data: {
        studentGuid: CHILD_WITH_NEWS,
        schoolYear: SCHOOL_YEAR,
        gradingEventId: 7701,
        grade: 92,
        gradingPeriod: 1,
        gradeTypeId: 1,
        gradeType: 'מבחן',
        gradingEvent: 'מבחן בשברים',
        groupId: 70,
        groupName: 'חשבון ג1',
        subjectName: 'חשבון',
        teacherName: TEACHER,
        eventDate: EVENT_DATE,
        // Keyed in this morning: inside DIGEST_GRADE_LOOKBACK_DAYS, which is
        // what makes it news, while eventDate is long outside it.
        enteredAt: new Date(todayStart.getTime() + 7 * 60 * 60 * 1000),
        ...overrides,
      },
    });
  }

  beforeEach(async () => {
    await prisma.gradeItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.digestReportedItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.digestDelivery.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.digestRecipient.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.behaviorItem.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.studentRelease.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.schoolActivity.deleteMany({ where: { userId: USER_ID } });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: GUIDS } } });
    await prisma.householdConnection.deleteMany({ where: { id: CONNECTION_ID } });
    await prisma.appUser.deleteMany({ where: { id: USER_ID } });

    // Hooks do not cross describe blocks, so this household is built here
    // rather than inherited — the same reason the releases block says so.
    await prisma.appUser.create({
      data: {
        id: USER_ID,
        mashovUserId: MASHOV_USER_ID,
        semel: 998877,
        username: 'digest-test',
        displayName: 'Digest Test',
      },
    });

    await prisma.householdConnection.create({
      data: {
        id: CONNECTION_ID,
        userId: USER_ID,
        schoolCode: 998877,
        schoolYear: SCHOOL_YEAR,
        username: 'digest-test-login',
        encryptedPassword: 'not-a-real-secret',
        active: true,
      },
    });

    for (const [guid, privateName] of [
      [CHILD_WITH_NEWS, 'אבי'],
      [QUIET_CHILD, 'נועה'],
    ]) {
      await prisma.student.create({
        data: {
          studentGuid: guid,
          privateName,
          familyName: 'כהן',
          fullName: `${privateName} כהן`,
          classCode: 'ג',
          classNum: 3,
          gender: privateName === 'נועה' ? 'נ' : 'ז',
          isActive: true,
        },
      });

      await prisma.studentConnection.create({
        data: {
          studentGuid: guid,
          householdConnectionId: CONNECTION_ID,
          firstSeenAt: new Date(),
          lastSeenInRosterAt: new Date(),
        },
      });

      await prisma.digestRecipient.create({
        data: {
          userId: USER_ID,
          studentGuid: guid,
          channel: 'telegram',
          address: `chat-${guid}`,
          enabled: true,
          activeFrom: new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000),
        },
      });
    }
  });

  it('reports a newly entered mark, dated by the assessment and with no teacher named', async () => {
    await seedGrade();

    const sender = new CapturingSender();
    const results = await makeService(prisma, sender).runAll({
      now: NOW,
      studentGuid: CHILD_WITH_NEWS,
    });

    expect(sender.sent).toHaveLength(1);
    const text = sender.sent[0].text;
    expect(text).toContain('📊 ציונים חדשים');
    // The date in the parenthesis is eventDate, when the test was sat, and
    // not enteredAt: "92" against this morning would attach the mark to the
    // wrong day in a parent's head. Asserted as one string, because the
    // header legitimately carries today's date too.
    expect(text).toContain(`חשבון — מבחן בשברים: 92 (${formatSchoolDate(EVENT_DATE)})`);
    // teacherName is on the row and is never selected, so it cannot be here.
    expect(text).not.toContain(TEACHER);
    expect(text).not.toContain('רחל');

    const sent = results.find((result) => result.studentGuid === CHILD_WITH_NEWS);
    expect(sent?.status).toBe('sent');
    expect(sent?.itemCount).toBe(1);
  });

  it('sends the same mark once, however many times the day runs', async () => {
    await seedGrade();

    const sender = new CapturingSender();
    const service = makeService(prisma, sender);

    await service.runAll({ now: NOW, studentGuid: CHILD_WITH_NEWS });
    expect(sender.sent).toHaveLength(1);

    const second = await service.runAll({ now: NOW, studentGuid: CHILD_WITH_NEWS });

    expect(sender.sent).toHaveLength(1);
    expect(second.find((r) => r.studentGuid === CHILD_WITH_NEWS)?.status).toBe('skipped_empty');
  });

  it('re-reports a mark a teacher has corrected', async () => {
    await seedGrade();

    const sender = new CapturingSender();
    const service = makeService(prisma, sender);

    await service.runAll({ now: NOW, studentGuid: CHILD_WITH_NEWS });
    expect(sender.sent).toHaveLength(1);

    // The mark is in the content hash, which is part of the dedup unique key,
    // so a correction is a new row. Reachable in production because the sync
    // upsert rewrites `enteredAt` from the upstream timestamp on every pass —
    // a corrected mark moves its own date forward and re-enters the lookback.
    await prisma.gradeItem.updateMany({
      where: { studentGuid: CHILD_WITH_NEWS, gradingEventId: 7701 },
      data: { grade: 94 },
    });

    const second = await service.runAll({ now: NOW, studentGuid: CHILD_WITH_NEWS });

    expect(second.find((r) => r.studentGuid === CHILD_WITH_NEWS)?.status).toBe('sent');
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1].text).toContain('94');
  });

  it('ignores a mark keyed in weeks ago', async () => {
    await seedGrade({
      gradingEventId: 7702,
      enteredAt: new Date(todayStart.getTime() - 20 * 24 * 60 * 60 * 1000),
    });

    const sender = new CapturingSender();
    const results = await makeService(prisma, sender).runAll({ now: NOW });

    expect(sender.sent).toHaveLength(0);
    expect(results.every((result) => result.status === 'skipped_empty')).toBe(true);
  });
});
