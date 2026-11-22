/**
 * Breaks are derived, never fetched.
 *
 * `GET /api/bells` answers with lesson periods only — recess is the gap
 * between one period's end and the next one's start (ADR-0037). Deriving it
 * server-side keeps one implementation for the timetable read path and for
 * whatever the digest grows to need, and makes the bundled default schedule
 * produce breaks on exactly the same rules as a school's own.
 */

/** A lesson period's clock window, both ends as "HH:MM". */
export interface BellPeriod {
  lesson: number;
  startTime: string;
  endTime: string;
}

export type BreakKind = 'recess' | 'lunch';

/** The gap after `afterLesson`, with the day's one meal break marked. */
export interface BellBreak {
  afterLesson: number;
  startTime: string;
  endTime: string;
  minutes: number;
  kind: BreakKind;
}

/**
 * Below this a gap is changeover, not recess. A one-minute "break" between
 * two back-to-back periods is noise in a grid, not information.
 */
export const MIN_BREAK_MINUTES = 5;

/**
 * Above this a gap is not a break at all. A split-day schedule — morning
 * periods, a three-hour hole, afternoon periods — would otherwise render a
 * "recess" the child spends at home.
 */
export const MAX_BREAK_MINUTES = 90;

/** The shortest gap that can plausibly be the day's meal break. */
export const LUNCH_MIN_MINUTES = 20;

/**
 * Minutes since midnight, or `null` for anything that is not a wall clock
 * reading. Accepts "H:MM", "HH:MM" and "HH:MM:SS" — the upstream serves the
 * last of those and the database stores the second.
 */
export function clockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23) return null;
  return hours * 60 + minutes;
}

/** "08:15:00" and "8:15" alike become "08:15"; anything else becomes `null`. */
export function normalizeClock(value: unknown): string | null {
  const total = clockMinutes(value);
  if (total === null) return null;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Periods in clock order, with unusable rows dropped. */
function usablePeriods(periods: BellPeriod[]): BellPeriod[] {
  return periods
    .filter(
      (period) =>
        Number.isInteger(period.lesson) &&
        period.lesson > 0 &&
        clockMinutes(period.startTime) !== null &&
        clockMinutes(period.endTime) !== null,
    )
    .sort((left, right) => left.lesson - right.lesson);
}

/**
 * The breaks between a day's periods, at most one of them a lunch.
 *
 * Lesson numbers need not be contiguous: a school that skips period 5 still
 * has a gap between 4 and 6, and it is a real break.
 */
export function deriveBreaks(periods: BellPeriod[]): BellBreak[] {
  const sorted = usablePeriods(periods);
  const breaks: BellBreak[] = [];

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    const minutes = clockMinutes(next.startTime)! - clockMinutes(current.endTime)!;
    if (minutes < MIN_BREAK_MINUTES || minutes > MAX_BREAK_MINUTES) continue;

    breaks.push({
      afterLesson: current.lesson,
      startTime: normalizeClock(current.endTime)!,
      endTime: normalizeClock(next.startTime)!,
      minutes,
      kind: 'recess',
    });
  }

  // Exactly one lunch per day, because a parent reading two "הפסקת אוכל" rows
  // learns nothing about which one the child eats in. Strictly-greater keeps
  // the EARLIEST of equal-length candidates, which is the likelier meal.
  let lunchIndex = -1;
  breaks.forEach((candidate, index) => {
    if (candidate.minutes < LUNCH_MIN_MINUTES) return;
    if (lunchIndex === -1 || candidate.minutes > breaks[lunchIndex].minutes) {
      lunchIndex = index;
    }
  });
  if (lunchIndex >= 0) breaks[lunchIndex] = { ...breaks[lunchIndex], kind: 'lunch' };

  return breaks;
}
