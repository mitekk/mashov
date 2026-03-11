import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from '../../src/dashboard/dashboard.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FreshnessService } from '../../src/sync/freshness.service';

const mockPrisma = {
  mailConversation: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  student: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  homeworkItem: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  behaviorItem: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  notificationEvent: {
    findMany: jest.fn(),
  },
  messageBoardItem: {
    findMany: jest.fn(),
  },
};

const mockFreshness = {
  computeFreshness: jest.fn(),
};

describe('DashboardService', () => {
  let service: DashboardService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: FreshnessService, useValue: mockFreshness },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
  });

  describe('getDashboard', () => {
    it('returns all dashboard sections', async () => {
      mockPrisma.mailConversation.count.mockResolvedValue(3);
      mockPrisma.student.count.mockResolvedValue(2);
      mockPrisma.homeworkItem.count.mockResolvedValue(5);
      mockPrisma.behaviorItem.count.mockResolvedValue(1);
      mockPrisma.student.findMany.mockResolvedValue([]);
      mockPrisma.mailConversation.findMany.mockResolvedValue([]);
      mockPrisma.behaviorItem.findMany.mockResolvedValue([]);
      mockPrisma.homeworkItem.findMany.mockResolvedValue([]);
      mockPrisma.notificationEvent.findMany.mockResolvedValue([]);
      mockPrisma.behaviorItem.findFirst.mockResolvedValue(null);
      mockFreshness.computeFreshness.mockResolvedValue({
        state: 'fresh',
        lastSyncAt: '2026-03-11T10:00:00Z',
        staleSources: [],
      });

      const result = await service.getDashboard();

      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('needsAttention');
      expect(result).toHaveProperty('feed');
      expect(result).toHaveProperty('children');
      expect(result).toHaveProperty('freshness');
    });
  });

  describe('needsAttention priority ordering', () => {
    it('places conversations before behavior before homework', async () => {
      const now = new Date();

      mockPrisma.mailConversation.findMany.mockResolvedValueOnce([
        {
          id: 'conv-1',
          subject: 'Unread message',
          sendTime: now,
          conversationId: 'conv-id-1',
        },
      ]);

      mockPrisma.behaviorItem.findMany.mockResolvedValueOnce([
        {
          id: 'beh-1',
          achvaName: 'Late arrival',
          studentGuid: 'sg-1',
          eventAt: now,
          classification: 'attention',
        },
      ]);

      mockPrisma.homeworkItem.findMany.mockResolvedValueOnce([
        {
          id: 'hw-1',
          subjectName: 'Math',
          homeworkText: 'Do exercises',
          studentGuid: 'sg-1',
          lessonDate: now,
        },
      ]);

      mockPrisma.student.findMany.mockResolvedValue([
        { studentGuid: 'sg-1', fullName: 'Test Child' },
      ]);

      // Access private method via getDashboard
      mockPrisma.mailConversation.count.mockResolvedValue(1);
      mockPrisma.student.count.mockResolvedValue(1);
      mockPrisma.homeworkItem.count.mockResolvedValue(1);
      mockPrisma.behaviorItem.count.mockResolvedValue(1);
      mockPrisma.notificationEvent.findMany.mockResolvedValue([]);
      mockPrisma.behaviorItem.findFirst.mockResolvedValue(null);
      mockFreshness.computeFreshness.mockResolvedValue({
        state: 'fresh',
        lastSyncAt: null,
        staleSources: [],
      });

      const result = await service.getDashboard();
      const attention = result.needsAttention;

      expect(attention.length).toBeGreaterThan(0);
      // First item should be conversation (highest priority)
      expect(attention[0].type).toBe('conversation');
    });

    it('handles empty state (no children, no items)', async () => {
      mockPrisma.mailConversation.count.mockResolvedValue(0);
      mockPrisma.student.count.mockResolvedValue(0);
      mockPrisma.homeworkItem.count.mockResolvedValue(0);
      mockPrisma.behaviorItem.count.mockResolvedValue(0);
      mockPrisma.student.findMany.mockResolvedValue([]);
      mockPrisma.mailConversation.findMany.mockResolvedValue([]);
      mockPrisma.behaviorItem.findMany.mockResolvedValue([]);
      mockPrisma.homeworkItem.findMany.mockResolvedValue([]);
      mockPrisma.notificationEvent.findMany.mockResolvedValue([]);
      mockPrisma.behaviorItem.findFirst.mockResolvedValue(null);
      mockFreshness.computeFreshness.mockResolvedValue({
        state: 'stale',
        lastSyncAt: null,
        staleSources: ['notifications'],
      });

      const result = await service.getDashboard();

      expect(result.needsAttention).toEqual([]);
      expect(result.feed).toEqual([]);
      expect(result.children).toEqual([]);
      expect(result.summary.childrenCount).toBe(0);
    });
  });

  describe('freshness', () => {
    it('correctly maps freshness state from FreshnessService', async () => {
      mockPrisma.mailConversation.count.mockResolvedValue(0);
      mockPrisma.student.count.mockResolvedValue(0);
      mockPrisma.homeworkItem.count.mockResolvedValue(0);
      mockPrisma.behaviorItem.count.mockResolvedValue(0);
      mockPrisma.student.findMany.mockResolvedValue([]);
      mockPrisma.mailConversation.findMany.mockResolvedValue([]);
      mockPrisma.behaviorItem.findMany.mockResolvedValue([]);
      mockPrisma.homeworkItem.findMany.mockResolvedValue([]);
      mockPrisma.notificationEvent.findMany.mockResolvedValue([]);
      mockFreshness.computeFreshness.mockResolvedValue({
        state: 'degraded',
        lastSyncAt: '2026-03-10T08:00:00Z',
        staleSources: ['notifications', 'homework', 'behavior'],
      });

      const result = await service.getDashboard();

      expect(result.freshness.status).toBe('degraded');
      expect(result.freshness.staleSources).toHaveLength(3);
      expect(result.freshness.lastSuccessfulSyncAt).toBe('2026-03-10T08:00:00Z');
    });
  });
});
