import {
  RosterPresenceService,
  ROSTER_ABSENCE_GRACE_DAYS,
} from './roster-presence.service';
import type { PrismaService } from '../prisma/prisma.service';

const NOW = new Date('2026-11-17T12:00:00Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * MS_PER_DAY);
}

function makeMockPrisma(departed: Array<Record<string, unknown>>) {
  const findMany = jest.fn().mockResolvedValue(departed);
  const updateMany = jest.fn().mockResolvedValue({ count: departed.length });
  return {
    prisma: { student: { findMany, updateMany } } as unknown as PrismaService,
    findMany,
    updateMany,
  };
}

describe('RosterPresenceService.sweep', () => {
  it('deactivates a child absent beyond the grace period', async () => {
    const { prisma, updateMany } = makeMockPrisma([
      {
        studentGuid: 'guid-departed',
        fullName: 'מיקה קורס',
        lastSeenInRosterAt: daysAgo(120),
      },
    ]);

    const count = await new RosterPresenceService(prisma).sweep(NOW);

    expect(count).toBe(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { studentGuid: { in: ['guid-departed'] } },
      data: { isActive: false },
    });
  });

  it('queries only active children past the cutoff', async () => {
    const { prisma, findMany } = makeMockPrisma([]);

    await new RosterPresenceService(prisma).sweep(NOW);

    const where = findMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    expect(where.lastSeenInRosterAt.lt.toISOString()).toBe(
      daysAgo(ROSTER_ABSENCE_GRACE_DAYS).toISOString(),
    );
  });

  // The column is backfilled by migration, so a null means a row this code has
  // never written -- no evidence of absence, and so no grounds to hide a child.
  it('never sweeps a child whose lastSeenInRosterAt is null', async () => {
    const { prisma, findMany } = makeMockPrisma([]);

    await new RosterPresenceService(prisma).sweep(NOW);

    expect(findMany.mock.calls[0][0].where.lastSeenInRosterAt.not).toBeNull();
  });

  it('writes nothing when every child is present', async () => {
    const { prisma, updateMany } = makeMockPrisma([]);

    const count = await new RosterPresenceService(prisma).sweep(NOW);

    expect(count).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('leaves a child inside the grace window alone', async () => {
    // Mirrors what the query above excludes: one day short of the threshold.
    const { prisma, findMany } = makeMockPrisma([]);
    await new RosterPresenceService(prisma).sweep(NOW);

    const cutoff: Date = findMany.mock.calls[0][0].where.lastSeenInRosterAt.lt;
    expect(daysAgo(ROSTER_ABSENCE_GRACE_DAYS - 1) > cutoff).toBe(true);
  });
});
