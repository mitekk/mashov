import { Injectable, Logger } from '@nestjs/common';
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

/**
 * The ceiling on the configured grace period.
 *
 * Unbounded, a value read as milliseconds -- which the neighbouring
 * `DIGEST_LLM_TIMEOUT_MS=30000` openly invites -- pushes every child's release
 * past the end of the day, at which point no child is ever sent a digest
 * again and no delivery row records it. Three hours is well past anything a
 * register takes to fill in, so a larger value is a mistake rather than a
 * preference. Clamped and warned about, on `historyStartYear`'s precedent in
 * school-year.scope.ts.
 */
export const MAX_POST_DISMISSAL_GRACE_MINUTES = 180;

/**
 * The last tick of the digest cron, as minutes since Jerusalem midnight. Must
 * match the end of the window in `tasks/digest.task.ts` -- digest.task.spec.ts
 * asserts the two agree, because this constant is what stops a hold from
 * outliving the day.
 */
export const LAST_DIGEST_RUN_MINUTES = 19 * 60;

export interface DismissalGate {
  /**
   * Minutes since Jerusalem midnight before which nothing may be sent, or
   * `null` for "do not gate" -- which is the answer whenever the data needed
   * to decide is missing. Missing data must never hold a digest back.
   *
   * Never later than `LAST_DIGEST_RUN_MINUTES`, so it can differ from
   * `lastLessonEnd + grace` for a child who finishes very late. See `gateFor`.
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
 * (ADR-0026, ADR-0040). This joins the child's own timetable to their school's
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
  private readonly logger = new Logger(DigestDismissalService.name);

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

    // Clamped to the last tick of the cron, and this is not a nicety. There is
    // no catch-up run, and the behaviour candidate window is strictly today
    // (`behaviorToday` in digest-checker.service.ts matches `lessonDate` OR
    // `eventAt` inside today only). A release time past the final tick would
    // hold every tick, let the day end, and lose that child's behaviour
    // permanently -- which is exactly the suppression this feature's
    // delay-only property exists to rule out. A school with a late afternoon
    // programme gets a slightly early message instead of none.
    return {
      releaseAtMinutes: Math.min(end + this.graceMinutes(), LAST_DIGEST_RUN_MINUTES),
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
    if (!Number.isInteger(parsed) || parsed < 0) {
      return DEFAULT_POST_DISMISSAL_GRACE_MINUTES;
    }
    if (parsed > MAX_POST_DISMISSAL_GRACE_MINUTES) {
      this.logger.warn(
        `DIGEST_POST_DISMISSAL_GRACE_MINUTES=${parsed} is longer than a school day's worth of ` +
          `slack; clamping to ${MAX_POST_DISMISSAL_GRACE_MINUTES} minutes. It is minutes after ` +
          `the last bell, not milliseconds.`,
      );
      return MAX_POST_DISMISSAL_GRACE_MINUTES;
    }
    return parsed;
  }
}

/**
 * The period that ends the child's day.
 *
 * A schedule that does not cover the lesson number is the interesting case,
 * and the two directions want opposite answers.
 *
 * *Above* every row -- a ninth-period child on an eight-period schedule --
 * takes the latest row at or below the number: that is the last bell anybody
 * knows about, and it still beats sending at 11:00.
 *
 * *Below* every row -- a first-grader whose only lesson is 1 against a
 * schedule whose rows start at 2, which is what a school's malformed lesson-1
 * row produces, since `toPeriod` silently drops an unusable one -- takes the
 * **earliest** row. Lesson 1 must end before lesson 2 begins, so the earliest
 * row is the only bound the schedule supports; the latest would hold that
 * child until the end of the whole school day, which is the opposite of what
 * is known about them.
 */
function periodFor(periods: BellPeriod[], lastLesson: number): BellPeriod | null {
  if (periods.length === 0) return null;

  const byLesson = [...periods].sort((a, b) => a.lesson - b.lesson);

  const exact = byLesson.find((period) => period.lesson === lastLesson);
  if (exact) return exact;

  const covered = byLesson.filter((period) => period.lesson <= lastLesson).pop();
  if (covered) return covered;

  return byLesson[0] ?? null;
}
