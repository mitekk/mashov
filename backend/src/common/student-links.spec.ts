import { PrismaService } from '../prisma/prisma.service';
import {
  canSeeStudent,
  connectionStudentWhere,
  linkStudentsToConnection,
  ownsStudentForDelivery,
  visibleStudentWhere,
} from './student-links';

/**
 * Child visibility is a SET of connections (ADR-0031).
 *
 * The defect these tests pin: `Student.householdConnectionId` was asked to say
 * both "whose credentials serve this child" and "who may see this child". The
 * first is fine as one value, the second is not -- two parents with their own
 * Mashov accounts at one school legitimately list the same children, and
 * whichever synced second took the stamp and emptied the other's `/children`.
 */

const CONN_A = 'conn-a';
const CONN_B = 'conn-b';

function makePrisma(overrides: {
  connections?: Array<{ id: string }>;
  links?: Array<{ householdConnectionId: string }>;
} = {}) {
  const findManyConnections = jest.fn().mockResolvedValue(overrides.connections ?? []);
  const findManyLinks = jest.fn().mockResolvedValue(overrides.links ?? []);
  const upsert = jest.fn().mockResolvedValue({});

  return {
    prisma: {
      householdConnection: { findMany: findManyConnections },
      studentConnection: { findMany: findManyLinks, upsert },
    } as unknown as PrismaService,
    findManyConnections,
    findManyLinks,
    upsert,
  };
}

describe('visibleStudentWhere', () => {
  it('admits children linked to one of the user\'s connections', async () => {
    const { prisma, findManyConnections } = makePrisma({
      connections: [{ id: CONN_A }, { id: CONN_B }],
    });

    const where = await visibleStudentWhere(prisma, 'user-1');

    expect(findManyConnections).toHaveBeenCalledWith({
      where: { userId: 'user-1', active: true },
      select: { id: true },
    });
    expect(where).toEqual({
      OR: [
        { links: { some: { householdConnectionId: { in: [CONN_A, CONN_B] } } } },
        { links: { none: {} } },
      ],
    });
  });

  it('admits an unlinked child, because no links means ownership unknown', async () => {
    // The rule the NULL stamp already had, carried over unchanged: the shared
    // env-credential session writes children it cannot attribute, and
    // excluding them would empty the app on a deployment that has not
    // re-synced since the migration.
    const { prisma } = makePrisma({ connections: [] });

    const where = await visibleStudentWhere(prisma, 'user-1');

    expect(where).toEqual({
      OR: [
        { links: { some: { householdConnectionId: { in: [] } } } },
        { links: { none: {} } },
      ],
    });
  });
});

describe('canSeeStudent', () => {
  it('lets a user see a child linked to their own connection', async () => {
    const { prisma } = makePrisma({
      connections: [{ id: CONN_A }],
      links: [{ householdConnectionId: CONN_A }],
    });

    await expect(canSeeStudent(prisma, 'user-1', 'guid-1')).resolves.toBe(true);
  });

  it('lets BOTH parents see a child their two connections share', async () => {
    // The whole point. Parent B's connection holding a link must not take the
    // child away from parent A.
    const shared = { links: [{ householdConnectionId: CONN_A }, { householdConnectionId: CONN_B }] };

    const a = makePrisma({ connections: [{ id: CONN_A }], ...shared });
    const b = makePrisma({ connections: [{ id: CONN_B }], ...shared });

    await expect(canSeeStudent(a.prisma, 'user-a', 'guid-1')).resolves.toBe(true);
    await expect(canSeeStudent(b.prisma, 'user-b', 'guid-1')).resolves.toBe(true);
  });

  it('refuses a child only another household lists', async () => {
    const { prisma } = makePrisma({
      connections: [{ id: CONN_A }],
      links: [{ householdConnectionId: CONN_B }],
    });

    await expect(canSeeStudent(prisma, 'user-a', 'guid-1')).resolves.toBe(false);
  });

  it('allows a child with no links at all', async () => {
    const { prisma, findManyConnections } = makePrisma({ links: [] });

    await expect(canSeeStudent(prisma, 'user-a', 'guid-1')).resolves.toBe(true);
    // And does not even need to know the caller's connections to say so.
    expect(findManyConnections).not.toHaveBeenCalled();
  });
});

describe('linkStudentsToConnection', () => {
  it('upserts one link per child and refreshes when it already exists', async () => {
    const { prisma, upsert } = makePrisma();
    const seenAt = new Date('2026-11-18T08:00:00Z');

    await linkStudentsToConnection(prisma, CONN_A, ['guid-1', 'guid-2'], seenAt);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith({
      where: { studentGuid_householdConnectionId: { studentGuid: 'guid-1', householdConnectionId: CONN_A } },
      create: {
        studentGuid: 'guid-1',
        householdConnectionId: CONN_A,
        firstSeenAt: seenAt,
        lastSeenInRosterAt: seenAt,
      },
      update: { lastSeenInRosterAt: seenAt },
    });
  });

  it('never revokes a view it is not refreshing', async () => {
    // The update branch touches `lastSeenInRosterAt` only. A link is a granted
    // view, not an observation: deleting the ones a roster did not mention
    // would take a parent's child away on any upstream hiccup.
    const { prisma, upsert } = makePrisma();

    await linkStudentsToConnection(prisma, CONN_A, ['guid-1']);

    expect(upsert.mock.calls[0][0].update).toEqual({
      lastSeenInRosterAt: expect.any(Date),
    });
  });

  it('writes nothing for an empty roster', async () => {
    const { prisma, upsert } = makePrisma();

    await linkStudentsToConnection(prisma, CONN_A, []);

    expect(upsert).not.toHaveBeenCalled();
  });

  it('deduplicates a guid the roster lists twice', async () => {
    const { prisma, upsert } = makePrisma();

    await linkStudentsToConnection(prisma, CONN_A, ['guid-1', 'guid-1']);

    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe('connectionStudentWhere', () => {
  it('matches the children one school lists, plus the unlinked ones', () => {
    // Used by the `inactiveChildren` sweeps: a school may retire a child it
    // lists and no other. Pure, because the caller already holds the id.
    expect(connectionStudentWhere(CONN_A)).toEqual({
      OR: [
        { links: { some: { householdConnectionId: CONN_A } } },
        { links: { none: {} } },
      ],
    });
  });
});

describe('ownsStudentForDelivery', () => {
  it('lets a user act on a child linked to their own connection', async () => {
    const { prisma } = makePrisma({
      connections: [{ id: CONN_A }],
      links: [{ householdConnectionId: CONN_A }],
    });

    await expect(ownsStudentForDelivery(prisma, 'user-a', 'guid-1')).resolves.toBe(true);
  });

  it('lets BOTH parents act on a child their two connections share', async () => {
    const shared = {
      links: [{ householdConnectionId: CONN_A }, { householdConnectionId: CONN_B }],
    };

    const a = makePrisma({ connections: [{ id: CONN_A }], ...shared });
    const b = makePrisma({ connections: [{ id: CONN_B }], ...shared });

    await expect(ownsStudentForDelivery(a.prisma, 'user-a', 'guid-1')).resolves.toBe(true);
    await expect(ownsStudentForDelivery(b.prisma, 'user-b', 'guid-1')).resolves.toBe(true);
  });

  it('refuses a child only another household lists', async () => {
    const { prisma } = makePrisma({
      connections: [{ id: CONN_A }],
      links: [{ householdConnectionId: CONN_B }],
    });

    await expect(ownsStudentForDelivery(prisma, 'user-a', 'guid-1')).resolves.toBe(false);
  });

  it('REFUSES a child with no links at all, unlike canSeeStudent', async () => {
    // The whole reason this function exists. On the read side an unattributed
    // child is admitted, because "ownership unknown" must not empty the app.
    // On a write that starts pushing a child's behaviour record to a messaging
    // app, the safe failure is the other way round: nobody owns a child the
    // roster cannot attribute, so nobody gets to point them at their phone.
    const { prisma } = makePrisma({ connections: [{ id: CONN_A }], links: [] });

    await expect(canSeeStudent(prisma, 'user-a', 'guid-1')).resolves.toBe(true);
    await expect(ownsStudentForDelivery(prisma, 'user-a', 'guid-1')).resolves.toBe(false);
  });

  it('refuses when the caller has no active connections at all', async () => {
    const { prisma } = makePrisma({
      connections: [],
      links: [{ householdConnectionId: CONN_A }],
    });

    await expect(ownsStudentForDelivery(prisma, 'user-a', 'guid-1')).resolves.toBe(false);
  });
});
