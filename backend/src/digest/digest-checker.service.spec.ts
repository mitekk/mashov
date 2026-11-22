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
/** Who a `reported` fixture row belongs to unless it says otherwise. */
const LEDGER_OWNER = 'user-1';

function behaviorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'beh-1',
    eventCode: 11,
    achvaName: 'איחור',
    classification: 'attention',
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
  releases?: Record<string, unknown>[];
  activities?: Record<string, unknown>[];
  userId?: string | null;
  mutedCodes?: string;
  board?: Record<string, unknown>[];
  boardLookbackDays?: string;
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
      // Honours `where.eventCode.notIn`, as Postgres would. A mock that
      // ignored it would report the attendance mute as working while every
      // row still came back.
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          (options.behavior ?? []).filter((row) => {
            const excluded = (where?.eventCode?.notIn ?? []) as number[];
            return !excluded.includes(row.eventCode as number);
          }),
        ),
      ),
    },
    homeworkItem: { findMany: homeworkFindMany },
    digestReportedItem: {
      // Honours `where.userId`, as Postgres would. The ledger is per
      // (child, subscribing parent), so a mock that answers every user's rows
      // to every query would report the isolation as working while one
      // parent's confirmed row silently suppressed the other's item.
      findMany: jest.fn().mockImplementation(({ where }: { where?: { userId?: string } } = {}) =>
        Promise.resolve(
          (options.reported ?? []).filter(
            (row) =>
              where?.userId === undefined ||
              (row.userId ?? LEDGER_OWNER) === where.userId,
          ),
        ),
      ),
    },
    timetableEntry: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.timetableDays ?? [4]).map((day) => ({ day }))),
    },
    // Both honour their date windows, as Postgres would.
    studentRelease: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          (options.releases ?? []).filter((row) => {
            const date = row.releaseDate as Date;
            const range = (where?.releaseDate ?? {}) as { gte?: Date; lt?: Date };
            return (!range.gte || date >= range.gte) && (!range.lt || date < range.lt);
          }),
        ),
      ),
    },
    // Honours the firstSeenAt floor and the expiry cutoff, as Postgres would.
    messageBoardItem: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          (options.board ?? []).filter((row) => {
            const seen = where?.firstSeenAt?.gte as Date | undefined;
            const expiry = where?.expirationDate?.gte as Date | undefined;
            if (seen && (row.firstSeenAt as Date) < seen) return false;
            if (expiry && (row.expirationDate as Date) < expiry) return false;
            return true;
          }),
        ),
      ),
    },
    schoolActivity: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          (options.activities ?? []).filter((row) => {
            const date = row.endAnswerDate as Date;
            const range = (where?.endAnswerDate ?? {}) as { gte?: Date; lt?: Date };
            const answered = where?.isAnswered;
            if (answered !== undefined && row.isAnswered !== answered) return false;
            return (!range.gte || date >= range.gte) && (!range.lt || date < range.lt);
          }),
        ),
      ),
    },
  } as unknown as PrismaService;

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'DIGEST_TIMEZONE') return 'Asia/Jerusalem';
      if (key === 'DIGEST_DUE_LOOKBACK_DAYS') return '14';
      if (key === 'DIGEST_MUTED_BEHAVIOR_CODES') return options.mutedCodes;
      if (key === 'DIGEST_BOARD_LOOKBACK_DAYS') return options.boardLookbackDays;
      return undefined;
    }),
  } as unknown as ConfigService;
  void options.userId;

  const service = new DigestCheckerService(
    prisma,
    config,
    new DigestDeadlineService(prisma),
  );

  return { service, prisma };
}

function check(harness: ReturnType<typeof makeHarness>, overrides: { userId?: string } = {}) {
  return harness.service.check({
    studentGuid: 'stu-1',
    schoolYear: 2027,
    now: NOW,
    activeFrom: ACTIVE_FROM,
    userId: overrides.userId === undefined ? LEDGER_OWNER : overrides.userId,
  });
}

function releaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rel-1',
    releaseId: 64,
    releaseDate: TOMORROW,
    startHour: '11:30:00',
    remark: 'אבקש לשחרר את יונתן, יש לו תור לרופא',
    status: 1,
    ...overrides,
  };
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act-1',
    activityId: 7,
    title: 'טיול שנתי לגליל',
    activityStartDate: new Date('2026-11-25T00:00:00Z'),
    endAnswerDate: new Date('2026-11-20T00:00:00Z'),
    isAnswered: false,
    ...overrides,
  };
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
      userId: LEDGER_OWNER,
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
      userId: LEDGER_OWNER,
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

describe('DigestCheckerService releases', () => {
  it('reports a release scheduled for tomorrow', async () => {
    const result = await check(makeHarness({ releases: [releaseRow()] }));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ itemType: 'release', itemId: '64' });
  });

  it('reports a release scheduled for today', async () => {
    const result = await check(makeHarness({ releases: [releaseRow({ releaseDate: TODAY })] }));

    expect(result.candidates).toHaveLength(1);
  });

  it('ignores a release further out than tomorrow', async () => {
    // The parent filed it, so it is a day-of reminder, not news. Reporting it
    // a fortnight early would be an echo of their own form.
    const result = await check(
      makeHarness({ releases: [releaseRow({ releaseDate: new Date('2026-11-25T00:00:00Z') })] }),
    );

    expect(result.candidates).toEqual([]);
  });

  it('ignores a release the parent deleted', async () => {
    const harness = makeHarness({ releases: [releaseRow({ isDeleted: true })] });

    await check(harness);

    const where = (harness.prisma.studentRelease.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.isDeleted).toBe(false);
  });
});

describe('DigestCheckerService school activities', () => {
  it('reports a consent form still unanswered with its deadline near', async () => {
    const result = await check(makeHarness({ activities: [activityRow()] }));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ itemType: 'activity', itemId: '7' });
  });

  it('asks only for the unanswered ones', async () => {
    const harness = makeHarness({ activities: [activityRow()] });

    await check(harness);

    const where = (harness.prisma.schoolActivity.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.isAnswered).toBe(false);
    expect(where.userId).toBe('user-1');
  });

  it('ignores a deadline too far out to act on yet', async () => {
    const result = await check(
      makeHarness({
        activities: [activityRow({ endAnswerDate: new Date('2027-03-01T00:00:00Z') })],
      }),
    );

    expect(result.candidates).toEqual([]);
  });

  it('does not look for activities at all when the subscriber is unknown', async () => {
    // Activities are user-scoped; with no userId there is no list to read. The
    // only way to get here now is a ledger row left at the schema default by
    // the migration, which matches no user's forms.
    const harness = makeHarness({ activities: [activityRow()] });

    const result = await check(harness, { userId: '' });

    expect(harness.prisma.schoolActivity.findMany).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
  });

  it('suppresses an activity a sibling run already reported', async () => {
    // The form belongs to the household, not the child. Two children must not
    // each get the same letter, so the dedup lookup for an activity is not
    // scoped to one studentGuid.
    const harness = makeHarness({ activities: [activityRow()] });
    const first = await check(harness);
    const hash = first.candidates[0].contentHash;

    const second = makeHarness({ activities: [activityRow()] });
    (second.prisma.digestReportedItem.findMany as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve(
        where.studentGuid === undefined && where.contentHash.in.includes(hash)
          ? [{ contentHash: hash, confirmedAt: new Date(), claimedAt: new Date(), resolvedDueDate: null }]
          : [],
      ),
    );

    const result = await check(second, { userId: 'user-1' });

    expect(result.candidates).toEqual([]);
  });

  it('does not let one parent’s report suppress the other parent’s item', async () => {
    // Both parents of a shared child are told the same per-child news, each
    // from their own ledger. A single ledger meant whichever run went first
    // reported the behaviour event and the second parent never heard about it.
    const first = await check(makeHarness({ behavior: [behaviorRow()] }));
    const hash = first.candidates[0].contentHash;

    const other = await check(
      makeHarness({
        behavior: [behaviorRow()],
        reported: [
          {
            userId: 'user-1',
            contentHash: hash,
            confirmedAt: new Date('2026-11-17T12:30:00Z'),
            claimedAt: new Date('2026-11-17T12:30:00Z'),
            resolvedDueDate: null,
          },
        ],
      }),
      { userId: 'user-2' },
    );

    expect(other.candidates.map((candidate) => candidate.contentHash)).toEqual([hash]);
  });

  it('does not treat another parent’s in-flight claim as its own', async () => {
    // An unconfirmed claim inside the staleness window means "a run is working
    // on this". That run is sending to the other parent, which says nothing
    // about whether this parent has been told.
    const first = await check(makeHarness({ behavior: [behaviorRow()] }));
    const hash = first.candidates[0].contentHash;

    const mine = await check(
      makeHarness({
        behavior: [behaviorRow()],
        reported: [
          {
            userId: 'user-2',
            contentHash: hash,
            confirmedAt: null,
            claimedAt: new Date('2026-11-17T12:59:00Z'),
            resolvedDueDate: null,
          },
        ],
      }),
      { userId: 'user-1' },
    );

    expect(mine.candidates.map((candidate) => candidate.contentHash)).toEqual([hash]);
  });

  it('dedups forms across siblings but never across parents', async () => {
    // The activity arm omits studentGuid on purpose -- one letter, one mention,
    // whichever child's run gets there first -- and must still be scoped to the
    // parent whose unanswered form it is.
    const harness = makeHarness({ activities: [activityRow()] });

    await check(harness, { userId: 'user-1' });

    const activityQuery = (harness.prisma.digestReportedItem.findMany as jest.Mock).mock.calls
      .map((call) => call[0].where)
      .find((where) => where.studentGuid === undefined);
    expect(activityQuery).toBeDefined();
    expect(activityQuery.userId).toBe('user-1');
  });
});

describe('DigestCheckerService behaviour code muting', () => {
  it('leaves plain attendance out of the report', async () => {
    // eventCode 18 is נוכחות -- a presence row written for every lesson of
    // every day. It is the single largest source of behaviour rows and tells
    // a parent nothing: the child was at school, as expected.
    const harness = makeHarness({
      behavior: [
        behaviorRow({ id: 'beh-attendance', eventCode: 18, achvaName: 'נוכחות' }),
        behaviorRow({ id: 'beh-late', eventCode: 1, achvaName: 'איחור' }),
      ],
    });

    const result = await check(harness);

    expect(result.candidates.map((candidate) => candidate.itemId)).toEqual(['beh-late']);
  });

  it('treats a day of nothing but attendance as a genuinely quiet day', async () => {
    // Load-bearing: the muting has to happen here rather than in the collector
    // or the template. A row the checker returns is a row the run CLAIMS, and
    // a claim the payload has nothing for is released by settleUnsent and
    // re-claimed on the next run -- seven times a day, forever -- while
    // summaryFor still spends a Sonnet call on it and sends a message with no
    // sections in it.
    const harness = makeHarness({
      behavior: [
        behaviorRow({ id: 'a', eventCode: 18 }),
        behaviorRow({ id: 'b', eventCode: 18, lessonDate: TODAY }),
      ],
    });

    const result = await check(harness);

    expect(result.candidates).toEqual([]);
  });

  it('still reports a behaviour code the classifier has never seen', async () => {
    // Why the filter keys on eventCode and not on `classification`: an unmapped
    // code falls through to `neutral`, exactly like 18, so filtering on the
    // bucket would silently swallow every code a school adds later.
    const harness = makeHarness({
      behavior: [behaviorRow({ id: 'beh-new', eventCode: 99, classification: 'neutral' })],
    });

    const result = await check(harness);

    expect(result.candidates.map((candidate) => candidate.itemId)).toEqual(['beh-new']);
  });

  it('reports an absence and a positive note', async () => {
    const harness = makeHarness({
      behavior: [
        behaviorRow({ id: 'beh-absent', eventCode: 2, classification: 'attention' }),
        behaviorRow({ id: 'beh-praise', eventCode: 4, classification: 'positive' }),
      ],
    });

    const result = await check(harness);

    expect(result.candidates.map((candidate) => candidate.itemId).sort()).toEqual([
      'beh-absent',
      'beh-praise',
    ]);
  });

  it('mutes the codes named in DIGEST_MUTED_BEHAVIOR_CODES instead of the default', async () => {
    const harness = makeHarness({
      mutedCodes: ' 1 , 2 ',
      behavior: [
        behaviorRow({ id: 'beh-late', eventCode: 1 }),
        behaviorRow({ id: 'beh-absent', eventCode: 2 }),
        behaviorRow({ id: 'beh-attendance', eventCode: 18 }),
      ],
    });

    const result = await check(harness);

    expect(result.candidates.map((candidate) => candidate.itemId)).toEqual(['beh-attendance']);
  });

  it('mutes nothing when DIGEST_MUTED_BEHAVIOR_CODES is set to empty', async () => {
    // An explicit kill switch: an operator who needs to see the raw stream
    // back should not have to find a code that means "none".
    const harness = makeHarness({
      mutedCodes: '',
      behavior: [behaviorRow({ id: 'beh-attendance', eventCode: 18 })],
    });

    const result = await check(harness);

    expect(result.candidates.map((candidate) => candidate.itemId)).toEqual(['beh-attendance']);
  });

  it('mutes nothing rather than event code 0 for an empty setting', async () => {
    // Number('') is 0, so a naive parse of "" mutes code 0 instead of nothing.
    const harness = makeHarness({
      mutedCodes: '',
      behavior: [behaviorRow({ id: 'beh-zero', eventCode: 0 })],
    });

    const result = await check(harness);

    expect(result.candidates.map((candidate) => candidate.itemId)).toEqual(['beh-zero']);
  });

  it('drops a typo from the list rather than failing the run', async () => {
    const harness = makeHarness({
      mutedCodes: '18, oops',
      behavior: [
        behaviorRow({ id: 'beh-attendance', eventCode: 18 }),
        behaviorRow({ id: 'beh-late', eventCode: 1 }),
      ],
    });

    const result = await check(harness);

    expect(result.candidates.map((candidate) => candidate.itemId)).toEqual(['beh-late']);
  });
});

function boardRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 4211,
    eventText: '<p>ביום חמישי יום ספורט</p>',
    expirationDate: new Date('2026-11-30T00:00:00Z'),
    firstSeenAt: new Date('2026-11-17T06:00:00Z'),
    ...overrides,
  };
}

describe('DigestCheckerService message board', () => {
  it('reports a notice first seen inside the lookback', async () => {
    const harness = makeHarness({ behavior: [], board: [boardRow()] });

    const result = await check(harness);

    expect(result.candidates).toEqual([
      expect.objectContaining({ itemType: 'message_board', itemId: '4211' }),
    ]);
  });

  it('ignores a notice that has been on the board for weeks', async () => {
    // Mashov sends no creation date and `updatedAt` churns on every 06:00
    // upsert, so firstSeenAt is the only thing here that can mean "new".
    const harness = makeHarness({
      behavior: [],
      board: [boardRow({ firstSeenAt: new Date('2026-10-01T06:00:00Z') })],
    });

    expect((await check(harness)).candidates).toEqual([]);
  });

  it('ignores a notice that has already expired', async () => {
    const harness = makeHarness({
      behavior: [],
      board: [boardRow({ expirationDate: new Date('2026-11-01T00:00:00Z') })],
    });

    expect((await check(harness)).candidates).toEqual([]);
  });

  it('honours DIGEST_BOARD_LOOKBACK_DAYS', async () => {
    const old = boardRow({ firstSeenAt: new Date('2026-11-10T06:00:00Z') });

    expect((await check(makeHarness({ behavior: [], board: [old] }))).candidates).toEqual([]);
    expect(
      (await check(makeHarness({ behavior: [], board: [old], boardLookbackDays: '30' })))
        .candidates,
    ).toHaveLength(1);
  });

  it('hashes the notice text, so an edited notice is reported again', async () => {
    const first = await check(makeHarness({ behavior: [], board: [boardRow()] }));
    const edited = await check(
      makeHarness({ behavior: [], board: [boardRow({ eventText: 'שונה' })] }),
    );

    expect(first.candidates[0].contentHash).not.toBe(edited.candidates[0].contentHash);
  });
});
