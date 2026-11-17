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
import { DigestDeadlineService } from '../../backend/src/digest/digest-deadline.service';
import { DigestSummarizerService } from '../../backend/src/digest/digest-summarizer.service';
import { DigestRecipientService } from '../../backend/src/digest/digest-recipient.service';
import { DigestRetentionService } from '../../backend/src/digest/digest-retention.service';
import { jerusalemDayBounds } from '../../backend/src/digest/digest-deadline.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { ConfigService } from '../../backend/node_modules/@nestjs/config';
import type { SchoolYearService } from '../../backend/src/common/school-year/school-year.service';
import type { DigestSender } from '../../backend/src/digest/senders/digest-sender.interface';

const CHILD_WITH_NEWS = 'digest-child-news';
const QUIET_CHILD = 'digest-child-quiet';
const USER_ID = 'digest-user-1';
const MASHOV_USER_ID = 'digest-mashov-1';
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
  readonly sent: { address: string; text: string }[] = [];

  async send(address: string, text: string): Promise<void> {
    this.sent.push({ address, text });
  }
}

function makeConfig(): ConfigService {
  const values: Record<string, string> = {
    DIGEST_TIMEZONE: TIMEZONE,
    DIGEST_DRY_RUN: 'false',
    DIGEST_DUE_LOOKBACK_DAYS: '14',
    // Deliberately absent: ANTHROPIC_API_KEY. The summarizer then renders the
    // deterministic fallback and no network call is made.
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
    sender,
    sender,
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
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.behaviorItem.deleteMany({ where: { studentGuid: { in: guids } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: guids } } });
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
    // First names only, and never the reporting teacher. See ADR-0025.
    expect(text).not.toContain('כהן');
    expect(text).not.toContain('רחל לוי');
    expect(text).not.toContain(CHILD_WITH_NEWS);
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
