import {
  DigestDeadlineService,
  hasDeadlineHint,
  jerusalemClockMinutes,
  jerusalemDayBounds,
  mashovDayFromJsDate,
} from './digest-deadline.service';
import type { PrismaService } from '../prisma/prisma.service';

const JERUSALEM = 'Asia/Jerusalem';

/**
 * Weekday anchors, derived once so the tests read as calendar facts rather than
 * as arithmetic: 2026-11-15 is a Sunday, so 11-20 is a Friday and 11-21 a
 * Saturday. 2026-11-17 being a Tuesday matches the comment in
 * freshness.service.spec.ts.
 *
 * Written as UTC instants on purpose. Every date the digest handles is UTC
 * midnight of a Jerusalem calendar day -- that is what jerusalemDayBounds
 * produces and what Mashov's naive timestamps become in a UTC container -- so
 * the weekday helper reads UTC fields and these anchors have to match. Local
 * midnights here would pass on a UTC machine and fail on the developer's.
 */
const SUNDAY = new Date('2026-11-15T00:00:00Z');
const TUESDAY = new Date('2026-11-17T00:00:00Z');
const FRIDAY = new Date('2026-11-20T00:00:00Z');
const SATURDAY = new Date('2026-11-21T00:00:00Z');

function makeMockPrisma(days: number[]) {
  return {
    timetableEntry: {
      findMany: jest.fn().mockResolvedValue(days.map((day) => ({ day }))),
    },
  } as unknown as PrismaService;
}

describe('mashovDayFromJsDate', () => {
  // apis/get-api-students-id-timetable.md documents `day` as 1 = Sunday ... 6 =
  // Friday (Israeli school week), so the conversion is jsGetDay() + 1. An
  // off-by-one here silently shifts every deadline estimate by a day, which is
  // why this lives in its own named helper with its own test.
  it('maps Sunday to 1, the first day of the Israeli school week', () => {
    expect(mashovDayFromJsDate(SUNDAY)).toBe(1);
  });

  it('maps Friday to 6, the last day that can carry a lesson', () => {
    expect(mashovDayFromJsDate(FRIDAY)).toBe(6);
  });

  it('maps Saturday to 7, which no lesson can ever match', () => {
    expect(mashovDayFromJsDate(SATURDAY)).toBe(7);
  });
});

describe('jerusalemDayBounds', () => {
  // Mashov sends naive local timestamps ("2025-09-05T00:00:00") and a UTC
  // container stores those as ...T00:00:00Z. So "today's rows" means UTC
  // midnight of the *Jerusalem* calendar day, never startOfDay(new Date()).
  it('builds UTC-midnight bounds from the Jerusalem date in winter (UTC+2)', () => {
    const bounds = jerusalemDayBounds(new Date('2027-01-14T21:30:00Z'), JERUSALEM);

    expect(bounds.todayStart.toISOString()).toBe('2027-01-14T00:00:00.000Z');
    expect(bounds.tomorrowStart.toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('rolls to the next day once Jerusalem is past midnight but UTC is not', () => {
    // 22:30Z in January is 00:30 the next day in Jerusalem. A naive UTC
    // startOfDay would report the previous school day here.
    const bounds = jerusalemDayBounds(new Date('2027-01-14T22:30:00Z'), JERUSALEM);

    expect(bounds.todayStart.toISOString()).toBe('2027-01-15T00:00:00.000Z');
    expect(bounds.tomorrowStart.toISOString()).toBe('2027-01-16T00:00:00.000Z');
  });

  it('builds UTC-midnight bounds from the Jerusalem date in summer (UTC+3)', () => {
    // 21:30Z in July is 00:30 the next day in Jerusalem — the DST offset moves
    // the boundary an hour earlier than in January.
    const bounds = jerusalemDayBounds(new Date('2027-07-14T21:30:00Z'), JERUSALEM);

    expect(bounds.todayStart.toISOString()).toBe('2027-07-15T00:00:00.000Z');
    expect(bounds.tomorrowStart.toISOString()).toBe('2027-07-16T00:00:00.000Z');
  });

  it('keeps a 22:00 Jerusalem evening on its own school day', () => {
    const bounds = jerusalemDayBounds(new Date('2027-07-14T19:00:00Z'), JERUSALEM);

    expect(bounds.todayStart.toISOString()).toBe('2027-07-14T00:00:00.000Z');
  });

  it('reports the school day the digest covers as that same UTC midnight', () => {
    const bounds = jerusalemDayBounds(new Date('2027-07-14T19:00:00Z'), JERUSALEM);

    expect(bounds.reportFor.toISOString()).toBe('2027-07-14T00:00:00.000Z');
  });
});

describe('jerusalemClockMinutes', () => {
  // The dismissal gate compares a bell time -- minutes since midnight, with no
  // zone of its own -- against the wall clock in Jerusalem. The process is
  // pinned to UTC (src/common/process-zone.ts), so now.getHours() is not an
  // option and this has to go through Intl like jerusalemDayBounds does.
  it('reads the winter wall clock (UTC+2)', () => {
    expect(jerusalemClockMinutes(new Date('2027-01-14T11:00:00Z'), JERUSALEM)).toBe(13 * 60);
  });

  it('reads the summer wall clock (UTC+3)', () => {
    // The same instant-of-day reads an hour later in July. A gate built on UTC
    // would hold every child an hour too long for seven months of the year.
    expect(jerusalemClockMinutes(new Date('2027-07-14T11:00:00Z'), JERUSALEM)).toBe(14 * 60);
  });

  it('crosses the DST spring-forward boundary', () => {
    // Israel springs forward on the Friday before the last Sunday of March;
    // in 2027 that is 2027-03-26 at 02:00 local. 00:30Z on the 26th is 02:30
    // local -- the clock has already jumped.
    expect(jerusalemClockMinutes(new Date('2027-03-25T23:30:00Z'), JERUSALEM)).toBe(
      1 * 60 + 30,
    );
    expect(jerusalemClockMinutes(new Date('2027-03-26T00:30:00Z'), JERUSALEM)).toBe(
      3 * 60 + 30,
    );
  });

  it('reads Jerusalem midnight as 0, not 1440', () => {
    // hour12: false alone reports "24" for midnight on some ICU builds, which
    // would read as 1440 and hold every child's digest for a whole day. 22:00Z
    // in January is 00:00 the next day in Jerusalem.
    expect(jerusalemClockMinutes(new Date('2027-01-14T22:00:00Z'), JERUSALEM)).toBe(0);
  });

  it('reads a UTC midnight whose Jerusalem date is already tomorrow', () => {
    // 00:00Z is 02:00 local in winter: a new Jerusalem day, two hours in.
    expect(jerusalemClockMinutes(new Date('2027-01-15T00:00:00Z'), JERUSALEM)).toBe(2 * 60);
  });
});

describe('hasDeadlineHint', () => {
  // Deliberately widening: it pulls rows into the candidate set so the LLM can
  // later resolve an explicit deadline the timetable would have missed. The LLM
  // then narrows. This is why the LLM cannot be the gate — the checker stays
  // LLM-free.
  it.each([
    ['מחר', 'להביא מחר את החוברת'],
    ['עד יום', 'להגיש עד יום חמישי'],
    ['להגיש', 'יש להגיש את העבודה'],
    ['a numeric date', 'מבחן בתאריך 25/11'],
  ])('matches %s', (_label, text) => {
    expect(hasDeadlineHint(text)).toBe(true);
  });

  it('does not match ordinary homework prose', () => {
    expect(hasDeadlineHint('לקרוא פרק 3 ולענות על השאלות')).toBe(false);
  });

  it('treats empty text as no hint', () => {
    expect(hasDeadlineHint('')).toBe(false);
  });
});

describe('DigestDeadlineService.estimateFromTimetable', () => {
  it('returns tomorrow when the group meets tomorrow', async () => {
    // Wednesday = Mashov day 4; fromDate is Tuesday, so tomorrow matches.
    const service = new DigestDeadlineService(makeMockPrisma([4]));

    const next = await service.estimateFromTimetable('stu-1', 2027, 55, TUESDAY);

    expect(next?.toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });

  it('walks past the weekend to the next day the group actually meets', async () => {
    // Group meets Sunday (1) and Tuesday (3). From Tuesday, the next slot is
    // the following Sunday — Saturday can never match.
    const service = new DigestDeadlineService(makeMockPrisma([1, 3]));

    const next = await service.estimateFromTimetable('stu-1', 2027, 55, TUESDAY);

    expect(next?.toISOString()).toBe('2026-11-22T00:00:00.000Z');
  });

  it('returns null when the group has no timetable entries', async () => {
    const service = new DigestDeadlineService(makeMockPrisma([]));

    await expect(
      service.estimateFromTimetable('stu-1', 2027, 55, TUESDAY),
    ).resolves.toBeNull();
  });

  it('scopes the timetable lookup to the child and school year', async () => {
    const prisma = makeMockPrisma([4]);
    const service = new DigestDeadlineService(prisma);

    await service.estimateFromTimetable('stu-1', 2027, 55, TUESDAY);

    const where = (prisma.timetableEntry.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.studentGuid).toBe('stu-1');
    expect(where.groupId).toBe(55);
    // Legacy rows carry schoolYear 0 until the backfill runs, and the shared
    // scope helper includes them so a half-migrated database still shows data.
    expect(where.schoolYear).toEqual({ in: [2027, 0] });
  });
});
