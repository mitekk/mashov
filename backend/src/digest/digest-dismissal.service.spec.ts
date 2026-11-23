import {
  DigestDismissalService,
  LAST_DIGEST_RUN_MINUTES,
  MAX_POST_DISMISSAL_GRACE_MINUTES,
} from './digest-dismissal.service';
import { DEFAULT_BELL_SCHEDULE } from '../common/bells/default-bell-schedule';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';

/**
 * Weekday anchors as UTC midnights, matching digest-deadline.service.spec.ts:
 * 2026-11-15 is a Sunday, so the 16th is a Monday, the 20th a Friday and the
 * 21st a Saturday. Every date the digest handles is UTC midnight of a Jerusalem
 * calendar day, which is what `jerusalemDayBounds` produces.
 */
const MONDAY = new Date('2026-11-16T00:00:00Z');
const FRIDAY = new Date('2026-11-20T00:00:00Z');
const SATURDAY = new Date('2026-11-21T00:00:00Z');

const SCHOOL_YEAR = 2027;
const STUDENT = 'stu-1';

/** Minutes since midnight, so the expectations read as clock times. */
function at(hours: number, minutes: number): number {
  return hours * 60 + minutes;
}

interface HarnessOptions {
  /** Timetable rows for the child, across the whole week. */
  timetable?: { day: number; lesson: number }[];
  /** `bell_schedule` rows the school serves, if any. */
  bells?: { lesson: number; startTime: string; endTime: string }[];
  /** `null` detaches the child from any household connection. */
  connectionId?: string | null;
  env?: Record<string, string>;
}

function makeHarness(options: HarnessOptions = {}) {
  const timetable = options.timetable ?? [];
  const connectionId = options.connectionId === undefined ? 'conn-1' : options.connectionId;

  // Honours `where.day`, as Postgres would. This is the whole point of the
  // first test: a mock that answered every weekday's rows regardless would
  // report a per-day lookup as working while the service took the week's
  // maximum.
  const timetableFindMany = jest.fn().mockImplementation(({ where }) =>
    timetable
      .filter((row) => where?.day === undefined || row.day === where.day)
      .map((row) => ({ lesson: row.lesson })),
  );

  const bellFindMany = jest.fn().mockResolvedValue(options.bells ?? []);

  const prisma = {
    timetableEntry: { findMany: timetableFindMany },
    student: {
      findUnique: jest.fn().mockResolvedValue({ householdConnectionId: connectionId }),
    },
    householdConnection: {
      // Both callers of this read go through one mock: bellScheduleForConnection
      // asks for `schoolCode`, schoolYearForConnection for `schoolYear`.
      findUnique: jest
        .fn()
        .mockResolvedValue(
          connectionId ? { schoolCode: 12345, schoolYear: SCHOOL_YEAR } : null,
        ),
      findFirst: jest.fn().mockResolvedValue({ schoolYear: SCHOOL_YEAR }),
    },
    bellSchedule: { findMany: bellFindMany },
  } as unknown as PrismaService;

  const config = {
    get: jest.fn((key: string) => (options.env ?? {})[key]),
  } as unknown as ConfigService;

  const service = new DigestDismissalService(prisma, config);

  return { service, prisma, config, timetableFindMany, bellFindMany };
}

describe('DigestDismissalService.gateFor', () => {
  it('gates on the last lesson of *today*, not the busiest day of the week', async () => {
    // The defect this exists to prevent: a child with eight periods on Monday
    // and four on Friday must be released at ~11:20 on Friday, not held until
    // 15:00 because Monday is longer. Nothing else in the backend filters
    // timetable_entry by day, so this is the first query that has to.
    const harness = makeHarness({
      timetable: [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((lesson) => ({ day: 2, lesson })),
        ...[1, 2, 3, 4].map((lesson) => ({ day: 6, lesson })),
      ],
    });

    const friday = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);
    const monday = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, MONDAY);

    // Default schedule: lesson 4 ends 11:20, lesson 8 ends 15:00.
    expect(friday).toMatchObject({ lastLesson: 4, lastLessonEnd: '11:20' });
    expect(friday.releaseAtMinutes).toBe(at(11, 50));
    expect(monday).toMatchObject({ lastLesson: 8, lastLessonEnd: '15:00' });
    expect(monday.releaseAtMinutes).toBe(at(15, 30));
  });

  it('scopes the timetable lookup to the child, the school year and today', async () => {
    const harness = makeHarness({ timetable: [{ day: 6, lesson: 3 }] });

    await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(harness.timetableFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ studentGuid: STUDENT, day: 6 }),
      }),
    );
    const { where } = harness.timetableFindMany.mock.calls[0][0];
    expect(where.schoolYear.in).toContain(SCHOOL_YEAR);
  });

  it("prefers the school's own bell rows over the bundled default", async () => {
    // A school that serves /api/bells is authoritative; the default is a guess
    // (ADR-0037), and reporting which one answered is why `source` exists.
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 2 }],
      bells: [
        { lesson: 1, startTime: '07:30', endTime: '08:15' },
        { lesson: 2, startTime: '08:20', endTime: '09:05' },
      ],
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate).toMatchObject({ source: 'school', lastLesson: 2, lastLessonEnd: '09:05' });
    expect(gate.releaseAtMinutes).toBe(at(9, 35));
  });

  it('reports the bundled default as such when the school serves no rows', async () => {
    const harness = makeHarness({ timetable: [{ day: 6, lesson: 1 }] });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate.source).toBe('default');
  });

  it('falls back to the latest covered period when the schedule is short', async () => {
    // A ninth-period child on a schedule that stops at eight. Holding until
    // the last bell anybody knows about is the honest answer; refusing to gate
    // would send the partial 11:00 digest this feature exists to stop.
    const harness = makeHarness({ timetable: [{ day: 6, lesson: 9 }] });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    const last = DEFAULT_BELL_SCHEDULE[DEFAULT_BELL_SCHEDULE.length - 1];
    expect(gate).toMatchObject({ lastLesson: 9, lastLessonEnd: last.endTime });
    expect(gate.releaseAtMinutes).toBe(at(15, 30));
  });

  it('falls back to the latest period at or below the lesson number', async () => {
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 5 }],
      // A gappy schedule: no row for lesson 5, so lesson 3 is the latest the
      // child's day is known to have reached.
      bells: [
        { lesson: 1, startTime: '08:00', endTime: '08:45' },
        { lesson: 3, startTime: '09:45', endTime: '10:30' },
        { lesson: 7, startTime: '13:25', endTime: '14:10' },
      ],
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate).toMatchObject({ lastLesson: 5, lastLessonEnd: '10:30' });
    expect(gate.releaseAtMinutes).toBe(at(11, 0));
  });

  it('falls back to the EARLIEST period when the lesson is below every bell row', async () => {
    // A schedule whose rows start at lesson 2 against a child whose only lesson
    // today is 1 -- which a school's malformed lesson-1 row produces, since
    // `toPeriod` silently drops an unusable one. Lesson 1 must end before
    // lesson 2 begins, so the earliest row is the only bound the schedule
    // supports. The latest row would hold a first-grader until the end of the
    // whole school day, which is the opposite of what is known about them.
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 1 }],
      bells: [
        { lesson: 2, startTime: '08:50', endTime: '09:35' },
        { lesson: 10, startTime: '16:00', endTime: '16:45' },
      ],
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate).toMatchObject({ lastLesson: 1, lastLessonEnd: '09:35' });
    expect(gate.releaseAtMinutes).toBe(at(10, 5));
  });

  it('does not gate when the child has no timetable rows for today', async () => {
    // A holiday, or a child whose timetable has never synced. Missing data must
    // never hold a digest: the behaviour is exactly what it was before the gate.
    const harness = makeHarness({ timetable: [{ day: 2, lesson: 8 }] });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate.releaseAtMinutes).toBeNull();
    expect(gate.lastLesson).toBeNull();
  });

  it('does not gate at all on a Saturday', async () => {
    // Saturday maps to Mashov day 7, which no lesson row can match, so the
    // lookup is empty and the gate opens. Asserted separately because a
    // Saturday run must never be held waiting for a bell that will not ring.
    const harness = makeHarness({
      timetable: [1, 2, 3, 4, 5, 6].flatMap((day) => [{ day, lesson: 8 }]),
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, SATURDAY);

    expect(gate.releaseAtMinutes).toBeNull();
  });

  it('does not gate when the resolved schedule has no usable period', async () => {
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 2 }],
      bells: [{ lesson: 0, startTime: 'not a clock', endTime: '' }],
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    // The unusable row is dropped, which leaves no school rows at all, so the
    // bundled default answers instead -- `bellScheduleForStudent` never hands
    // back an empty schedule. The point is that it is still a usable gate.
    expect(gate.source).toBe('default');
    // Default lesson 2 ends 09:35, plus the 30-minute default grace.
    expect(gate.releaseAtMinutes).toBe(at(10, 5));
  });

  it('gates on the bell itself when the grace period is zero', async () => {
    // A `0` must mean "no grace", not "fall back to the default" -- which is
    // exactly what readDays in digest.service.ts would do with it.
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 4 }],
      env: { DIGEST_POST_DISMISSAL_GRACE_MINUTES: '0' },
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate.releaseAtMinutes).toBe(at(11, 20));
  });

  it('honours a configured grace period', async () => {
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 4 }],
      env: { DIGEST_POST_DISMISSAL_GRACE_MINUTES: '45' },
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate.releaseAtMinutes).toBe(at(12, 5));
  });

  it('falls back to 30 minutes for a non-numeric or negative grace period', async () => {
    for (const raw of ['abc', '', '-10', '2.5']) {
      const harness = makeHarness({
        timetable: [{ day: 6, lesson: 4 }],
        env: { DIGEST_POST_DISMISSAL_GRACE_MINUTES: raw },
      });

      const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

      expect(gate.releaseAtMinutes).toBe(at(11, 50));
    }
  });

  it('still gates a child with no household connection, on the default schedule', async () => {
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 4 }],
      connectionId: null,
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate).toMatchObject({ source: 'default', lastLesson: 4 });
    expect(gate.releaseAtMinutes).toBe(at(11, 50));
  });
  it('never holds past the last cron tick of the day', async () => {
    // The gate has no catch-up run to fall back on, and the behaviour
    // candidate window is strictly today (digest-checker.service.ts's
    // behaviorToday matches lessonDate OR eventAt inside today only). A
    // release time after the final tick would therefore hold every tick, let
    // the day end, and lose that child's behaviour permanently -- turning the
    // delay this feature is built on into silent suppression. A slightly early
    // message is the right trade.
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 9 }],
      bells: [{ lesson: 9, startTime: '17:55', endTime: '18:40' }],
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    // 18:40 + 30 would be 19:10, past the 19:00 tick.
    expect(gate.lastLessonEnd).toBe('18:40');
    expect(gate.releaseAtMinutes).toBe(LAST_DIGEST_RUN_MINUTES);
  });

  it('leaves a release time inside the window alone', async () => {
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 8 }],
      bells: [{ lesson: 8, startTime: '17:00', endTime: '17:45' }],
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate.releaseAtMinutes).toBe(at(18, 15));
  });

  it('clamps an absurd grace period instead of suppressing the digest', async () => {
    // `30000` is what someone reads off the neighbouring DIGEST_LLM_TIMEOUT_MS
    // and copies as milliseconds. Unbounded, any value past a few hours holds
    // every child at every tick on every day, forever, with no delivery row to
    // show for it.
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 4 }],
      env: { DIGEST_POST_DISMISSAL_GRACE_MINUTES: '1800' },
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    // Default lesson 4 ends 11:20, plus the clamped maximum.
    expect(gate.releaseAtMinutes).toBe(at(11, 20) + MAX_POST_DISMISSAL_GRACE_MINUTES);
  });

  it('accepts a grace period at the maximum', async () => {
    const harness = makeHarness({
      timetable: [{ day: 6, lesson: 4 }],
      env: {
        DIGEST_POST_DISMISSAL_GRACE_MINUTES: String(MAX_POST_DISMISSAL_GRACE_MINUTES),
      },
    });

    const gate = await harness.service.gateFor(STUDENT, SCHOOL_YEAR, FRIDAY);

    expect(gate.releaseAtMinutes).toBe(at(11, 20) + MAX_POST_DISMISSAL_GRACE_MINUTES);
  });
});
