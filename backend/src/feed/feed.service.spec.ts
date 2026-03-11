import { FeedService } from './feed.service';
import { PrismaService } from '../prisma/prisma.service';

function makeMockPrisma(overrides: Partial<{
  studentFindMany: jest.Mock;
  notificationFindMany: jest.Mock;
  homeworkFindMany: jest.Mock;
  behaviorFindMany: jest.Mock;
  mailFindMany: jest.Mock;
}>): jest.Mocked<PrismaService> {
  return {
    student: { findMany: overrides.studentFindMany ?? jest.fn().mockResolvedValue([]) },
    notificationEvent: { findMany: overrides.notificationFindMany ?? jest.fn().mockResolvedValue([]) },
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

    it('maps notification events to feed items with sourceType=notification', async () => {
      const notif = {
        id: 'notif-1',
        eventText: 'Class canceled',
        studentGuid: null,
        eventAt: new Date('2026-03-10T10:00:00Z'),
        readTime: null,
      };

      const service = new FeedService(
        makeMockPrisma({ notificationFindMany: jest.fn().mockResolvedValue([notif]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].sourceType).toBe('notification');
      expect(result.data[0].title).toBe('Class canceled');
      expect(result.data[0].isUnread).toBe(true); // readTime is null
    });

    it('marks notification as read when readTime is set', async () => {
      const notif = {
        id: 'notif-2',
        eventText: 'Parent meeting',
        studentGuid: null,
        eventAt: new Date('2026-03-10T10:00:00Z'),
        readTime: new Date('2026-03-10T11:00:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({ notificationFindMany: jest.fn().mockResolvedValue([notif]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].isUnread).toBe(false);
    });

    it('maps homework items to feed items with sourceType=homework', async () => {
      const hw = {
        id: 'hw-1',
        studentGuid: 'student-abc',
        subjectName: 'Math',
        homeworkText: 'Solve exercises 1-10',
        lessonDate: new Date('2026-03-11T00:00:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({ homeworkFindMany: jest.fn().mockResolvedValue([hw]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].sourceType).toBe('homework');
      expect(result.data[0].title).toContain('Math');
      expect(result.data[0].isUnread).toBe(false);
    });

    it('maps behavior items to feed items with isPositive=true when classification=positive', async () => {
      const behavior = {
        id: 'beh-1',
        studentGuid: 'student-abc',
        achvaName: 'Excellence award',
        remark: null,
        classification: 'positive',
        eventAt: new Date('2026-03-11T09:00:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({ behaviorFindMany: jest.fn().mockResolvedValue([behavior]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].sourceType).toBe('behavior');
      expect(result.data[0].isPositive).toBe(true);
      expect(result.data[0].title).toBe('Excellence award');
    });

    it('maps behavior items with isPositive=false for non-positive classification', async () => {
      const behavior = {
        id: 'beh-2',
        studentGuid: 'student-abc',
        achvaName: 'Late arrival',
        remark: 'Was 10 minutes late',
        classification: 'attention',
        eventAt: new Date('2026-03-11T09:00:00Z'),
      };

      const service = new FeedService(
        makeMockPrisma({ behaviorFindMany: jest.fn().mockResolvedValue([behavior]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].isPositive).toBe(false);
      expect(result.data[0].summary).toBe('Was 10 minutes late');
    });

    it('maps mail conversations to feed items with sourceType=mail', async () => {
      const conv = {
        id: 'conv-1',
        subject: 'Parent evening',
        senderNamePreview: 'Principal',
        sendTime: new Date('2026-03-11T10:00:00Z'),
        isUnread: true,
      };

      const service = new FeedService(
        makeMockPrisma({ mailFindMany: jest.fn().mockResolvedValue([conv]) }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].sourceType).toBe('mail');
      expect(result.data[0].title).toBe('Parent evening');
      expect(result.data[0].isUnread).toBe(true);
      expect(result.data[0].childName).toBeNull();
    });

    it('resolves childName from student map when studentGuid is provided', async () => {
      const students = [{ studentGuid: 'student-abc', fullName: 'Alice Smith' }];
      const notif = {
        id: 'notif-3',
        eventText: 'Homework reminder',
        studentGuid: 'student-abc',
        eventAt: new Date('2026-03-11T08:00:00Z'),
        readTime: null,
      };

      const service = new FeedService(
        makeMockPrisma({
          studentFindMany: jest.fn().mockResolvedValue(students),
          notificationFindMany: jest.fn().mockResolvedValue([notif]),
        }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].childName).toBe('Alice Smith');
    });

    it('sorts all feed items by timestamp descending (newest first)', async () => {
      const older = {
        id: 'notif-old',
        eventText: 'Old event',
        studentGuid: null,
        eventAt: new Date('2026-03-09T08:00:00Z'),
        readTime: null,
      };
      const newer = {
        id: 'notif-new',
        eventText: 'New event',
        studentGuid: null,
        eventAt: new Date('2026-03-11T08:00:00Z'),
        readTime: null,
      };

      const service = new FeedService(
        makeMockPrisma({
          notificationFindMany: jest.fn().mockResolvedValue([older, newer]),
        }),
      );

      const result = await service.getFeed(1, 20);
      expect(result.data[0].id).toBe('notif-new');
      expect(result.data[1].id).toBe('notif-old');
    });

    it('applies pagination: page 2 with limit 1 returns second item', async () => {
      const notifs = [
        { id: 'n1', eventText: 'First', studentGuid: null, eventAt: new Date('2026-03-11T10:00:00Z'), readTime: null },
        { id: 'n2', eventText: 'Second', studentGuid: null, eventAt: new Date('2026-03-10T10:00:00Z'), readTime: null },
      ];

      const service = new FeedService(
        makeMockPrisma({ notificationFindMany: jest.fn().mockResolvedValue(notifs) }),
      );

      const result = await service.getFeed(2, 1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('n2');
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.totalPages).toBe(2);
      expect(result.pagination.total).toBe(2);
    });

    it('returns totalPages=0 when there are no items', async () => {
      const service = new FeedService(makeMockPrisma({}));
      const result = await service.getFeed(1, 20);
      expect(result.pagination.totalPages).toBe(0);
    });
  });
});
