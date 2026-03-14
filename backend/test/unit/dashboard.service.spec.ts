import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from '../../src/dashboard/dashboard.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FreshnessService } from '../../src/sync/freshness.service';
import { SessionService } from '../../src/session/session.service';

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
    findFirst: jest.fn(),
  },
  behaviorItem: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  readState: {
    findMany: jest.fn(),
  },
  householdConnection: {
    findFirst: jest.fn(),
  },
};

const mockFreshness = {
  computeFreshness: jest.fn(),
};

const mockSession = {
  ensureStudentsAvailable: jest.fn(),
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
        { provide: SessionService, useValue: mockSession },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
  });

  function seedEmptyState() {
    mockPrisma.mailConversation.count.mockResolvedValue(0);
    mockPrisma.student.count.mockResolvedValue(0);
    mockPrisma.homeworkItem.count.mockResolvedValue(0);
    mockPrisma.behaviorItem.count.mockResolvedValue(0);
    mockPrisma.student.findMany.mockResolvedValue([]);
    mockPrisma.mailConversation.findMany.mockResolvedValue([]);
    mockPrisma.behaviorItem.findMany.mockResolvedValue([]);
    mockPrisma.homeworkItem.findMany.mockResolvedValue([]);
    mockPrisma.homeworkItem.findFirst.mockResolvedValue(null);
    mockPrisma.behaviorItem.findFirst.mockResolvedValue(null);
    mockPrisma.readState.findMany.mockResolvedValue([]);
    mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
    mockFreshness.computeFreshness.mockResolvedValue({
      state: 'fresh',
      lastSyncAt: null,
      staleSources: [],
    });
  }

  describe('getDashboard', () => {
    it('returns all dashboard sections with contract-compliant top-level shape', async () => {
      seedEmptyState();
      mockPrisma.householdConnection.findFirst.mockResolvedValue({
        schoolName: 'Test School',
        schoolYear: 2026,
      });

      const result = await service.getDashboard();

      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('needsAttention');
      expect(result).toHaveProperty('feed');
      expect(result).toHaveProperty('children');
      expect(result).toHaveProperty('freshness');
      expect(result).toHaveProperty('school');

      expect(result.freshness).toHaveProperty('state');
      expect(result.freshness).toHaveProperty('lastSyncAt');
      expect(result.school).toEqual({
        schoolName: 'Test School',
        schoolYear: 2026,
      });
    });
  });

  describe('needsAttention priority ordering', () => {
    it('places unread conversations before behavior before homework', async () => {
      const now = new Date();

      mockPrisma.mailConversation.findMany.mockResolvedValue([
        {
          id: 'conv-1',
          subject: 'Unread message',
          senderNamePreview: 'Teacher',
          sendTime: now,
          conversationId: 'conv-id-1',
          isUnread: true,
          lastFetchedAt: now,
        },
      ]);

      mockPrisma.behaviorItem.findMany.mockResolvedValue([
        {
          id: 'beh-1',
          achvaName: 'Late arrival',
          remark: 'Late to class',
          subject: 'Math',
          studentGuid: 'sg-1',
          eventAt: now,
          classification: 'attention',
          updatedAt: now,
        },
      ]);

      mockPrisma.homeworkItem.findMany.mockResolvedValue([
        {
          id: 'hw-1',
          subjectName: 'Math',
          homeworkText: 'Do exercises',
          studentGuid: 'sg-1',
          lessonDate: now,
          updatedAt: now,
        },
      ]);

      mockPrisma.student.findMany.mockResolvedValue([
        { studentGuid: 'sg-1', fullName: 'Test Child' },
      ]);

      mockPrisma.mailConversation.count.mockResolvedValue(1);
      mockPrisma.student.count.mockResolvedValue(1);
      mockPrisma.homeworkItem.count.mockResolvedValue(1);
      mockPrisma.behaviorItem.count.mockResolvedValue(1);
      mockPrisma.homeworkItem.findFirst.mockResolvedValue(null);
      mockPrisma.behaviorItem.findFirst.mockResolvedValue(null);
      mockPrisma.readState.findMany.mockResolvedValue([]);
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockFreshness.computeFreshness.mockResolvedValue({
        state: 'fresh',
        lastSyncAt: null,
        staleSources: [],
      });

      const result = await service.getDashboard();
      const attention = result.needsAttention;

      expect(attention.length).toBeGreaterThan(0);
      expect(attention[0].type).toBe('unread_conversation');
    });

    it('adds sync_degraded item when freshness is degraded and list has room', async () => {
      seedEmptyState();
      mockFreshness.computeFreshness.mockResolvedValue({
        state: 'degraded',
        lastSyncAt: '2026-03-10T08:00:00Z',
        staleSources: ['mail_inbox', 'homework'],
      });

      const result = await service.getDashboard();
      expect(result.needsAttention).toHaveLength(1);
      expect(result.needsAttention[0]).toMatchObject({
        id: 'sync-degraded',
        type: 'sync_degraded',
        linkPath: '/more',
      });
    });
  });

  describe('contract fields', () => {
    it('returns feed items with supported sourceType values and linkPath', async () => {
      const now = new Date('2026-03-12T10:00:00Z');
      seedEmptyState();

      mockPrisma.student.findMany.mockResolvedValue([
        { studentGuid: 'sg-1', fullName: 'Test Child', privateName: 'Test', familyName: 'Child' },
      ]);
      mockPrisma.homeworkItem.findMany.mockResolvedValue([
        {
          id: 'hw-1',
          studentGuid: 'sg-1',
          subjectName: 'Math',
          homeworkText: 'Do exercises',
          lessonDate: now,
          updatedAt: now,
        },
      ]);

      const result = await service.getDashboard();
      expect(result.feed[0]).toMatchObject({
        sourceType: 'homework',
        sourceId: 'hw-1',
        linkPath: '/children/sg-1',
      });
    });

    it('returns children cards with recentHomeworkCount/recentBehaviorCount/oneLineStatus', async () => {
      const now = new Date('2026-03-12T10:00:00Z');
      seedEmptyState();
      mockPrisma.student.count.mockResolvedValue(1);
      mockPrisma.student.findMany.mockResolvedValue([
        {
          studentGuid: 'sg-1',
          privateName: 'Test',
          familyName: 'Child',
          fullName: 'Test Child',
          classCode: '10A',
          classNum: 10,
          updatedAt: now,
        },
      ]);
      mockPrisma.homeworkItem.count.mockResolvedValue(2);
      mockPrisma.behaviorItem.count.mockResolvedValue(1);
      mockPrisma.homeworkItem.findFirst.mockResolvedValue({ lessonDate: now });
      mockPrisma.behaviorItem.findFirst.mockResolvedValue({ eventAt: now });

      const result = await service.getDashboard();
      expect(result.children[0]).toMatchObject({
        studentGuid: 'sg-1',
        privateName: 'Test',
        familyName: 'Child',
        recentHomeworkCount: 2,
        recentBehaviorCount: 1,
      });
      expect(typeof result.children[0].oneLineStatus).toBe('string');
    });
  });

  describe('freshness', () => {
    it('maps freshness from FreshnessService using state/lastSyncAt fields', async () => {
      seedEmptyState();
      mockFreshness.computeFreshness.mockResolvedValue({
        state: 'degraded',
        lastSyncAt: '2026-03-10T08:00:00Z',
        staleSources: ['notifications', 'homework', 'behavior'],
      });

      const result = await service.getDashboard();

      expect(result.freshness.state).toBe('degraded');
      expect(result.freshness.staleSources).toHaveLength(3);
      expect(result.freshness.lastSyncAt).toBe('2026-03-10T08:00:00Z');
    });
  });
});
