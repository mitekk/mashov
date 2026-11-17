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
    },
    student: {
      findMany: jest.fn().mockResolvedValue([STUDENT]),
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
function windowWhere(start: number, current: number) {
  return { OR: [{ schoolYear: 0 }, { schoolYear: { gte: start, lte: current } }] };
}

const CURRENT_YEAR_ONLY = { schoolYear: { in: [2027, 0] } };

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
