import { DashboardService } from './dashboard.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { FreshnessService } from '../sync/freshness.service';
import type { MashovSessionService } from '../session/mashov-session.service';
import type { UserItemStateService } from '../common/user-item-state.service';

const STUDENT = {
  studentGuid: 'student-1',
  privateName: 'Avi',
  familyName: 'Cohen',
  fullName: 'Avi Cohen',
  classCode: 'ז',
  classNum: 3,
};

const PRIOR_YEAR_HOMEWORK = {
  id: 'hw-last-year',
  studentGuid: 'student-1',
  subjectName: 'History',
  homeworkText: 'Chapter 4',
  lessonDate: new Date('2026-05-02T08:00:00Z'),
  updatedAt: new Date('2026-05-02T08:30:00Z'),
  files: [],
};

interface Overrides {
  homeworkFindMany?: jest.Mock;
  behaviorFindMany?: jest.Mock;
  homeworkFindFirst?: jest.Mock;
  behaviorFindFirst?: jest.Mock;
  mailFindMany?: jest.Mock;
  mailCount?: jest.Mock;
  mailUnattributedCount?: jest.Mock;
  connectionFindFirst?: jest.Mock;
  connectionAggregate?: jest.Mock;
}

function makeService(overrides: Overrides = {}) {
  const homeworkFindMany = overrides.homeworkFindMany ?? jest.fn().mockResolvedValue([]);
  const behaviorFindMany = overrides.behaviorFindMany ?? jest.fn().mockResolvedValue([]);
  const homeworkFindFirst = overrides.homeworkFindFirst ?? jest.fn().mockResolvedValue(null);
  const behaviorFindFirst = overrides.behaviorFindFirst ?? jest.fn().mockResolvedValue(null);
  const mailFindMany = overrides.mailFindMany ?? jest.fn().mockResolvedValue([]);
  // The badge's two counts both land on `mailConversation.count`: the
  // caller's own scope, and the unattributed rows `unreadBadge` adds once
  // (R15). Routed by predicate, so `mailCount` still records exactly the
  // scoped calls the cases below assert on.
  const scopedMailCount = overrides.mailCount ?? jest.fn().mockResolvedValue(0);
  const unattributedMailCount =
    overrides.mailUnattributedCount ?? jest.fn().mockResolvedValue(0);
  const mailCount = jest.fn((args?: { where?: { householdConnectionId?: unknown } }) =>
    args?.where?.householdConnectionId === null
      ? unattributedMailCount(args)
      : scopedMailCount(args),
  );
  const connectionFindFirst =
    overrides.connectionFindFirst ??
    jest.fn().mockResolvedValue({
      schoolYear: 2027,
      cachedNewCount: 0,
      schoolName: 'School',
    });

  const prisma = {
    householdConnection: {
      findFirst: connectionFindFirst,
      findMany: jest.fn().mockResolvedValue([{ id: 'conn-1', schoolYear: 2027 }]),
      // The badge is summed over the CALLER's connections now, so the read is
      // an aggregate rather than one row.
      aggregate:
        overrides.connectionAggregate ??
        jest
          .fn()
          .mockResolvedValue({ _sum: { cachedNewCount: 0 }, _count: { _all: 1 } }),
    },
    student: {
      findMany: ownershipAwareStudentFindMany(
        jest.fn().mockResolvedValue([STUDENT]),
        [{ studentGuid: 'student-1', householdConnectionId: 'conn-1' }],
      ),
      count: jest.fn().mockResolvedValue(1),
    },
    studentConnection: {
      findMany: linkFindMany([
        { studentGuid: 'student-1', householdConnectionId: 'conn-1' },
      ]),
    },
    homeworkItem: {
      findMany: homeworkFindMany,
      findFirst: homeworkFindFirst,
      count: jest.fn().mockResolvedValue(0),
    },
    behaviorItem: {
      findMany: behaviorFindMany,
      findFirst: behaviorFindFirst,
      count: jest.fn().mockResolvedValue(0),
    },
    mailConversation: {
      findMany: mailFindMany,
      count: mailCount,
    },
  } as unknown as PrismaService;

  const freshness = {
    computeFreshness: jest.fn().mockResolvedValue({
      state: 'fresh',
      lastSyncAt: null,
      staleSources: [],
    }),
  } as unknown as FreshnessService;

  const session = {
    ensureStudentsAvailable: jest.fn().mockResolvedValue(undefined),
  } as unknown as MashovSessionService;

  const itemState = {
    getStateBatch: jest.fn().mockResolvedValue(new Map()),
  } as unknown as UserItemStateService;

  const service = new DashboardService(prisma, freshness, session, itemState);
  return {
    service,
    homeworkFindMany,
    behaviorFindMany,
    homeworkFindFirst,
    behaviorFindFirst,
    mailFindMany,
    mailCount: scopedMailCount,
    connectionFindFirst,
  };
}

/** The mail predicate a scoped dashboard read is expected to issue. */
function mailScope(own = ['conn-1']) {
  return {
    OR: [
      { householdConnectionId: { in: own } },
      // NULL stays admitted: ownership unknown is not somebody else's.
      { householdConnectionId: null },
    ],
  };
}

/**
 * The year predicate a cross-child read issues: each school's children at
 * that school's current year, rather than one year for the household.
 *
 * Scoped to the household's own children; see `unscopedBranch`.
 */
function yearWhere(year: number, guids = ['student-1']) {
  return {
    OR: [
      { studentGuid: { in: guids }, schoolYear: { in: [0] } },
      { studentGuid: { in: guids }, schoolYear: { in: [year] } },
    ],
  };
}
/**
 * A `student.findMany` that answers every caller.
 *
 * Three ask: the visibility filter (an OR over `links`), the year scope's
 * "which children does nobody list" query (`links: { none: {} }`), and
 * everything else, which wants the roster. Routing on the predicate keeps one
 * mock honest for all of them instead of making every test aware of the
 * ownership lookup.
 */
function ownershipAwareStudentFindMany(
  roster: jest.Mock,
  owned: Array<{ studentGuid: string; householdConnectionId: string }>,
): jest.Mock {
  return jest.fn((args?: { where?: Record<string, unknown> }) => {
    const where = (args?.where ?? {}) as Record<string, unknown>;

    // "Children nobody lists": every fixture child is listed, so none.
    const links = where.links as { none?: object } | undefined;
    if (links?.none) return Promise.resolve([]);

    const clauses = (where.OR as Array<Record<string, unknown>> | undefined) ?? null;
    if (clauses) {
      const ids = clauses.flatMap((clause) => {
        const scoped = (clause.links as
          | { some?: { householdConnectionId?: { in?: string[] } } }
          | undefined)?.some?.householdConnectionId?.in;
        return scoped ?? [];
      });
      const visible = owned
        .filter((student) => ids.includes(student.householdConnectionId))
        .map((student) => student.studentGuid);
      return roster(args).then((students: Array<{ studentGuid: string }>) =>
        students.filter((student) => visible.includes(student.studentGuid)),
      );
    }
    return roster(args);
  });
}

/** The visibility edge, built from the same `owned` fixture. */
function linkFindMany(
  owned: Array<{ studentGuid: string; householdConnectionId: string }>,
): jest.Mock {
  return jest.fn((args?: { where?: Record<string, unknown> }) => {
    const byConnection = (args?.where?.householdConnectionId as { in?: string[] } | undefined)
      ?.in;
    const byStudent = (args?.where?.studentGuid as { in?: string[] } | undefined)?.in;
    return Promise.resolve(
      owned.filter(
        (link) =>
          (!byConnection || byConnection.includes(link.householdConnectionId)) &&
          (!byStudent || byStudent.includes(link.studentGuid)),
      ),
    );
  });
}


// Cross-child, so the per-connection pair shape: this school's children at
// this school's year. With one connection it selects exactly the rows the flat
// `{ schoolYear: { in: [2027, 0] } }` used to.
const CURRENT_YEAR_ONLY = yearWhere(2027);

describe('DashboardService', () => {
  describe('getDashboard', () => {
    it('carries no deprecated `school` field (T14)', async () => {
      // It was the household's most recently used connection under a singular
      // name, so it could not describe two schools -- and N1 was this exact
      // read without a `userId`, putting another household's school name on a
      // single-school parent's dashboard. Every per-item school label is
      // `schoolId`/`schoolShortLabel` now, resolved per child.
      //
      // Asserted as an absent KEY: a falsy check would also pass against the
      // field still being there and empty, which is what it answered for a
      // parent with no connection.
      const { service } = makeService();

      const result = await service.getDashboard('user-1');

      expect(Object.keys(result).sort()).toEqual([
        'children',
        'feed',
        'freshness',
        'summary',
      ]);
    });

    it('keeps the latest-20 homework list on the current year', async () => {
      // The inverse of ADR-0025's assertion here. A year the student has
      // already left is history, not the top of the home page: it lives
      // behind `ארכיון` on the child's own list now (ADR-0036).
      const { service, homeworkFindMany } = makeService();

      await service.getDashboard('user-1');

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: yearWhere(2027), take: 20 }),
      );
    });

    it('keeps the latest-20 behaviour list on the current year too', async () => {
      const { service, behaviorFindMany } = makeService();

      await service.getDashboard('user-1');

      expect(behaviorFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: yearWhere(2027), take: 20 }),
      );
    });

    it('leaves a prior-year item out of the feed', async () => {
      // The scope keeps it out in SQL; the mock answers the way the database
      // would, so the assertion is on the scope AND on the payload.
      const { service, homeworkFindMany } = makeService({
        homeworkFindMany: jest.fn(
          (args?: { where?: { OR?: Array<{ schoolYear?: { in?: number[] } }> } }) => {
            const years = (args?.where?.OR ?? []).flatMap(
              (clause) => clause.schoolYear?.in ?? [],
            );
            return Promise.resolve(years.includes(2026) ? [PRIOR_YEAR_HOMEWORK] : []);
          },
        ),
      });

      const result = await service.getDashboard('user-1');

      expect(result.feed).toHaveLength(0);
      expect(JSON.stringify(homeworkFindMany.mock.calls[0][0].where)).not.toContain('gte');
    });

    it('keeps latestUpdateAt on the current year alone, so a quiet year still reads quiet', async () => {
      // This is PR #8's only detection mechanism. Widening it would let last
      // June's homework report as this year's latest update.
      const { service, homeworkFindFirst, behaviorFindFirst } = makeService();

      const result = await service.getDashboard('user-1');

      for (const mock of [homeworkFindFirst, behaviorFindFirst]) {
        expect(mock).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining(CURRENT_YEAR_ONLY),
          }),
        );
      }
      expect(result.children[0].latestUpdateAt).toBeNull();
    });

    it('reads the same scope whether or not MASHOV_YEAR is set', async () => {
      const { service, homeworkFindMany } = makeService();

      await service.getDashboard('user-1');

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: yearWhere(2027) }),
      );
    });
  });

  /**
   * R3, R13 and N1 — three reads on one screen that never took the caller.
   *
   * The student and item reads were scoped in batch 1; these three were not,
   * and each of them puts another household's data on the dashboard: the feed's
   * mail list (R3), the fallback badge count (R13) and the school card (N1).
   */
  describe('scoping to the caller', () => {
    it('scopes the feed mail read to the household (R3)', async () => {
      const { service, mailFindMany } = makeService();

      await service.getDashboard('user-1');

      expect(mailFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: mailScope() }),
      );
    });

    it('scopes the fallback badge count to the household (R13)', async () => {
      const { service, mailCount } = makeService();

      await service.getDashboard('user-1');

      expect(mailCount).toHaveBeenCalledWith({
        where: {
          ...mailScope(),
          isUnread: true,
          NOT: { labels: { array_contains: ['archived'] } },
        },
      });
    });

    it('reads the fallback count, not the other household, when there are no connections (R13)', async () => {
      // The whole trigger: `_count._all === 0` is a user between unlinking and
      // re-linking, and the local count was every household's unread total.
      // The scope now admits only the unstamped rows for them, so the mock's
      // count is what the badge reports -- and the predicate it was counted
      // under is the assertion above.
      const { service, mailCount } = makeService({
        connectionAggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { cachedNewCount: null }, _count: { _all: 0 } }),
        mailCount: jest.fn().mockResolvedValue(4),
      });

      const result = await service.getDashboard('user-1');

      expect(result.summary.newConversations).toBe(4);
      expect(mailCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining(mailScope()) }),
      );
    });

    it('adds the unattributed unread rows to the badge, once (R15)', async () => {
      // The dashboard shows the same badge as the inbox, and now by the same
      // rule rather than its own copy of the arithmetic: a conversation no
      // connection owns is listed by both and counted by both.
      const { service } = makeService({
        connectionAggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { cachedNewCount: 5 }, _count: { _all: 2 } }),
        mailUnattributedCount: jest.fn().mockResolvedValue(2),
        mailCount: jest.fn().mockResolvedValue(999),
      });

      const result = await service.getDashboard('user-1');

      expect(result.summary.newConversations).toBe(7);
    });

    it('reads no connection for a school card at all any more (N1)', async () => {
      // N1 was the deprecated `school` field: a `findFirst` on
      // `{ active: true }` with no `userId`, which showed a single-school
      // parent another household's school name. Batch 3 scoped it to the
      // caller; T14 deleted the field, so the read is gone rather than
      // narrowed. That is the stronger assertion, and the one that survives:
      // a `userId` predicate can be dropped again, an absent query cannot
      // leak.
      const { service, connectionFindFirst } = makeService();

      await service.getDashboard('user-1');

      expect(connectionFindFirst).not.toHaveBeenCalled();
    });

    it('leaves the caller-less reads unscoped', async () => {
      // The digest and the unauthenticated integration suite drive this path.
      const { service, mailFindMany, connectionFindFirst } = makeService();

      await service.getDashboard();

      expect(mailFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
      // Caller-less too: nothing on this response names a household's school.
      expect(connectionFindFirst).not.toHaveBeenCalled();
    });
  });
});
