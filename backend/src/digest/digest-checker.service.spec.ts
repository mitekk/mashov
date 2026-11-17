import { DigestCheckerService } from './digest-checker.service';
import { DigestDeadlineService } from './digest-deadline.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';

/**
 * 15:00 Jerusalem on Tuesday 2026-11-17 (winter, UTC+2), inside the 13:00-19:00
 * run window. Tomorrow is Wednesday, Mashov day 4.
 */
const NOW = new Date('2026-11-17T13:00:00Z');
const TODAY = new Date('2026-11-17T00:00:00Z');
const TOMORROW = new Date('2026-11-18T00:00:00Z');
/** Long before anything in these fixtures, so activeFrom excludes nothing. */
const ACTIVE_FROM = new Date('2026-09-01T00:00:00Z');

function behaviorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'beh-1',
    eventCode: 11,
    achvaName: 'איחור',
    classification: 'negative',
    justifiable: true,
    subject: 'מתמטיקה',
    remark: null,
    lessonDate: TODAY,
    eventAt: new Date('2026-11-17T11:00:00Z'),
    ...overrides,
  };
}

function homeworkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hw-1',
    groupId: 55,
    subjectName: 'מתמטיקה',
    homeworkText: 'לקרוא פרק 3 ולענות על השאלות',
    remark: null,
    lessonDate: TODAY,
    ...overrides,
  };
}

interface MockOptions {
  behavior?: Record<string, unknown>[];
  homeworkToday?: Record<string, unknown>[];
  homeworkLookback?: Record<string, unknown>[];
  reported?: Record<string, unknown>[];
  timetableDays?: number[];
}

function makeHarness(options: MockOptions = {}) {
  // Honours the lessonDate window, as Postgres would, so a test about which
  // rows the window admits cannot pass against a mock that ignores it.
  const inWindow = (
    rows: Record<string, unknown>[],
    where: { lessonDate?: { gte?: Date; lt?: Date } } | undefined,
  ) =>
    rows.filter((row) => {
      const date = row.lessonDate as Date;
      const range = where?.lessonDate ?? {};
      return (!range.gte || date >= range.gte) && (!range.lt || date < range.lt);
    });

  let homeworkCall = 0;
  const homeworkFindMany = jest.fn().mockImplementation(({ where }) => {
    // First call is "assigned recently", second is the due-tomorrow lookback.
    homeworkCall += 1;
    const rows = homeworkCall === 1 ? options.homeworkToday ?? [] : options.homeworkLookback ?? [];
    return Promise.resolve(inWindow(rows, where));
  });

  const prisma = {
    behaviorItem: {
      findMany: jest.fn().mockResolvedValue(options.behavior ?? []),
    },
    homeworkItem: { findMany: homeworkFindMany },
    digestReportedItem: {
      findMany: jest.fn().mockResolvedValue(options.reported ?? []),
    },
    timetableEntry: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.timetableDays ?? [4]).map((day) => ({ day }))),
    },
  } as unknown as PrismaService;

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'DIGEST_TIMEZONE') return 'Asia/Jerusalem';
      if (key === 'DIGEST_DUE_LOOKBACK_DAYS') return '14';
      return undefined;
    }),
  } as unknown as ConfigService;

  const service = new DigestCheckerService(
    prisma,
    config,
    new DigestDeadlineService(prisma),
  );

  return { service, prisma };
}

function check(harness: ReturnType<typeof makeHarness>) {
  return harness.service.check({
    studentGuid: 'stu-1',
    schoolYear: 2027,
    now: NOW,
    activeFrom: ACTIVE_FROM,
  });
}

describe('DigestCheckerService.check', () => {
  it('reports nothing on a quiet day', async () => {
    const result = await check(makeHarness());

    expect(result.candidates).toEqual([]);
    expect(result.reportFor).toEqual(TODAY);
  });

  it('finds a behavior event recorded today', async () => {
    const result = await check(makeHarness({ behavior: [behaviorRow()] }));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ itemType: 'behavior', itemId: 'beh-1' });
  });

  it('windows behavior on eventAt as well as lessonDate', async () => {
    // A teacher entering yesterday's absence this afternoon is exactly the news
    // a parent wants today, and a lessonDate-only window would miss it.
    const harness = makeHarness({
      behavior: [
        behaviorRow({
          id: 'beh-late',
          lessonDate: new Date('2026-11-16T00:00:00Z'),
          eventAt: new Date('2026-11-17T12:00:00Z'),
        }),
      ],
    });

    const result = await check(harness);

    expect(result.candidates).toHaveLength(1);
    const where = (harness.prisma.behaviorItem.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { lessonDate: { gte: TODAY, lt: TOMORROW } },
      { eventAt: { gte: TODAY, lt: TOMORROW } },
    ]);
  });

  it('finds homework assigned today', async () => {
    const result = await check(makeHarness({ homeworkToday: [homeworkRow()] }));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      itemType: 'homework_new',
      itemId: 'hw-1',
    });
  });

  it('finds homework whose group next meets tomorrow', async () => {
    const harness = makeHarness({
      homeworkLookback: [homeworkRow({ id: 'hw-old', lessonDate: new Date('2026-11-10T00:00:00Z') })],
      timetableDays: [4],
    });

    const result = await check(harness);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      itemType: 'homework_due',
      itemId: 'hw-old',
    });
    expect(result.candidates[0].estimatedDueDate).toEqual(TOMORROW);
  });

  it('keeps homework whose text names a deadline even when the group does not meet tomorrow', async () => {
    // The regex widens the set so the LLM can resolve a deadline the timetable
    // would have missed; the LLM narrows it afterwards.
    const harness = makeHarness({
      homeworkLookback: [
        homeworkRow({
          id: 'hw-hint',
          homeworkText: 'להגיש עד יום חמישי',
          lessonDate: new Date('2026-11-10T00:00:00Z'),
        }),
      ],
      timetableDays: [1], // Sunday — not tomorrow.
    });

    const result = await check(harness);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      itemType: 'homework_due',
      hasTextHint: true,
    });
  });

  it('drops homework that is neither due tomorrow nor hints at a deadline', async () => {
    const harness = makeHarness({
      homeworkLookback: [homeworkRow({ id: 'hw-quiet', lessonDate: new Date('2026-11-10T00:00:00Z') })],
      timetableDays: [1], // Sunday — not tomorrow, and the text has no hint.
    });

    expect((await check(harness)).candidates).toEqual([]);
  });

  it('does not re-report an item already reported', async () => {
    const first = await check(makeHarness({ behavior: [behaviorRow()] }));
    const hash = first.candidates[0].contentHash;

    const second = await check(
      makeHarness({
        behavior: [behaviorRow()],
        reported: [{ contentHash: hash, confirmedAt: new Date('2026-11-17T12:30:00Z'), claimedAt: new Date('2026-11-17T12:30:00Z'), resolvedDueDate: null }],
      }),
    );

    expect(second.candidates).toEqual([]);
  });

  it('re-reports an item whose text a teacher has edited', async () => {
    // contentHash is part of the dedup unique key precisely so this happens: a
    // new hash is a new row, hence a legitimate re-report as changed.
    const original = await check(makeHarness({ homeworkToday: [homeworkRow()] }));
    const originalHash = original.candidates[0].contentHash;

    const edited = await check(
      makeHarness({
        homeworkToday: [homeworkRow({ homeworkText: 'לקרוא פרק 4 במקום פרק 3' })],
        reported: [{ contentHash: originalHash, confirmedAt: new Date('2026-11-17T12:30:00Z'), claimedAt: new Date('2026-11-17T12:30:00Z'), resolvedDueDate: null }],
      }),
    );

    expect(edited.candidates).toHaveLength(1);
    expect(edited.candidates[0].contentHash).not.toBe(originalHash);
  });

  it('reclaims a crashed claim left unconfirmed for over 30 minutes', async () => {
    const first = await check(makeHarness({ behavior: [behaviorRow()] }));
    const hash = first.candidates[0].contentHash;

    const second = await check(
      makeHarness({
        behavior: [behaviorRow()],
        reported: [
          // Claimed 45 minutes ago and never confirmed: the run that owned it
          // died between claiming and sending, so nothing was delivered.
          { contentHash: hash, confirmedAt: null, claimedAt: new Date('2026-11-17T12:15:00Z') },
        ],
      }),
    );

    expect(second.candidates).toHaveLength(1);
  });

  it('leaves a fresh unconfirmed claim alone, so two runners do not both send', async () => {
    const first = await check(makeHarness({ behavior: [behaviorRow()] }));
    const hash = first.candidates[0].contentHash;

    const second = await check(
      makeHarness({
        behavior: [behaviorRow()],
        reported: [
          { contentHash: hash, confirmedAt: null, claimedAt: new Date('2026-11-17T12:58:00Z') },
        ],
      }),
    );

    expect(second.candidates).toEqual([]);
  });

  it('excludes items dated before the recipient became active', async () => {
    // Stops the first run after a parent signs up blasting a backlog.
    const harness = makeHarness({ behavior: [behaviorRow()] });

    const result = await harness.service.check({
      studentGuid: 'stu-1',
      schoolYear: 2027,
      now: NOW,
      activeFrom: new Date('2026-11-18T00:00:00Z'),
    });

    expect(result.candidates).toEqual([]);
  });


  it('re-admits a deferred item on the day its resolved deadline is tomorrow', async () => {
    // Recorded as deferred to 18/11 on an earlier day. Today is the 17th, so
    // tomorrow is the 18th and the parent must now be told.
    const harness = makeHarness({
      homeworkLookback: [homeworkRow({ id: 'hw-defer', homeworkText: 'להגיש עד יום רביעי' })],
      timetableDays: [1],
      reported: [
        {
          contentHash: 'will-be-matched',
          confirmedAt: new Date('2026-11-15T13:00:00Z'),
          claimedAt: new Date('2026-11-15T13:00:00Z'),
          resolvedDueDate: TOMORROW,
        },
      ],
    });

    // Match the hash the checker computes for this row so the ledger row applies.
    const probe = await check(
      makeHarness({
        homeworkLookback: [homeworkRow({ id: 'hw-defer', homeworkText: 'להגיש עד יום רביעי' })],
        timetableDays: [1],
      }),
    );
    const hash = probe.candidates[0].contentHash;
    (harness.prisma.digestReportedItem.findMany as jest.Mock).mockResolvedValue([
      {
        contentHash: hash,
        confirmedAt: new Date('2026-11-15T13:00:00Z'),
        claimedAt: new Date('2026-11-15T13:00:00Z'),
        resolvedDueDate: TOMORROW,
      },
    ]);

    const result = await check(harness);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].itemId).toBe('hw-defer');
  });

  it('keeps a deferred item hidden until its deadline comes round', async () => {
    const harness = makeHarness({
      homeworkLookback: [homeworkRow({ id: 'hw-defer', homeworkText: 'להגיש עד יום חמישי' })],
      timetableDays: [1],
    });
    const probe = await check(harness);
    const hash = probe.candidates[0].contentHash;

    const later = makeHarness({
      homeworkLookback: [homeworkRow({ id: 'hw-defer', homeworkText: 'להגיש עד יום חמישי' })],
      timetableDays: [1],
      reported: [
        {
          contentHash: hash,
          confirmedAt: new Date('2026-11-17T12:00:00Z'),
          claimedAt: new Date('2026-11-17T12:00:00Z'),
          // Thursday, not tomorrow.
          resolvedDueDate: new Date('2026-11-19T00:00:00Z'),
        },
      ],
    });

    expect((await check(later)).candidates).toEqual([]);
  });

  it('still reports homework a teacher entered after the last run of the day', async () => {
    // lessonDate is yesterday because the teacher filled it in at 20:00, after
    // the 19:00 run. A today-only window loses it for good: tomorrow's window
    // is tomorrow, and a plain assignment trips no deadline hint.
    const harness = makeHarness({
      homeworkToday: [
        homeworkRow({
          id: 'hw-late',
          homeworkText: 'שאלות על הלוח',
          lessonDate: new Date('2026-11-16T00:00:00Z'),
        }),
      ],
    });

    const result = await check(harness);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ itemType: 'homework_new', itemId: 'hw-late' });
  });

  it('bounds how far back it will look for late homework', async () => {
    const harness = makeHarness({ homeworkToday: [] });
    await check(harness);

    const where = (harness.prisma.homeworkItem.findMany as jest.Mock).mock.calls[0][0].where;
    // Three days back, not fourteen: enough for an evening entry and a weekend,
    // without re-reading the term on every run.
    expect(where.lessonDate.gte).toEqual(new Date('2026-11-14T00:00:00Z'));
    expect(where.lessonDate.lt).toEqual(TOMORROW);
  });

  it('includes items from the whole day a recipient opted in', async () => {
    // activeFrom is a timestamp (now()), lessonDate is a date at UTC midnight.
    // Comparing them directly suppressed every homework item on the sign-up
    // day while still reporting that day's behavior, whose eventAt is later.
    const harness = makeHarness({ homeworkToday: [homeworkRow()] });

    const result = await harness.service.check({
      studentGuid: 'stu-1',
      schoolYear: 2027,
      now: NOW,
      activeFrom: new Date('2026-11-17T06:00:00Z'),
    });

    expect(result.candidates).toHaveLength(1);
  });

  it('scopes every item query to the child and school year', async () => {
    const harness = makeHarness({ behavior: [behaviorRow()] });
    await check(harness);

    const behaviorWhere = (harness.prisma.behaviorItem.findMany as jest.Mock).mock.calls[0][0].where;
    expect(behaviorWhere.studentGuid).toBe('stu-1');
    expect(behaviorWhere.schoolYear).toEqual({ in: [2027, 0] });
  });

  it('asks the dedup ledger once, not once per candidate', async () => {
    // The checker runs seven times a day per child; a query per item would
    // multiply with the roster.
    const harness = makeHarness({
      behavior: [behaviorRow(), behaviorRow({ id: 'beh-2', achvaName: 'הפרעה' })],
      homeworkToday: [homeworkRow()],
    });

    await check(harness);

    expect(harness.prisma.digestReportedItem.findMany).toHaveBeenCalledTimes(1);
  });
});
