import { PrismaService } from '../../prisma/prisma.service';
import { schoolYearForConnection } from '../school-year/school-year.scope';
import { DEFAULT_BELL_SCHEDULE } from './default-bell-schedule';
import { deriveBreaks, normalizeClock } from './derive-breaks';
import type { BellBreak, BellPeriod } from './derive-breaks';

/**
 * Where the periods came from. Exposed to the client because default times are
 * a guess: a UI that renders them without saying so is telling a parent their
 * child's maths lesson ends at 11:20 on no evidence (ADR-0037).
 */
export type BellScheduleSource = 'school' | 'default';

export interface BellScheduleView {
  source: BellScheduleSource;
  periods: BellPeriod[];
  breaks: BellBreak[];
}

/** A row the sync task stored, as a period, or `null` if it is unusable. */
function toPeriod(row: { lesson: number; startTime: string; endTime: string }): BellPeriod | null {
  const startTime = normalizeClock(row.startTime);
  const endTime = normalizeClock(row.endTime);
  if (!startTime || !endTime || !Number.isInteger(row.lesson) || row.lesson <= 0) return null;
  return { lesson: row.lesson, startTime, endTime };
}

function defaultView(): BellScheduleView {
  const periods = DEFAULT_BELL_SCHEDULE.map((period) => ({ ...period }));
  return { source: 'default', periods, breaks: deriveBreaks(periods) };
}

/**
 * The bell schedule one school is on, falling back to the bundled default.
 *
 * A free function taking `prisma` rather than an injectable, matching
 * `school-year.scope.ts`: every caller already holds the connection id it
 * needs, and the read is two queries with no state of its own.
 */
export async function bellScheduleForConnection(
  prisma: PrismaService,
  connectionId: string | null | undefined,
): Promise<BellScheduleView> {
  const connection = connectionId
    ? await prisma.householdConnection.findUnique({
        where: { id: connectionId },
        select: { schoolCode: true },
      })
    : null;

  if (!connection?.schoolCode) return defaultView();

  const schoolYear = await schoolYearForConnection(prisma, connectionId);
  const rows = await prisma.bellSchedule.findMany({
    where: { schoolCode: connection.schoolCode, schoolYear },
    orderBy: { lesson: 'asc' },
  });

  const periods = rows
    .map(toPeriod)
    .filter((period): period is BellPeriod => period !== null);

  // No rows is the expected state, not a fault: `GET /api/bells` is
  // unverified and may not exist for this school at all.
  if (periods.length === 0) return defaultView();

  return { source: 'school', periods, breaks: deriveBreaks(periods) };
}

/** The same, for a caller that holds only the child's guid. */
export async function bellScheduleForStudent(
  prisma: PrismaService,
  studentGuid: string,
): Promise<BellScheduleView> {
  const student = await prisma.student.findUnique({
    where: { studentGuid },
    select: { householdConnectionId: true },
  });

  return bellScheduleForConnection(prisma, student?.householdConnectionId);
}
