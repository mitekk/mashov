import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { schoolYearScope } from '../common/school-year/school-year.scope';
import { bellScheduleForStudent } from '../common/bells/bells.service';
import type { BellScheduleSource } from '../common/bells/bells.service';
import { clockMinutes } from '../common/bells/derive-breaks';
import type { BellPeriod } from '../common/bells/derive-breaks';
import { mashovDayFromJsDate } from './digest-deadline.service';

/**
 * How long after the last bell the register has plausibly been filled in.
 *
 * Half an hour is a guess, but a conservative one: a teacher entering the
 * day's behaviour notes as the children leave is the ordinary case, and the
 * cost of waiting is that the first message of the day arrives at 12:00
 * instead of 11:30 -- against the cost of sending a report that is missing
 * half the day.
 */
export const DEFAULT_POST_DISMISSAL_GRACE_MINUTES = 30;

export interface DismissalGate {
  /**
   * Minutes since Jerusalem midnight before which nothing may be sent, or
   * `null` for "do not gate" -- which is the answer whenever the data needed
   * to decide is missing. Missing data must never hold a digest back.
   */
  releaseAtMinutes: number | null;
  lastLesson: number | null;
  /** "HH:MM", carried for the debug line rather than for any arithmetic. */
  lastLessonEnd: string | null;
  /** Whose clock answered: the school's own rows, or the bundled default. */
  source: BellScheduleSource | null;
}

const OPEN: DismissalGate = {
  releaseAtMinutes: null,
  lastLesson: null,
  lastLessonEnd: null,
  source: null,
};

/**
 * When one child's school day ends, and therefore when their digest may go.
 *
 * The digest used to fire on a fixed 13:00-19:00 clock, which meant a child
 * still in class at 13:00 produced a message, then another at 14:00, each one
 * a partial picture of a day the teachers had not finished recording
 * (ADR-0026, ADR-0038). This joins the child's own timetable to their school's
 * bell schedule to answer the question the fixed window could only guess at.
 *
 * Two deliberate properties:
 *
 * - It only ever *delays*. Every path that cannot answer confidently returns
 *   `OPEN`, which behaves exactly as the feature did before this existed.
 * - Nothing here turns a bell time into a `Date`. Bell times are zone-less
 *   "HH:MM" strings end to end (ADR-0037); comparing minutes-since-midnight
 *   against minutes-since-midnight is the whole arithmetic, and introducing a
 *   `Date` would reintroduce the DST question the strings exist to avoid.
 */
@Injectable()
export class DigestDismissalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async gateFor(
    studentGuid: string,
    schoolYear: number,
    todayStart: Date,
  ): Promise<DismissalGate> {
    const day = mashovDayFromJsDate(todayStart);

    // The first query in the backend to filter timetable_entry by `day`. The
    // week's maximum is the wrong answer: a child with eight periods on Monday
    // and four on Friday must be released at lunchtime on Friday.
    const entries = await this.prisma.timetableEntry.findMany({
      where: { studentGuid, day, ...schoolYearScope(schoolYear) },
      select: { lesson: true },
    });

    // No rows is the common, benign case -- a Saturday (day 7 matches nothing),
    // a holiday, a child whose timetable has never synced. Do not gate.
    if (entries.length === 0) return OPEN;

    const lastLesson = Math.max(...entries.map((entry) => entry.lesson));

    const schedule = await bellScheduleForStudent(this.prisma, studentGuid);
    const period = periodFor(schedule.periods, lastLesson);
    if (!period) return OPEN;

    const end = clockMinutes(period.endTime);
    if (end === null) return OPEN;

    return {
      releaseAtMinutes: end + this.graceMinutes(),
      lastLesson,
      lastLessonEnd: period.endTime,
      source: schedule.source,
    };
  }

  /**
   * Its own reader rather than `digest.service.ts`'s `readDays`, which
   * requires `> 0`: a configured `0` must mean "gate on the bell itself", not
   * fall silently back to half an hour.
   */
  private graceMinutes(): number {
    const raw = this.config.get<string | number>('DIGEST_POST_DISMISSAL_GRACE_MINUTES');
    if (raw === undefined || raw === null || String(raw).trim().length === 0) {
      return DEFAULT_POST_DISMISSAL_GRACE_MINUTES;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0
      ? parsed
      : DEFAULT_POST_DISMISSAL_GRACE_MINUTES;
  }
}

/**
 * The period that ends the child's day.
 *
 * A schedule that does not cover the lesson number is the interesting case: a
 * ninth-period child on an eight-period schedule, or a school whose rows are
 * gappy. Holding until the latest bell the schedule *does* know about is the
 * honest answer -- it still beats sending at 11:00 -- and the last period
 * overall is the floor for a lesson number below every row.
 */
function periodFor(periods: BellPeriod[], lastLesson: number): BellPeriod | null {
  if (periods.length === 0) return null;

  const exact = periods.find((period) => period.lesson === lastLesson);
  if (exact) return exact;

  const covered = periods
    .filter((period) => period.lesson <= lastLesson)
    .sort((a, b) => a.lesson - b.lesson)
    .pop();
  if (covered) return covered;

  return [...periods].sort((a, b) => a.lesson - b.lesson).pop() ?? null;
}
