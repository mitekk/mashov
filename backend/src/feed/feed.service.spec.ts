import { FeedService } from './feed.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';

function makeMockPrisma(overrides: Partial<{
  studentFindMany: jest.Mock;
  homeworkFindMany: jest.Mock;
  behaviorFindMany: jest.Mock;
  mailFindMany: jest.Mock;
  connectionFindFirst: jest.Mock;
  connectionFindMany: jest.Mock;
}>): jest.Mocked<PrismaService> {
  return {
    householdConnection: {
      findFirst:
        overrides.connectionFindFirst ??
        jest.fn().mockResolvedValue({ schoolYear: 2027 }),
      findMany:
        overrides.connectionFindMany ??
        jest.fn().mockResolvedValue([{ id: 'conn-1', schoolYear: 2027 }]),
    },
    studentConnection: {
      findMany: linkFindMany([{ studentGuid: 'student-1', householdConnectionId: 'conn-1' }]),
    },
    student: {
      findMany: ownershipAwareStudentFindMany(
        overrides.studentFindMany ?? jest.fn().mockResolvedValue([]),
      ),
    },
    homeworkItem: { findMany: overrides.homeworkFindMany ?? jest.fn().mockResolvedValue([]) },
    behaviorItem: { findMany: overrides.behaviorFindMany ?? jest.fn().mockResolvedValue([]) },
    mailConversation: { findMany: overrides.mailFindMany ?? jest.fn().mockResolvedValue([]) },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeConfig(startYear?: string): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'MASHOV_YEAR' ? startYear : undefined)),
  } as unknown as ConfigService;
}

function makeFeedService(prisma: PrismaService, startYear?: string): FeedService {
  return new FeedService(prisma, makeConfig(startYear));
}

/** The window predicate the feed is expected to issue. */
/**
 * The window predicate a cross-child read issues: each school's children at
 * that school's window, rather than one window for the household. With a
 * single connection it selects exactly the rows the flat form used to.
 */
function windowWhere(
  start: number,
  current: number,
  guids = ['student-1'],
  /**
   * Whether a caller is known. Without one -- the digest and cron paths -- the
   * pre-migration branch stays unrestricted, which is the behaviour those
   * paths have always had. With one it is scoped to that household's children,
   * because otherwise one household's `schoolYear = 0` rows reach every
   * other household's feed.
   */
  scoped = true,
) {
  return {
    OR: [
      scoped
        ? { studentGuid: { in: guids }, schoolYear: { in: [0] } }
        : { schoolYear: 0 },
      { studentGuid: { in: guids }, schoolYear: { gte: start, lte: current } },
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
function ownershipAwareStudentFindMany(roster: jest.Mock): jest.Mock {
  return jest.fn((args?: { where?: Record<string, unknown> }) => {
    // "Which children does nobody list" -- none, since every fixture child is
    // linked below. Before ADR-0031 this was the `householdConnectionId: null`
    // half of the same question.
    if ((args?.where?.links as { none?: object } | undefined)?.none) {
      return Promise.resolve([]);
    }
    return roster(args);
  });
}

/** The visibility edge, from the same fixture the ownership mock uses. */
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


describe('FeedService', () => {
  describe('getFeed', () => {
    it('returns empty paginated result when all sources are empty', async () => {
      const service = makeFeedService(makeMockPrisma({}));
      const result = await service.getFeed(1, 20);

      expect(result.data).toEqual([]);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    it('maps homework items to contract-compliant feed items with isUnread and isHandled', async () => {
      const hw = {
        id: 'hw-1',
        studentGuid: 'student-abc',
        subjectName: 'Math',
        homeworkText: 'Solve exercises 1-10',
        lessonDate: new Date('2026-03-11T00:00:00Z'),
        updatedAt: new Date('2026-03-11T05:00:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({ homeworkFindMany: jest.fn().mockResolvedValue([hw]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).toMatchObject({
        id: 'hw-1',
        sourceType: 'homework',
        sourceId: 'hw-1',
        studentGuid: 'student-abc',
        title: expect.stringContaining('Math'),
        summary: 'Solve exercises 1-10',
        category: 'homework',
        priority: 'medium',
        isPositive: false,
        isUnread: false,
        isHandled: false,
        linkPath: '/children/student-abc',
      });
    });

    it('does not include isNew or isArchived fields on homework feed items', async () => {
      const hw = {
        id: 'hw-1',
        studentGuid: 'student-abc',
        subjectName: 'Math',
        homeworkText: 'Solve exercises 1-10',
        lessonDate: new Date('2026-03-11T00:00:00Z'),
        updatedAt: new Date('2026-03-11T05:00:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({ homeworkFindMany: jest.fn().mockResolvedValue([hw]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).not.toHaveProperty('isNew');
      expect(result.data[0]).not.toHaveProperty('isArchived');
    });

    it('queries homework items ordered by lessonDate desc (no isArchived filter — field lives in UserItemState)', async () => {
      const homeworkFindMany = jest.fn().mockResolvedValue([]);
      const service = makeFeedService(
        makeMockPrisma({ homeworkFindMany }),
      );

      await service.getFeed(1, 20);
      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: windowWhere(2027, 2027, ['student-1'], false),
          orderBy: { lessonDate: 'desc' },
        }),
      );
    });

    it('queries behavior items ordered by eventAt desc (no isArchived filter — field lives in UserItemState)', async () => {
      const behaviorFindMany = jest.fn().mockResolvedValue([]);
      const service = makeFeedService(
        makeMockPrisma({ behaviorFindMany }),
      );

      await service.getFeed(1, 20);
      expect(behaviorFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: windowWhere(2027, 2027, ['student-1'], false),
          orderBy: { eventAt: 'desc' },
        }),
      );
    });

    it('maps positive behavior items to sourceType=positive with isUnread=false and isHandled=false', async () => {
      const behavior = {
        id: 'beh-1',
        studentGuid: 'student-abc',
        achvaName: 'Excellence award',
        remark: null,
        classification: 'positive',
        eventAt: new Date('2026-03-11T09:00:00Z'),
        updatedAt: new Date('2026-03-11T09:10:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({ behaviorFindMany: jest.fn().mockResolvedValue([behavior]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).toMatchObject({
        sourceType: 'positive',
        priority: 'low',
        isPositive: true,
        isUnread: false,
        isHandled: false,
        linkPath: '/children/student-abc',
      });
    });

    it('maps non-positive behavior items to sourceType=behavior', async () => {
      const behavior = {
        id: 'beh-2',
        studentGuid: 'student-abc',
        achvaName: 'Late arrival',
        remark: 'Was 10 minutes late',
        classification: 'attention',
        eventAt: new Date('2026-03-11T09:00:00Z'),
        updatedAt: new Date('2026-03-11T09:10:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({ behaviorFindMany: jest.fn().mockResolvedValue([behavior]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).toMatchObject({
        sourceType: 'behavior',
        priority: 'high',
        isPositive: false,
        isUnread: false,
        summary: 'Was 10 minutes late',
      });
    });

    it('maps mail conversations to route-aware feed items with isUnread from isUnread field', async () => {
      const conv = {
        id: 'conv-db-1',
        conversationId: 'conv-public-1',
        subject: 'Parent evening',
        senderNamePreview: 'Principal',
        sendTime: new Date('2026-03-11T10:00:00Z'),
        isUnread: true,
        labels: [],
        lastFetchedAt: new Date('2026-03-11T10:05:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({ mailFindMany: jest.fn().mockResolvedValue([conv]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).toMatchObject({
        id: 'conv-db-1',
        sourceType: 'mail',
        sourceId: 'conv-public-1',
        studentGuid: null,
        studentName: null,
        priority: 'high',
        isUnread: true,
        linkPath: '/inbox/conv-public-1',
      });
    });

    it('does not include isNew or isArchived on mail feed items', async () => {
      const conv = {
        id: 'conv-db-1',
        conversationId: 'conv-public-1',
        subject: 'Parent evening',
        senderNamePreview: 'Principal',
        sendTime: new Date('2026-03-11T10:00:00Z'),
        isUnread: true,
        labels: [],
        lastFetchedAt: new Date('2026-03-11T10:05:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({ mailFindMany: jest.fn().mockResolvedValue([conv]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).not.toHaveProperty('isNew');
      expect(result.data[0]).not.toHaveProperty('isArchived');
    });

    it('requests mail conversations without archived label', async () => {
      const mailFindMany = jest.fn().mockResolvedValue([]);
      const service = makeFeedService(
        makeMockPrisma({ mailFindMany }),
      );

      await service.getFeed(1, 20);
      expect(mailFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            NOT: { labels: { array_contains: ['archived'] } },
          },
        }),
      );
    });

    it('resolves studentName from student map when studentGuid is provided', async () => {
      const students = [{ studentGuid: 'student-abc', fullName: 'Alice Smith' }];
      const hw = {
        id: 'hw-3',
        studentGuid: 'student-abc',
        subjectName: 'Science',
        homeworkText: 'Read chapter',
        lessonDate: new Date('2026-03-11T08:00:00Z'),
        isNew: true,
        isArchived: false,
        updatedAt: new Date('2026-03-11T08:10:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({
          studentFindMany: jest.fn().mockResolvedValue(students),
          homeworkFindMany: jest.fn().mockResolvedValue([hw]),
        }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].studentName).toBe('Alice Smith');
    });

    it('sorts feed items by eventAt descending', async () => {
      const older = {
        id: 'hw-old',
        studentGuid: 'student-1',
        subjectName: 'Math',
        homeworkText: 'Old',
        lessonDate: new Date('2026-03-09T08:00:00Z'),
        isNew: false,
        isArchived: false,
        updatedAt: new Date('2026-03-09T08:30:00Z'),
      };
      const newer = {
        id: 'hw-new',
        studentGuid: 'student-1',
        subjectName: 'Math',
        homeworkText: 'New',
        lessonDate: new Date('2026-03-11T08:00:00Z'),
        isNew: true,
        isArchived: false,
        updatedAt: new Date('2026-03-11T08:30:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([older, newer]),
        }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].id).toBe('hw-new');
      expect(result.data[1].id).toBe('hw-old');
    });

    it('sets isUnread=false for homework items (per-item state not available at feed level)', async () => {
      const hw = {
        id: 'hw-new-flag',
        studentGuid: 'student-1',
        subjectName: 'Math',
        homeworkText: 'Done',
        lessonDate: new Date('2026-03-11T08:00:00Z'),
        updatedAt: new Date('2026-03-11T08:30:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([hw]),
        }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].isUnread).toBe(false);
    });

    it('sets isHandled=false for homework items (per-item state not available at feed level)', async () => {
      const hw = {
        id: 'hw-old-flag',
        studentGuid: 'student-1',
        subjectName: 'Math',
        homeworkText: 'Done',
        lessonDate: new Date('2026-03-11T08:00:00Z'),
        updatedAt: new Date('2026-03-11T08:30:00Z'),
      };

      const service = makeFeedService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([hw]),
        }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].isHandled).toBe(false);
    });

    it('spans the configured history window rather than the current year alone', async () => {
      const homeworkFindMany = jest.fn().mockResolvedValue([
        {
          id: 'hw-last-year',
          studentGuid: 'student-1',
          subjectName: 'History',
          homeworkText: 'Chapter 4',
          lessonDate: new Date('2026-05-02T08:00:00Z'),
          updatedAt: new Date('2026-05-02T08:30:00Z'),
        },
      ]);
      const service = makeFeedService(makeMockPrisma({ homeworkFindMany }), '2026');

      const result = await service.getFeed(1, 20);

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: windowWhere(2026, 2027, ['student-1'], false) }),
      );
      expect(result.data[0].id).toBe('hw-last-year');
    });

    it('excludes a year earlier than the configured start year', async () => {
      const homeworkFindMany = jest.fn().mockResolvedValue([]);
      const service = makeFeedService(makeMockPrisma({ homeworkFindMany }), '2026');

      await service.getFeed(1, 20);

      const where = homeworkFindMany.mock.calls[0][0].where;
      expect(where.OR[1].schoolYear.gte).toBe(2026);
      expect(where.OR).not.toContainEqual(
        expect.objectContaining({ schoolYear: expect.objectContaining({ gte: 2025 }) }),
      );
    });

    it('keeps the window one year wide when MASHOV_YEAR is unset', async () => {
      const homeworkFindMany = jest.fn().mockResolvedValue([]);
      const service = makeFeedService(makeMockPrisma({ homeworkFindMany }));

      await service.getFeed(1, 20);

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: windowWhere(2027, 2027, ['student-1'], false) }),
      );
    });

    it('applies pagination correctly', async () => {
      const items = [
        {
          id: 'h1',
          studentGuid: 'student-1',
          subjectName: 'Math',
          homeworkText: 'First',
          lessonDate: new Date('2026-03-11T10:00:00Z'),
          isNew: true,
          isArchived: false,
          updatedAt: new Date('2026-03-11T10:10:00Z'),
        },
        {
          id: 'h2',
          studentGuid: 'student-1',
          subjectName: 'Math',
          homeworkText: 'Second',
          lessonDate: new Date('2026-03-10T10:00:00Z'),
          isNew: false,
          isArchived: false,
          updatedAt: new Date('2026-03-10T10:10:00Z'),
        },
      ];

      const service = makeFeedService(
        makeMockPrisma({ homeworkFindMany: jest.fn().mockResolvedValue(items) }),
      );

      const result = await service.getFeed(2, 1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('h2');
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.totalPages).toBe(2);
      expect(result.pagination.total).toBe(2);
    });
  });
});
