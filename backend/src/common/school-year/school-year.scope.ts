import { PrismaService } from '../../prisma/prisma.service';
import { calendarSchoolYear } from './school-year.service';

/**
 * Rows written before the `schoolYear` column existed carry 0 until
 * `backend/scripts/backfill-school-year.ts` rewrites them. Including 0 keeps a
 * half-migrated database showing data instead of a blank screen; once the
 * backfill has run there are no 0 rows left and the scope is exact.
 */
export const UNSCOPED_SCHOOL_YEAR = 0;

/** The shared `where` fragment for every year-scoped read. */
export function schoolYearScope(schoolYear: number): {
  schoolYear: { in: number[] };
} {
  return { schoolYear: { in: [schoolYear, UNSCOPED_SCHOOL_YEAR] } };
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
