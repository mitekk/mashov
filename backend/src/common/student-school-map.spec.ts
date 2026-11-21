import { buildStudentSchoolMap } from './student-school-map';
import type { PrismaService } from '../prisma/prisma.service';

const CONN_A = 'conn-a';
const CONN_B = 'conn-b';
const SHARED = 'guid-shared';

/** Two connections at one school, as a shared child's links look. */
const CONNECTIONS = [
  { id: CONN_A, userId: 'user-a', schoolCode: 111, schoolName: 'בית ספר א', displayLabel: 'של א' },
  { id: CONN_B, userId: 'user-b', schoolCode: 111, schoolName: 'בית ספר א', displayLabel: 'של ב' },
];

interface Fixture {
  /** studentGuid -> the connections that list the child. */
  links: Array<{ studentGuid: string; householdConnectionId: string }>;
}

/**
 * A Prisma double that routes `householdConnection.findMany` on its predicate.
 *
 * Two callers ask it: `activeConnectionIdsFor`, which wants one user's active
 * connections, and the map's own detail read, which wants rows by id. Routing
 * keeps one double honest for both.
 */
function makePrisma(fixture: Fixture): PrismaService {
  return {
    householdConnection: {
      findMany: jest.fn((args?: { where?: Record<string, unknown> }) => {
        const byUser = args?.where?.userId as string | undefined;
        if (byUser) {
          return Promise.resolve(
            CONNECTIONS.filter((connection) => connection.userId === byUser).map(
              (connection) => ({ id: connection.id }),
            ),
          );
        }
        const ids = (args?.where?.id as { in?: string[] } | undefined)?.in ?? [];
        return Promise.resolve(CONNECTIONS.filter((connection) => ids.includes(connection.id)));
      }),
    },
    studentConnection: {
      findMany: jest.fn((args?: { where?: Record<string, unknown> }) => {
        const guids = (args?.where?.studentGuid as { in?: string[] } | undefined)?.in ?? [];
        return Promise.resolve(fixture.links.filter((link) => guids.includes(link.studentGuid)));
      }),
    },
    student: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
}

/** The shared child, stamped to whichever parent synced last. */
function sharedChild(stamp: string | null) {
  return [{ studentGuid: SHARED, householdConnectionId: stamp }];
}

describe('buildStudentSchoolMap', () => {
  /**
   * R5 — the map handed a caller the other parent's connection id and label.
   *
   * `resolvedFor` preferred the routing stamp whenever it was among the
   * child's links and otherwise took `links[0]`, with no filter to the
   * caller's own connections. For a child two parents at one school share,
   * parent B's `/dashboard` got parent A's connection UUID and A's
   * parent-chosen `displayLabel` -- and because the client resolves `schoolId`
   * against `me.schools`, the lookup missed and the chip could never match.
   */
  describe('with a caller', () => {
    const BOTH_LIST_THE_CHILD: Fixture = {
      links: [
        { studentGuid: SHARED, householdConnectionId: CONN_A },
        { studentGuid: SHARED, householdConnectionId: CONN_B },
      ],
    };

    it("resolves a foreign stamp to the caller's own link", async () => {
      // The state B's sync leaves behind, which is what A then reads.
      const map = await buildStudentSchoolMap(
        makePrisma(BOTH_LIST_THE_CHILD),
        sharedChild(CONN_B),
        'user-a',
      );

      expect(map.get(SHARED)?.schoolId).toBe(CONN_A);
      // ...and A's own label, not the label B chose for their connection.
      expect(map.get(SHARED)?.shortLabel).toBe('של א');
    });

    it('still prefers the stamp when the caller owns it', async () => {
      // So the intersection does not reorder a single-school deployment's
      // output: the stamp wins whenever it is one of the caller's.
      const map = await buildStudentSchoolMap(
        makePrisma(BOTH_LIST_THE_CHILD),
        sharedChild(CONN_B),
        'user-b',
      );

      expect(map.get(SHARED)?.schoolId).toBe(CONN_B);
    });

    it('gives no badge for a child only the other household lists', async () => {
      const map = await buildStudentSchoolMap(
        makePrisma({ links: [{ studentGuid: SHARED, householdConnectionId: CONN_B }] }),
        sharedChild(CONN_B),
        'user-a',
      );

      // Absent from the map, which every caller reads as "no badge" -- rather
      // than a foreign id the client cannot resolve.
      expect(map.has(SHARED)).toBe(false);
    });

    it('gives no badge for an unlinked child stamped to the other household', async () => {
      // The pre-backfill shape: no links recorded yet. The fallback to the
      // stamp survives, but only when the stamp is the caller's own.
      const map = await buildStudentSchoolMap(
        makePrisma({ links: [] }),
        sharedChild(CONN_B),
        'user-a',
      );

      expect(map.has(SHARED)).toBe(false);
    });

    it("keeps the backfill fallback when the unlinked child's stamp is the caller's", async () => {
      // Why the fallback exists: a database whose backfill has not run must
      // keep showing the badge it showed before.
      const map = await buildStudentSchoolMap(
        makePrisma({ links: [] }),
        sharedChild(CONN_A),
        'user-a',
      );

      expect(map.get(SHARED)?.schoolId).toBe(CONN_A);
    });

    it('gives no badge for a child with no links and no stamp', async () => {
      const map = await buildStudentSchoolMap(
        makePrisma({ links: [] }),
        sharedChild(null),
        'user-a',
      );

      expect(map.has(SHARED)).toBe(false);
    });
  });

  /**
   * The caller-less read, which must not change at all.
   *
   * It is the digest and the unauthenticated integration suite; there is no
   * caller to intersect against, so the old rules stand verbatim.
   */
  describe('with no caller', () => {
    it('prefers the stamp when it is among the links', async () => {
      const map = await buildStudentSchoolMap(
        makePrisma({
          links: [
            { studentGuid: SHARED, householdConnectionId: CONN_A },
            { studentGuid: SHARED, householdConnectionId: CONN_B },
          ],
        }),
        sharedChild(CONN_B),
      );

      expect(map.get(SHARED)?.schoolId).toBe(CONN_B);
    });

    it('falls back to the first link when the stamp names none of them', async () => {
      const map = await buildStudentSchoolMap(
        makePrisma({ links: [{ studentGuid: SHARED, householdConnectionId: CONN_A }] }),
        sharedChild('conn-deleted'),
      );

      expect(map.get(SHARED)?.schoolId).toBe(CONN_A);
    });

    it('falls back to the stamp when there are no links at all', async () => {
      const map = await buildStudentSchoolMap(
        makePrisma({ links: [] }),
        sharedChild(CONN_B),
      );

      expect(map.get(SHARED)?.schoolId).toBe(CONN_B);
    });

    it('asks for no connections of its own', async () => {
      // The unscoped path must not acquire a `userId` lookup it cannot answer.
      const prisma = makePrisma({ links: [] });
      await buildStudentSchoolMap(prisma, sharedChild(CONN_B));

      for (const call of (prisma.householdConnection.findMany as jest.Mock).mock.calls) {
        expect(call[0]?.where?.userId).toBeUndefined();
      }
    });
  });
});
