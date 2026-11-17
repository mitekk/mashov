import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { schoolYearScope } from '../common/school-year/school-year.scope';

/** How far ahead to look for a group's next lesson before giving up. */
const MAX_LOOKAHEAD_DAYS = 14;

/**
 * Mashov's timetable weekday for a date.
 *
 * `apis/get-api-students-id-timetable.md` documents `day` as
 * `1 = Sunday ... 6 = Friday` (the Israeli school week), so the conversion is
 * `getUTCDay() + 1`. Saturday therefore maps to 7 and can never match a lesson.
 *
 * Reads UTC fields because every date the digest handles is UTC midnight of a
 * Jerusalem calendar day. This is its own named helper because an off-by-one
 * here silently shifts every deadline estimate by a day.
 */
export function mashovDayFromJsDate(date: Date): number {
  return date.getUTCDay() + 1;
}

/** The day window a digest run covers, as UTC instants. */
export interface JerusalemDayBounds {
  /** UTC midnight of the Jerusalem calendar date. */
  todayStart: Date;
  /** UTC midnight of the following Jerusalem calendar date. */
  tomorrowStart: Date;
  /** The school day the report covers; same instant as `todayStart`. */
  reportFor: Date;
}

/**
 * The UTC-midnight bounds of the *Jerusalem* calendar day containing `now`.
 *
 * This is the single easiest thing in the feature to get wrong. Mashov sends
 * naive local timestamps ("2025-09-05T00:00:00") and a UTC container stores
 * those as `2025-09-05T00:00:00Z`, so "today's rows" means UTC midnight of the
 * Jerusalem date -- never `startOfDay(new Date())`, which in the hour before
 * midnight Jerusalem (and in summer, the two hours before) names the wrong
 * school day. The Jerusalem date is read through Intl so DST is the platform's
 * problem rather than ours.
 */
export function jerusalemDayBounds(now: Date, timeZone: string): JerusalemDayBounds {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const field = (type: 'year' | 'month' | 'day'): number =>
    Number(parts.find((part) => part.type === type)?.value);

  const year = field('year');
  const month = field('month');
  const day = field('day');

  const todayStart = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC normalises an overflowing day, so month and year ends need no
  // special casing.
  const tomorrowStart = new Date(Date.UTC(year, month - 1, day + 1));

  return { todayStart, tomorrowStart, reportFor: todayStart };
}

/**
 * Whether the Hebrew text looks like it names a deadline of its own.
 *
 * Deliberately widening: it pulls rows into the candidate set so the LLM can
 * later resolve an explicit deadline the timetable would have missed, and the
 * LLM then narrows. This is why the LLM's extraction cannot be the gate -- the
 * checker runs 7x/day/child and must stay free of model calls.
 */
export function hasDeadlineHint(text: string): boolean {
  if (!text) return false;
  return DEADLINE_HINTS.some((pattern) => pattern.test(text));
}

const DEADLINE_HINTS: RegExp[] = [
  /מחר/,
  /עד\s+יום/,
  /להגיש/,
  /הגשה/,
  /תאריך/,
  // A numeric date such as 25/11 or 25.11.26.
  /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/,
];

@Injectable()
export class DigestDeadlineService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The next calendar day on which this group actually meets, strictly after
   * `fromDate`, or null when the group has no timetable rows to reason from.
   *
   * This is the weaker half of the deadline estimate: an explicit date written
   * in the homework text beats it (see ADR-0026). It is an estimate either way
   * -- Mashov exposes no due-date field.
   */
  async estimateFromTimetable(
    studentGuid: string,
    schoolYear: number,
    groupId: number,
    fromDate: Date,
  ): Promise<Date | null> {
    const entries = await this.prisma.timetableEntry.findMany({
      where: { studentGuid, groupId, ...schoolYearScope(schoolYear) },
      select: { day: true },
    });

    const meetingDays = new Set(entries.map((entry) => entry.day));
    if (meetingDays.size === 0) return null;

    for (let offset = 1; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
      const candidate = new Date(
        Date.UTC(
          fromDate.getUTCFullYear(),
          fromDate.getUTCMonth(),
          fromDate.getUTCDate() + offset,
        ),
      );
      if (meetingDays.has(mashovDayFromJsDate(candidate))) return candidate;
    }

    return null;
  }
}
