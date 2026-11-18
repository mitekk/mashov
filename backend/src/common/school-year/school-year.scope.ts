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

// ---------------------------------------------------------------------------
// Two schools, two years.
//
// Everything above is correct wherever a single student or a single year is
// known, and stays exactly as it is. What it cannot express is a household
// whose schools sit on different years -- which happens every September, when
// one school has opened the new year and the other has not. `currentYearScope`
// of one year then hides the other school's children entirely.
//
// The honest shape for a student-keyed table is an OR of (student-set, year)
// pairs: each connection contributes its own children at its own year. There
// is no single year that is right for the household, and picking one is the
// bug.
// ---------------------------------------------------------------------------

/** The year each of a household's active connections is on, keyed by id. */
export async function schoolYearByConnection(
  prisma: PrismaService,
  userId?: string,
): Promise<Map<string, number>> {
  const connections = await prisma.householdConnection.findMany({
    where: { active: true, ...(userId ? { userId } : {}) },
    select: { id: true, schoolYear: true },
  });

  const fallback = calendarSchoolYear(new Date());
  return new Map(
    connections.map((conn) => [
      conn.id,
      conn.schoolYear && conn.schoolYear > 0 ? conn.schoolYear : fallback,
    ]),
  );
}

/**
 * The year one connection is on, falling back to the household's.
 *
 * Takes the id rather than the student guid so a caller that already holds the
 * student row does not pay a second read for a column it is holding -- which
 * is every per-child endpoint, since they all load the child to authorise the
 * request first.
 */
export async function schoolYearForConnection(
  prisma: PrismaService,
  connectionId: string | null | undefined,
): Promise<number> {
  if (connectionId) {
    const connection = await prisma.householdConnection.findUnique({
      where: { id: connectionId },
      select: { schoolYear: true },
    });
    if (connection?.schoolYear && connection.schoolYear > 0) {
      return connection.schoolYear;
    }
  }

  // Unstamped, or stamped to a connection that has gone away. The household
  // fallback is what a single-school deployment has always used.
  return currentSchoolYearFor(prisma);
}

/**
 * The year ONE child's rows are written at, which is the year to read them at.
 *
 * Per-child endpoints use this rather than a household-wide year: the child
 * belongs to one school, that school is on one year, and the sync tasks stamp
 * that child's rows with it.
 *
 * Prefer `schoolYearForConnection` where the student row is already in hand.
 */
export async function currentSchoolYearForStudent(
  prisma: PrismaService,
  studentGuid: string,
): Promise<number> {
  const student = await prisma.student.findUnique({
    where: { studentGuid },
    select: { householdConnectionId: true },
  });

  return schoolYearForConnection(prisma, student?.householdConnectionId);
}

/** The history window ONE child's school spans. */
export async function schoolYearWindowForStudent(
  prisma: PrismaService,
  config: ConfigService,
  connectionId: string | null | undefined,
): Promise<SchoolYearWindow> {
  const current = await schoolYearForConnection(prisma, connectionId);
  return { start: historyStartYear(current, config), current };
}

/** The history window each of a household's connections spans. */
export async function schoolYearWindowsFor(
  prisma: PrismaService,
  config: ConfigService,
  userId?: string,
): Promise<Map<string, SchoolYearWindow>> {
  const byConnection = await schoolYearByConnection(prisma, userId);
  const windows = new Map<string, SchoolYearWindow>();
  for (const [connectionId, current] of byConnection) {
    windows.set(connectionId, { start: historyStartYear(current, config), current });
  }
  return windows;
}

/** A student-keyed where fragment: an OR of (that connection's children, its year). */
export type StudentYearScope = {
  OR: Array<
    | { schoolYear: number }
    | { studentGuid: { in: string[] }; schoolYear: { in: number[] } }
    | { studentGuid: { in: string[] }; schoolYear: { gte: number; lte: number } }
  >;
};

async function guidsByConnection(
  prisma: PrismaService,
  connectionIds: string[],
): Promise<Map<string, string[]>> {
  if (connectionIds.length === 0) return new Map();

  const students = await prisma.student.findMany({
    where: { householdConnectionId: { in: connectionIds } },
    select: { studentGuid: true, householdConnectionId: true },
  });

  const byConnection = new Map<string, string[]>();
  for (const student of students) {
    const key = student.householdConnectionId;
    if (!key) continue;
    const bucket = byConnection.get(key);
    if (bucket) bucket.push(student.studentGuid);
    else byConnection.set(key, [student.studentGuid]);
  }
  return byConnection;
}

/**
 * The current year for every child, each at their own school's year.
 *
 * `UNSCOPED_SCHOOL_YEAR` is admitted on its own, with no student predicate:
 * those are pre-migration rows that belong to whichever child they name, and
 * excluding them would blank a half-migrated database -- the same reason
 * `currentYearScope` admits it.
 *
 * With one connection this reduces to exactly `currentYearScope(thatYear)`
 * plus a `studentGuid IN (...)` that matches all of its children, so a
 * single-school deployment reads the same rows it always did.
 */
/**
 * Either shape a caller can thread into a `where`: one year for one child,
 * or the per-connection pairs for a cross-child read.
 */
export type YearScope = { schoolYear: { in: number[] } } | StudentYearScope;

export async function yearScopeForStudents(
  prisma: PrismaService,
  userId?: string,
): Promise<StudentYearScope> {
  const byConnection = await schoolYearByConnection(prisma, userId);
  const guids = await guidsByConnection(prisma, [...byConnection.keys()]);

  const OR: StudentYearScope['OR'] = [{ schoolYear: UNSCOPED_SCHOOL_YEAR }];
  for (const [connectionId, year] of byConnection) {
    const connectionGuids = guids.get(connectionId);
    if (!connectionGuids || connectionGuids.length === 0) continue;
    OR.push({
      studentGuid: { in: connectionGuids },
      schoolYear: { in: [year] },
    });
  }

  return { OR };
}

/** The configured history window for every child, each at their own school's. */
export async function historyScopeForStudents(
  prisma: PrismaService,
  config: ConfigService,
  userId?: string,
): Promise<StudentYearScope> {
  const windows = await schoolYearWindowsFor(prisma, config, userId);
  const guids = await guidsByConnection(prisma, [...windows.keys()]);

  const OR: StudentYearScope['OR'] = [{ schoolYear: UNSCOPED_SCHOOL_YEAR }];
  for (const [connectionId, window] of windows) {
    const connectionGuids = guids.get(connectionId);
    if (!connectionGuids || connectionGuids.length === 0) continue;
    OR.push({
      studentGuid: { in: connectionGuids },
      schoolYear: { gte: window.start, lte: window.current },
    });
  }

  return { OR };
}
