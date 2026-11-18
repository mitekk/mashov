import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from '../../src/dashboard/dashboard.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FreshnessService } from '../../src/sync/freshness.service';
import { MashovSessionService } from '../../src/session/mashov-session.service';
import { UserItemStateService } from '../../src/common/user-item-state.service';
import { ConfigService } from '@nestjs/config';

const mockPrisma = {
  mailConversation: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  // No link rows: `buildStudentSchoolMap` then falls back to the routing
  // stamp, so these suites read exactly the schools they always did.
  studentConnection: { findMany: jest.fn().mockResolvedValue([]) },
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
  householdConnection: {
    findFirst: jest.fn(),
    // The cross-child year scope lists the connections rather than resolving
    // one household-wide year.
    findMany: jest.fn(),
    // The badge is summed over the caller's own connections.
    aggregate: jest.fn(),
  },
};

const mockFreshness = {
  computeFreshness: jest.fn(),
};

const mockSession = {
  ensureStudentsAvailable: jest.fn(),
};

const mockUserItemState = {
  getStateBatch: jest.fn().mockResolvedValue(new Map()),
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
        { provide: MashovSessionService, useValue: mockSession },
        { provide: UserItemStateService, useValue: mockUserItemState },
        // MASHOV_YEAR unset: the history window is one year wide, so these
        // expectations are unchanged by the window's introduction.
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
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
    mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
    mockPrisma.householdConnection.findMany.mockResolvedValue([]);
    mockPrisma.householdConnection.aggregate.mockResolvedValue({
      _sum: { cachedNewCount: null },
      _count: { _all: 0 },
    });
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
        cachedNewCount: 0,
      });

      const result = await service.getDashboard();

      expect(result).toHaveProperty('summary');
      expect(result).not.toHaveProperty('needsAttention');
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

    it('summary uses newConversations key (not unreadConversations)', async () => {
      seedEmptyState();
      mockPrisma.mailConversation.count.mockResolvedValue(7);

      const result = await service.getDashboard();

      expect(result.summary).toHaveProperty('newConversations');
      expect(result.summary).not.toHaveProperty('unreadConversations');
      expect(result.summary.newConversations).toBe(7);
    });

    it('summary newConversations sums cachedNewCount across the caller\'s connections', async () => {
      // Summed, not read from one row: with two schools the badge is the
      // household's total, and the most recent connection's row alone would
      // show one school's mail and hide the other's.
      seedEmptyState();
      mockPrisma.householdConnection.aggregate.mockResolvedValue({
        _sum: { cachedNewCount: 16 + 7 },
        _count: { _all: 2 },
      });
      mockPrisma.mailConversation.count.mockResolvedValue(7);

      const result = await service.getDashboard();

      expect(result.summary.newConversations).toBe(23);
    });

    it('summary newConversations falls back to DB count when cachedNewCount is null', async () => {
      seedEmptyState();
      mockPrisma.householdConnection.findFirst.mockResolvedValue(null);
      mockPrisma.mailConversation.count.mockResolvedValue(4);

      const result = await service.getDashboard();

      expect(result.summary.newConversations).toBe(4);
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
          isNew: true,
          isArchived: false,
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

    it('returns children cards with unread homework/negative behavior/positive behavior counts', async () => {
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
      mockPrisma.homeworkItem.findMany.mockImplementation(async (args: { select?: object; take?: number }) => {
        if (args?.select) {
          return [{ id: 'hw-1' }, { id: 'hw-2' }];
        }
        if (args?.take) {
          return [];
        }
        return [];
      });
      mockPrisma.behaviorItem.findMany.mockImplementation(async (args: { select?: object; take?: number }) => {
        if (args?.select) {
          return [
            { id: 'beh-1', classification: 'attention' },
            { id: 'beh-2', classification: 'positive' },
          ];
        }
        if (args?.take) {
          return [];
        }
        return [];
      });
      mockPrisma.homeworkItem.findFirst.mockResolvedValue({ lessonDate: now });
      mockPrisma.behaviorItem.findFirst.mockResolvedValue({ eventAt: now });

      const result = await service.getDashboard();
      expect(result.children[0]).toMatchObject({
        studentGuid: 'sg-1',
        privateName: 'Test',
        familyName: 'Child',
        recentHomeworkCount: 2,
        recentBehaviorCount: 1,
        positiveBehaviorCount: 1,
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
