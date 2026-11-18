import { DashboardService } from './dashboard.service';
import type { ConfigService } from '@nestjs/config';
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
  startYear?: string;
}

function makeService(overrides: Overrides = {}) {
  const homeworkFindMany = overrides.homeworkFindMany ?? jest.fn().mockResolvedValue([]);
  const behaviorFindMany = overrides.behaviorFindMany ?? jest.fn().mockResolvedValue([]);
  const homeworkFindFirst = overrides.homeworkFindFirst ?? jest.fn().mockResolvedValue(null);
  const behaviorFindFirst = overrides.behaviorFindFirst ?? jest.fn().mockResolvedValue(null);

  const prisma = {
    householdConnection: {
      findFirst: jest.fn().mockResolvedValue({
        schoolYear: 2027,
        cachedNewCount: 0,
        schoolName: 'School',
      }),
      findMany: jest.fn().mockResolvedValue([{ id: 'conn-1', schoolYear: 2027 }]),
      // The badge is summed over the CALLER's connections now, so the read is
      // an aggregate rather than one row.
      aggregate: jest
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
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
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

  const config = {
    get: jest.fn((key: string) => (key === 'MASHOV_YEAR' ? overrides.startYear : undefined)),
  } as unknown as ConfigService;

  const service = new DashboardService(prisma, freshness, session, itemState, config);
  return { service, homeworkFindMany, behaviorFindMany, homeworkFindFirst, behaviorFindFirst };
}

/** The window predicate a history-spanning read is expected to issue. */
/**
 * The window predicate a cross-child read issues: each school's children at
 * that school's window, rather than one window for the household.
 */
function windowWhere(start: number, current: number, guids = ['student-1']) {
  return {
    OR: [
      // Scoped to the household's own children; see unscopedBranch.
      { studentGuid: { in: guids }, schoolYear: { in: [0] } },
      { studentGuid: { in: guids }, schoolYear: { gte: start, lte: current } },
    ],
  };
}

/** The same, for a cross-child current-year read. */
function yearWhere(year: number, guids = ['student-1']) {
  return {
    OR: [
      { studentGuid: { in: guids }, schoolYear: { in: [0] } },
      { studentGuid: { in: guids }, schoolYear: { in: [year] } },
    ],
  };
}
/**
 * A `student.findMany` that answers both callers.
 *
 * The cross-child year scope asks "which children does each connection own",
 * and everything else asks for the roster. Routing on the predicate keeps one
 * mock honest for both instead of making every test aware of the ownership
 * lookup.
 */
function ownershipAwareStudentFindMany(
  roster: jest.Mock,
  owned: Array<{ studentGuid: string; householdConnectionId: string }>,
): jest.Mock {
  return jest.fn((args?: { where?: Record<string, unknown> }) => {
    // The ownership lookup asks for "this household's connections OR the
    // unattributed ones", so it is recognised by the OR rather than by a bare
    // householdConnectionId filter.
    const clauses = (args?.where?.OR as Array<Record<string, unknown>> | undefined) ?? null;
    if (clauses) {
      const ids = clauses.flatMap((clause) => {
        const scoped = clause.householdConnectionId as { in?: string[] } | null | undefined;
        return scoped && typeof scoped === 'object' && scoped.in ? scoped.in : [];
      });
      return Promise.resolve(
        owned.filter((student) => ids.includes(student.householdConnectionId)),
      );
    }
    return roster(args);
  });
}


// Cross-child, so the per-connection pair shape: this school's children at
// this school's year. With one connection it selects exactly the rows the flat
// `{ schoolYear: { in: [2027, 0] } }` used to.
const CURRENT_YEAR_ONLY = yearWhere(2027);

describe('DashboardService', () => {
  describe('getDashboard', () => {
    it('includes a prior-year item in the latest-20 lists once the window is open', async () => {
      const { service, homeworkFindMany } = makeService({
        startYear: '2026',
        homeworkFindMany: jest.fn().mockResolvedValue([PRIOR_YEAR_HOMEWORK]),
      });

      const result = await service.getDashboard('user-1');

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: windowWhere(2026, 2027), take: 20 }),
      );
      expect(result.feed[0].id).toBe('hw-last-year');
    });

    it('spans the window on the behaviour list too', async () => {
      const { service, behaviorFindMany } = makeService({ startYear: '2026' });

      await service.getDashboard('user-1');

      expect(behaviorFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: windowWhere(2026, 2027), take: 20 }),
      );
    });

    it('keeps latestUpdateAt on the current year alone, so a quiet year still reads quiet', async () => {
      // This is PR #8's only detection mechanism. Widening it would let last
      // June's homework report as this year's latest update.
      const { service, homeworkFindFirst, behaviorFindFirst } = makeService({
        startYear: '2026',
      });

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

    it('keeps the window one year wide when MASHOV_YEAR is unset', async () => {
      const { service, homeworkFindMany } = makeService();

      await service.getDashboard('user-1');

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: windowWhere(2027, 2027) }),
      );
    });
  });
});
