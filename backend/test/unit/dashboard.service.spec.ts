import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from '../../src/dashboard/dashboard.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FreshnessService } from '../../src/sync/freshness.service';
import { MashovSessionService } from '../../src/session/mashov-session.service';
import { UserItemStateService } from '../../src/common/user-item-state.service';

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
      // `school` was the household's most recently used connection under a
      // singular name; T14 removed it, and every school label on this
      // response is per-item now.
      expect(result).not.toHaveProperty('school');

      expect(result.freshness).toHaveProperty('state');
      expect(result.freshness).toHaveProperty('lastSyncAt');
    });

    it('summary uses newConversations key (not unreadConversations)', async () => {
      seedEmptyState();
      mockPrisma.mailConversation.count.mockResolvedValue(7);

      const result = await service.getDashboard();

      expect(result.summary).toHaveProperty('newConversations');
      expect(result.summary).not.toHaveProperty('unreadConversations');
      expect(result.summary.newConversations).toBe(7);
    });

    it('summary newConversations sums the caller\'s connections plus the unowned rows', async () => {
      // Summed, not read from one row: with two schools the badge is the
      // household's total, and the most recent connection's row alone would
      // show one school's mail and hide the other's. On top of that sum go the
      // conversations no connection owns, added ONCE by the reader (R15) --
      // two connections here, so counting them in each writer would have
      // counted them twice.
      seedEmptyState();
      mockPrisma.householdConnection.aggregate.mockResolvedValue({
        _sum: { cachedNewCount: 16 + 7 },
        _count: { _all: 2 },
      });
      mockPrisma.mailConversation.count.mockImplementation(({ where }) =>
        Promise.resolve(where?.householdConnectionId === null ? 2 : 7),
      );

      const result = await service.getDashboard();

      expect(result.summary.newConversations).toBe(25);
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

    it('scopes the feed to the current year, so a prior-year item never reaches it', async () => {
      // ADR-0035. The feed is the page a parent lands on, so last year lives
      // behind `ארכיון` instead; the backfill's window still fetches it.
      seedEmptyState();
      mockPrisma.student.findMany.mockResolvedValue([
        { studentGuid: 'sg-1', fullName: 'Test Child', privateName: 'Test', familyName: 'Child' },
      ]);
      mockPrisma.householdConnection.findMany.mockResolvedValue([
        { id: 'conn-1', schoolYear: 2027 },
      ]);
      mockPrisma.studentConnection.findMany.mockResolvedValue([
        { studentGuid: 'sg-1', householdConnectionId: 'conn-1' },
      ]);
      // Answers the way the database would: nothing for a year the predicate
      // does not name.
      mockPrisma.homeworkItem.findMany.mockImplementation(
        async (args: { select?: object; where?: { OR?: Array<{ schoolYear?: { in?: number[] } }> } }) => {
          if (args?.select) return [];
          const years = (args?.where?.OR ?? []).flatMap((clause) => clause.schoolYear?.in ?? []);
          return years.includes(2026)
            ? [
                {
                  id: 'hw-last-year',
                  studentGuid: 'sg-1',
                  subjectName: 'History',
                  homeworkText: 'Chapter 4',
                  lessonDate: new Date('2026-05-02T08:00:00Z'),
                  updatedAt: new Date('2026-05-02T08:30:00Z'),
                },
              ]
            : [];
        },
      );

      const result = await service.getDashboard('user-1');

      expect(result.feed).toHaveLength(0);
      const listCall = mockPrisma.homeworkItem.findMany.mock.calls
        .map((call: [{ select?: object; where?: unknown }]) => call[0])
        .find((args: { select?: object }) => !args?.select);
      expect(JSON.stringify(listCall?.where)).not.toContain('gte');
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
        neutralBehaviorCount: 0,
      });
      expect(typeof result.children[0].oneLineStatus).toBe('string');
    });

    it('counts a month-old unread item on the child card, with no date floor', async () => {
      // Same shared counter as GET /children, so the home card and the
      // children card can never disagree about the same child again.
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
      mockPrisma.homeworkItem.findMany.mockImplementation(
        async (args: { select?: object }) => (args?.select ? [{ id: 'hw-old' }] : []),
      );
      mockPrisma.behaviorItem.findMany.mockImplementation(
        async (args: { select?: object }) =>
          args?.select
            ? [
                { id: 'beh-attention', classification: 'attention' },
                { id: 'beh-neutral', classification: 'neutral' },
                { id: 'beh-positive', classification: 'positive' },
              ]
            : [],
      );

      const result = await service.getDashboard();

      expect(result.children[0]).toMatchObject({
        recentHomeworkCount: 1,
        // The neutral row is its own bucket now, not a negative event.
        recentBehaviorCount: 1,
        positiveBehaviorCount: 1,
        neutralBehaviorCount: 1,
      });
      const countQueries = mockPrisma.behaviorItem.findMany.mock.calls
        .map(([args]: [{ select?: object; where?: object }]) => args)
        .filter((args) => args?.select);
      expect(countQueries).toHaveLength(1);
      expect(countQueries[0].where).toEqual(
        expect.not.objectContaining({ lessonDate: expect.anything() }),
      );
    });

    it('excludes read and archived items from the child card counts', async () => {
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
      mockPrisma.homeworkItem.findMany.mockImplementation(
        async (args: { select?: object }) =>
          args?.select ? [{ id: 'hw-read' }, { id: 'hw-unread' }] : [],
      );
      mockPrisma.behaviorItem.findMany.mockImplementation(
        async (args: { select?: object }) =>
          args?.select
            ? [
                { id: 'beh-archived', classification: 'attention' },
                { id: 'beh-unread', classification: 'attention' },
              ]
            : [],
      );
      mockUserItemState.getStateBatch.mockImplementation(
        async (_userId: string, itemType: string) =>
          itemType === 'homework'
            ? new Map([['hw-read', { isNew: false, isArchived: false }]])
            : new Map([['beh-archived', { isNew: true, isArchived: true }]]),
      );

      const result = await service.getDashboard('user-1');

      expect(result.children[0]).toMatchObject({
        recentHomeworkCount: 1,
        recentBehaviorCount: 1,
      });

      // `clearAllMocks` keeps implementations, so this one is handed back.
      mockUserItemState.getStateBatch.mockResolvedValue(new Map());
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
