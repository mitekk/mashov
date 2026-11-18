import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSchoolLabels } from '../common/school-label';

/**
 * One connected Mashov account, as the management screen needs it.
 *
 * Never carries the password, in any form. `username` is shown because a
 * parent with two accounts needs to tell them apart; the encrypted password
 * exists only in `household_connection`.
 */
export interface SchoolLink {
  id: string;
  semel: number;
  schoolName: string;
  shortLabel: string;
  schoolYear: number;
  username: string;
  childrenCount: number;
  isPrimary: boolean;
  lastLoginAt: string | null;
  /** `null` means the first sync has not finished -- the UI says so. */
  lastSyncAt: string | null;
  active: boolean;
}

/** The slice of a link `GET /auth/me` carries, for every page's badges. */
export interface MeSchool {
  id: string;
  semel: number;
  schoolName: string;
  shortLabel: string;
  schoolYear: number;
}

@Injectable()
export class SchoolLinksService {
  private readonly logger = new Logger(SchoolLinksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every school a household has connected, newest sign-in first.
   *
   * One method feeds both `GET /school-links` and `me.schools`: the badges on
   * every page need the cheap slice, the management screen needs the counts
   * and timestamps, and two implementations of "which schools are these"
   * would drift.
   */
  async listLinks(userId: string): Promise<SchoolLink[]> {
    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, active: true },
      orderBy: [{ lastLoginAt: 'desc' }, { createdAt: 'asc' }],
    });

    if (connections.length === 0) return [];

    const labels = resolveSchoolLabels(connections);

    // Counted per connection in one grouped query rather than one per row.
    const counts = await this.prisma.student.groupBy({
      by: ['householdConnectionId'],
      where: {
        isActive: true,
        householdConnectionId: { in: connections.map((connection) => connection.id) },
      },
      _count: { _all: true },
    });
    const countByConnection = new Map(
      counts.map((row) => [row.householdConnectionId, row._count._all]),
    );

    // `lastSyncAt` is the newest SUCCESSFUL run for that connection. A failed
    // run must not read as a finished sync: the UI shows "מסנכרן נתונים…"
    // while this is null, and a parent watching a school that cannot sync
    // should keep seeing that rather than a reassuring timestamp.
    const lastRuns = await this.prisma.syncRun.groupBy({
      by: ['householdConnectionId'],
      where: {
        status: 'success',
        householdConnectionId: { in: connections.map((connection) => connection.id) },
      },
      _max: { endedAt: true },
    });
    const lastSyncByConnection = new Map(
      lastRuns.map((row) => [row.householdConnectionId, row._max.endedAt]),
    );

    return connections.map((connection, index) => ({
      id: connection.id,
      semel: connection.schoolCode,
      schoolName: connection.schoolName ?? String(connection.schoolCode),
      shortLabel: labels.get(connection.id) ?? String(connection.schoolCode),
      schoolYear: connection.schoolYear,
      username: connection.username,
      childrenCount: countByConnection.get(connection.id) ?? 0,
      // The most recently used school. It is a display hint only -- nothing
      // reads it for scoping, and the deprecated `connectedSchool` is built
      // from the same first element.
      isPrimary: index === 0,
      lastLoginAt: connection.lastLoginAt?.toISOString() ?? null,
      lastSyncAt: lastSyncByConnection.get(connection.id)?.toISOString() ?? null,
      active: connection.active,
    }));
  }

  /** The same list, reduced to what a badge needs. */
  async listMeSchools(userId: string): Promise<MeSchool[]> {
    const links = await this.listLinks(userId);
    return links.map((link) => ({
      id: link.id,
      semel: link.semel,
      schoolName: link.schoolName,
      shortLabel: link.shortLabel,
      schoolYear: link.schoolYear,
    }));
  }
}
