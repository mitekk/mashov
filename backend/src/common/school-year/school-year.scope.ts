import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { calendarSchoolYear } from './school-year.service';

const logger = new Logger('SchoolYearScope');

/**
 * How far back `MASHOV_YEAR` is allowed to reach. Each extra year is a
 * separate upstream login plus a per-student fetch across eight task types,
 * so the window is capped rather than trusted.
 */
export const MAX_HISTORY_YEARS = 2;

/**
 * Rows written before the `schoolYear` column existed carry 0 until
 * `backend/scripts/backfill-school-year.ts` rewrites them. Including 0 keeps a
 * half-migrated database showing data instead of a blank screen; once the
 * backfill has run there are no 0 rows left and the scope is exact.
 */
export const UNSCOPED_SCHOOL_YEAR = 0;

/**
 * The current year alone — "what is true now", and every staleness signal.
 *
 * Staleness reads must never widen to the history window: a child with
 * nothing yet this year would otherwise report last June's homework as their
 * latest update, which is the exact blindness that hid the frozen-year bug
 * for five months.
 */
export function currentYearScope(schoolYear: number): {
  schoolYear: { in: number[] };
} {
  return { schoolYear: { in: [schoolYear, UNSCOPED_SCHOOL_YEAR] } };
}

/**
 * The original name for the current-year fragment, kept because it is already
 * correct at every call site that stays single-year. Prefer `currentYearScope`
 * in new code, where the contrast with `historyScope` is the point.
 */
export const schoolYearScope = currentYearScope;

/** Both ends of the configured history window, inclusive. */
export interface SchoolYearWindow {
  start: number;
  current: number;
}

/**
 * The configured history window, for lists and feeds where more data is the
 * point. `0` is included for the same reason `currentYearScope` includes it.
 */
export function historyScope(window: SchoolYearWindow): {
  OR: Array<{ schoolYear: number } | { schoolYear: { gte: number; lte: number } }>;
} {
  return {
    OR: [
      { schoolYear: UNSCOPED_SCHOOL_YEAR },
      { schoolYear: { gte: window.start, lte: window.current } },
    ],
  };
}

/**
 * Resolves both ends of the window.
 *
 * `MASHOV_YEAR` is the *earliest* year to reach back to; it has no say in
 * which year is current. Unset, the window is one year wide and the behaviour
 * is identical to the single-year scope. A value above the current year would
 * make the window empty and hide the live year, so it is refused rather than
 * honoured — the variable must not be able to break that property again.
 */
export async function schoolYearWindowFor(
  prisma: PrismaService,
  config: ConfigService,
  userId?: string,
): Promise<SchoolYearWindow> {
  const current = await currentSchoolYearFor(prisma, userId);
  return { start: historyStartYear(current, config), current };
}

/**
 * The earliest year to fetch, given the current one. Exported because the
 * backfill resolves it per connection from that connection's own current
 * year, rather than from a user's resolved year.
 */
export function historyStartYear(current: number, config: ConfigService): number {
  const configured = readStartYear(config);
  if (configured === null) return current;

  if (configured > current) {
    logger.warn(
      `MASHOV_YEAR=${configured} is later than the current school year ${current}; ignoring it. It is the earliest year to fetch, not the year in scope.`,
    );
    return current;
  }

  const floor = current - MAX_HISTORY_YEARS;
  if (configured < floor) {
    logger.warn(
      `MASHOV_YEAR=${configured} reaches further back than ${MAX_HISTORY_YEARS} years; clamping the start year to ${floor}.`,
    );
    return floor;
  }

  return configured;
}

function readStartYear(config: ConfigService): number | null {
  const raw = config.get<string | number>('MASHOV_YEAR');
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The year a user's reads should be scoped to: their connection's own year,
 * which the sync tasks also write with, falling back to the calendar when they
 * have no connection yet.
 *
 * Takes `prisma` rather than being a method so the read-side services can use
 * it without taking on a new constructor dependency.
 */
export async function currentSchoolYearFor(
  prisma: PrismaService,
  userId?: string,
): Promise<number> {
  const connection = await prisma.householdConnection.findFirst({
    where: { active: true, ...(userId ? { userId } : {}) },
    orderBy: [{ schoolYear: 'desc' }, { lastLoginAt: 'desc' }],
    select: { schoolYear: true },
  });

  return connection?.schoolYear && connection.schoolYear > 0
    ? connection.schoolYear
    : calendarSchoolYear(new Date());
}
