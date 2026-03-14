import { FeedService } from './feed.service';
import { PrismaService } from '../prisma/prisma.service';

function makeMockPrisma(overrides: Partial<{
  studentFindMany: jest.Mock;
  homeworkFindMany: jest.Mock;
  behaviorFindMany: jest.Mock;
  mailFindMany: jest.Mock;
}>): jest.Mocked<PrismaService> {
  return {
    student: { findMany: overrides.studentFindMany ?? jest.fn().mockResolvedValue([]) },
    homeworkItem: { findMany: overrides.homeworkFindMany ?? jest.fn().mockResolvedValue([]) },
    behaviorItem: { findMany: overrides.behaviorFindMany ?? jest.fn().mockResolvedValue([]) },
    mailConversation: { findMany: overrides.mailFindMany ?? jest.fn().mockResolvedValue([]) },
  } as unknown as jest.Mocked<PrismaService>;
}

describe('FeedService', () => {
  describe('getFeed', () => {
    it('returns empty paginated result when all sources are empty', async () => {
      const service = new FeedService(makeMockPrisma({}));
      const result = await service.getFeed(1, 20);

      expect(result.data).toEqual([]);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    it('maps homework items to contract-compliant feed items with isNew and isArchived', async () => {
      const hw = {
        id: 'hw-1',
        studentGuid: 'student-abc',
        subjectName: 'Math',
        homeworkText: 'Solve exercises 1-10',
        lessonDate: new Date('2026-03-11T00:00:00Z'),
        isNew: true,
        isArchived: false,
        updatedAt: new Date('2026-03-11T05:00:00Z'),
      };

      const service = new FeedService(
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
        isNew: true,
        isArchived: false,
        linkPath: '/children/student-abc',
      });
    });

    it('does not include isUnread or isHandled fields on homework feed items', async () => {
      const hw = {
        id: 'hw-1',
        studentGuid: 'student-abc',
        subjectName: 'Math',
        homeworkText: 'Solve exercises 1-10',
        lessonDate: new Date('2026-03-11T00:00:00Z'),
        isNew: true,
        isArchived: false,
        updatedAt: new Date('2026-03-11T05:00:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({ homeworkFindMany: jest.fn().mockResolvedValue([hw]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).not.toHaveProperty('isUnread');
      expect(result.data[0]).not.toHaveProperty('isHandled');
    });

    it('excludes archived homework items from feed results', async () => {
      const archived = {
        id: 'hw-archived',
        studentGuid: 'student-abc',
        subjectName: 'Math',
        homeworkText: 'Old homework',
        lessonDate: new Date('2026-03-09T00:00:00Z'),
        isNew: false,
        isArchived: true,
        updatedAt: new Date('2026-03-09T05:00:00Z'),
      };

      const homeworkFindMany = jest.fn().mockResolvedValue([archived]);
      const service = new FeedService(
        makeMockPrisma({ homeworkFindMany }),
      );

      await service.getFeed(1, 20);
      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isArchived: false }),
        }),
      );
    });

    it('excludes archived behavior items from feed results', async () => {
      const behaviorFindMany = jest.fn().mockResolvedValue([]);
      const service = new FeedService(
        makeMockPrisma({ behaviorFindMany }),
      );

      await service.getFeed(1, 20);
      expect(behaviorFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isArchived: false }),
        }),
      );
    });

    it('maps positive behavior items to sourceType=positive with isNew and isArchived', async () => {
      const behavior = {
        id: 'beh-1',
        studentGuid: 'student-abc',
        achvaName: 'Excellence award',
        remark: null,
        classification: 'positive',
        eventAt: new Date('2026-03-11T09:00:00Z'),
        isNew: false,
        isArchived: false,
        updatedAt: new Date('2026-03-11T09:10:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({ behaviorFindMany: jest.fn().mockResolvedValue([behavior]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).toMatchObject({
        sourceType: 'positive',
        priority: 'low',
        isPositive: true,
        isNew: false,
        isArchived: false,
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
        isNew: true,
        isArchived: false,
        updatedAt: new Date('2026-03-11T09:10:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({ behaviorFindMany: jest.fn().mockResolvedValue([behavior]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).toMatchObject({
        sourceType: 'behavior',
        priority: 'high',
        isPositive: false,
        isNew: true,
        summary: 'Was 10 minutes late',
      });
    });

    it('maps mail conversations to route-aware feed items with isNew from conversation', async () => {
      const conv = {
        id: 'conv-db-1',
        conversationId: 'conv-public-1',
        subject: 'Parent evening',
        senderNamePreview: 'Principal',
        sendTime: new Date('2026-03-11T10:00:00Z'),
        isNew: true,
        lastFetchedAt: new Date('2026-03-11T10:05:00Z'),
      };

      const service = new FeedService(
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
        isNew: true,
        linkPath: '/inbox/conv-public-1',
      });
    });

    it('does not include isUnread or isHandled on mail feed items', async () => {
      const conv = {
        id: 'conv-db-1',
        conversationId: 'conv-public-1',
        subject: 'Parent evening',
        senderNamePreview: 'Principal',
        sendTime: new Date('2026-03-11T10:00:00Z'),
        isNew: true,
        lastFetchedAt: new Date('2026-03-11T10:05:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({ mailFindMany: jest.fn().mockResolvedValue([conv]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0]).not.toHaveProperty('isUnread');
      expect(result.data[0]).not.toHaveProperty('isHandled');
    });

    it('requests mail conversations without archived label', async () => {
      const mailFindMany = jest.fn().mockResolvedValue([]);
      const service = new FeedService(
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

      const service = new FeedService(
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

      const service = new FeedService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([older, newer]),
        }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].id).toBe('hw-new');
      expect(result.data[1].id).toBe('hw-old');
    });

    it('applies isNew directly from homework source table', async () => {
      const hw = {
        id: 'hw-new-flag',
        studentGuid: 'student-1',
        subjectName: 'Math',
        homeworkText: 'Done',
        lessonDate: new Date('2026-03-11T08:00:00Z'),
        isNew: true,
        isArchived: false,
        updatedAt: new Date('2026-03-11T08:30:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([hw]),
        }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].isNew).toBe(true);
    });

    it('applies isNew=false directly from source table when not new', async () => {
      const hw = {
        id: 'hw-old-flag',
        studentGuid: 'student-1',
        subjectName: 'Math',
        homeworkText: 'Done',
        lessonDate: new Date('2026-03-11T08:00:00Z'),
        isNew: false,
        isArchived: false,
        updatedAt: new Date('2026-03-11T08:30:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([hw]),
        }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].isNew).toBe(false);
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

      const service = new FeedService(
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
