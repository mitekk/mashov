import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How long a child may be absent from every roster before being deactivated.
 *
 * The roster cron runs every 30 minutes, so this is well over three hundred
 * consecutive logins without them. That is deliberately generous: wrongly
 * hiding a child from their parent's dashboard is a far worse failure than a
 * departed child lingering for a few more days, and a single malformed login
 * payload must never be enough to make one disappear.
 */
export const ROSTER_ABSENCE_GRACE_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Retires children who have left the connected school.
 *
 * Mashov does not announce a departure. A child who moves on -- finishing
 * sixth grade and starting middle school elsewhere, say -- simply stops
 * appearing in `accessToken.children[]`, and is *not* moved to
 * `inactiveChildren`, which was the only thing the roster persist looked at.
 * So they stayed `isActive: true` indefinitely while `/api/students/:guid/...`
 * returned 403 for them on every homework and behavior run, every 12 minutes.
 */
@Injectable()
export class RosterPresenceService {
  private readonly logger = new Logger(RosterPresenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deactivates active children absent from every roster for longer than the
   * grace period.
   *
   * The caller must only invoke this when it has just refreshed the roster of
   * *every* active connection successfully -- see `StudentsTask`. A child at a
   * second school is present in that connection's roster and absent from the
   * first, so a sweep run on partial evidence would deactivate them wrongly.
   * `lastSeenInRosterAt` is refreshed by whichever connection lists them, so
   * the check is naturally correct across any number of schools.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - ROSTER_ABSENCE_GRACE_DAYS * MS_PER_DAY);

    const departed = await this.prisma.student.findMany({
      where: {
        isActive: true,
        // NULL is never swept. The column is backfilled from `updatedAt` by
        // the migration that adds it, so a null here means a row this code has
        // never seen written -- no evidence of absence, so no action.
        lastSeenInRosterAt: { not: null, lt: cutoff },
      },
      select: { studentGuid: true, fullName: true, lastSeenInRosterAt: true },
    });

    if (departed.length === 0) {
      return 0;
    }

    const { count } = await this.prisma.student.updateMany({
      where: { studentGuid: { in: departed.map((s) => s.studentGuid) } },
      data: { isActive: false },
    });

    // Logged individually and at warn: a child leaving the dashboard is a
    // visible, surprising change, and this line is the only explanation of it.
    for (const student of departed) {
      this.logger.warn(
        `Deactivating ${student.fullName}: absent from every roster since ` +
          `${student.lastSeenInRosterAt?.toISOString()} ` +
          `(over ${ROSTER_ABSENCE_GRACE_DAYS} days). Their history is kept. ` +
          `If they moved school, connect that school's Mashov account to sync them again.`,
      );
    }

    return count;
  }
}
