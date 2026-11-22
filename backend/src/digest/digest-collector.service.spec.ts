import { DigestCollectorService, normalizeGender } from './digest-collector.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { DigestCandidate } from './digest.types';

const REPORT_FOR = new Date('2026-11-17T00:00:00Z');
const TOMORROW = new Date('2026-11-18T00:00:00Z');

const BEHAVIOR_ROW = {
  id: 'beh-1',
  achvaName: 'איחור',
  classification: 'attention',
  justifiable: true,
  subject: 'מתמטיקה',
  remark: 'הגיע באיחור',
  lessonDate: REPORT_FOR,
  eventAt: new Date('2026-11-17T11:00:00Z'),
};

const HOMEWORK_ROW = {
  id: 'hw-1',
  groupId: 55,
  subjectName: 'חשבון',
  homeworkText: 'לפתור עמוד 42',
  remark: null,
  lessonDate: REPORT_FOR,
};

function makeHarness(
  options: { behavior?: unknown[]; homework?: unknown[]; activities?: unknown[] } = {},
) {
  const prisma = {
    student: {
      findUnique: jest.fn().mockResolvedValue({
        privateName: 'אבי',
        familyName: 'כהן',
      }),
    },
    behaviorItem: {
      findMany: jest.fn().mockResolvedValue(options.behavior ?? []),
    },
    homeworkItem: {
      findMany: jest.fn().mockResolvedValue(options.homework ?? []),
    },
    schoolActivity: {
      findMany: jest.fn().mockResolvedValue(options.activities ?? []),
    },
    releaseRequest: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;

  return { prisma, service: new DigestCollectorService(prisma) };
}

function candidate(overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    itemType: 'behavior',
    itemId: 'beh-1',
    contentHash: 'hash-1',
    ...overrides,
  } as DigestCandidate;
}

describe('DigestCollectorService.collect', () => {
  it('carries the child first name only, never the family name', async () => {
    // The payload is what reaches the LLM prompt. ADR-0026: first names only.
    const harness = makeHarness({ behavior: [BEHAVIOR_ROW] });

    const payload = await harness.service.collect({
      studentGuid: 'stu-1',
      candidates: [candidate()],
      reportFor: REPORT_FOR,
      userId: 'user-1',
    });

    expect(payload.childFirstName).toBe('אבי');
    expect(JSON.stringify(payload)).not.toContain('כהן');
    expect(JSON.stringify(payload)).not.toContain('stu-1');
  });

  it('builds the behavior section from the claimed candidates', async () => {
    const harness = makeHarness({ behavior: [BEHAVIOR_ROW] });

    const payload = await harness.service.collect({
      studentGuid: 'stu-1',
      candidates: [candidate()],
      reportFor: REPORT_FOR,
      userId: 'user-1',
    });

    expect(payload.behavior).toHaveLength(1);
    expect(payload.behavior[0]).toMatchObject({ achvaName: 'איחור', subject: 'מתמטיקה' });
  });

  it('separates newly assigned homework from estimated-due homework', async () => {
    const harness = makeHarness({
      homework: [HOMEWORK_ROW, { ...HOMEWORK_ROW, id: 'hw-2' }],
    });

    const payload = await harness.service.collect({
      studentGuid: 'stu-1',
      candidates: [
        candidate({ itemType: 'homework_new', itemId: 'hw-1' }),
        candidate({ itemType: 'homework_due', itemId: 'hw-2', estimatedDueDate: TOMORROW }),
      ],
      reportFor: REPORT_FOR,
      userId: 'user-1',
    });

    expect(payload.homeworkNew.map((item) => item.id)).toEqual(['hw-1']);
    expect(payload.homeworkDueTomorrow.map((item) => item.id)).toEqual(['hw-2']);
  });

  it('attaches the estimate the checker derived to the due item', async () => {
    const harness = makeHarness({ homework: [HOMEWORK_ROW] });

    const payload = await harness.service.collect({
      studentGuid: 'stu-1',
      candidates: [
        candidate({ itemType: 'homework_due', itemId: 'hw-1', estimatedDueDate: TOMORROW }),
      ],
      reportFor: REPORT_FOR,
      userId: 'user-1',
    });

    expect(payload.homeworkDueTomorrow[0].estimatedDueDate).toEqual(TOMORROW);
  });

  it('reports the same homework row as both newly assigned and estimated-due', async () => {
    // Distinct itemTypes in the dedup key allow it, so the collector must too.
    const harness = makeHarness({ homework: [HOMEWORK_ROW] });

    const payload = await harness.service.collect({
      studentGuid: 'stu-1',
      candidates: [
        candidate({ itemType: 'homework_new', itemId: 'hw-1' }),
        candidate({ itemType: 'homework_due', itemId: 'hw-1', estimatedDueDate: TOMORROW }),
      ],
      reportFor: REPORT_FOR,
      userId: 'user-1',
    });

    expect(payload.homeworkNew).toHaveLength(1);
    expect(payload.homeworkDueTomorrow).toHaveLength(1);
  });

  it('does not query a table it has no candidates for', async () => {
    const harness = makeHarness({ behavior: [BEHAVIOR_ROW] });

    await harness.service.collect({
      studentGuid: 'stu-1',
      candidates: [candidate()],
      reportFor: REPORT_FOR,
      userId: 'user-1',
    });

    expect(harness.prisma.homeworkItem.findMany).not.toHaveBeenCalled();
  });

  it('selects no reporter, guid, or raw payload from the behavior table', async () => {
    // Those fields must never reach the prompt, so they are never read.
    const harness = makeHarness({ behavior: [BEHAVIOR_ROW] });

    await harness.service.collect({
      studentGuid: 'stu-1',
      candidates: [candidate()],
      reportFor: REPORT_FOR,
      userId: 'user-1',
    });

    const select = (harness.prisma.behaviorItem.findMany as jest.Mock).mock.calls[0][0].select;
    expect(select.reporter).toBeUndefined();
    expect(select.rawPayload).toBeUndefined();
    expect(select.studentGuid).toBeUndefined();
  });
});

describe('normalizeGender', () => {
  it('reads the Hebrew letters Mashov actually sends', () => {
    expect(normalizeGender('ז')).toBe('male');
    expect(normalizeGender('נ')).toBe('female');
  });

  it('still reads the latin forms older rows may hold', () => {
    expect(normalizeGender('M')).toBe('male');
    expect(normalizeGender('f')).toBe('female');
  });

  it('returns null rather than guessing', () => {
    // A wrong gender gets every Hebrew verb in the message wrong, which is
    // worse than prose that avoids the question.
    expect(normalizeGender('')).toBeNull();
    expect(normalizeGender(null)).toBeNull();
    expect(normalizeGender(undefined)).toBeNull();
    expect(normalizeGender('other')).toBeNull();
  });

  it('never re-reads an activity with no response deadline', async () => {
    // `DigestCheckerService` excludes NULL deadlines by construction — its
    // `endAnswerDate: { gte, lt }` filter is never true against NULL — so an
    // undated activity is correctly not reportable. This re-read had no such
    // filter, and since `endAnswerDate` became nullable an undated row became
    // reachable through it: the parent would be reminded about a form with no
    // deadline, printed as a bare title. The two reads must agree.
    const harness = makeHarness({
      activities: [
        {
          activityId: 7,
          title: 'טיול שנתי',
          activityStartDate: REPORT_FOR,
          endAnswerDate: TOMORROW,
        },
      ],
    });

    await harness.service.collect({
      studentGuid: 'stu-1',
      userId: 'user-1',
      candidates: [candidate({ itemType: 'activity', itemId: '7' })],
      reportFor: REPORT_FOR,
    });

    const [args] = (
      harness.prisma as unknown as { schoolActivity: { findMany: jest.Mock } }
    ).schoolActivity.findMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(args.where.endAnswerDate).toEqual({ not: null });
  });
});
