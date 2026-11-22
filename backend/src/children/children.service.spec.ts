import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ChildrenService } from './children.service';
import { MashovSessionService } from '../session/mashov-session.service';
import { MashovHttpClient } from '../session/mashov-http.client';
import { ConnectionScopeService } from '../common/connection-scope/connection-scope.service';
import { UserItemStateService } from '../common/user-item-state.service';
import { calendarSchoolYear } from '../common/school-year/school-year.service';

const TEST_GUID = 'student-guid-001';

function makeStudent() {
  return {
    id: 'student-id-1',
    studentGuid: TEST_GUID,
    privateName: 'Alice',
    familyName: 'Cohen',
    fullName: 'Alice Cohen',
    classCode: '10A',
    classNum: 10,
    gender: 'F',
    isActive: true,
    householdConnectionId: 'conn-1',
    updatedAt: new Date('2026-03-12T10:00:00Z'),
  };
}

function makeHomeworkRow(overrides: object = {}) {
  return {
    id: 'hw-1',
    studentGuid: TEST_GUID,
    schoolYear: 2027,
    lessonId: 1,
    groupId: 2,
    lessonDate: new Date('2026-03-10T00:00:00Z'),
    lesson: 3,
    subjectName: 'Math',
    homeworkText: 'Page 10',
    remark: null,
    files: [],
    updatedAt: new Date('2026-03-10T01:00:00Z'),
    ...overrides,
  };
}

function makeBehaviorRow(overrides: object = {}) {
  return {
    id: 'beh-1',
    studentGuid: TEST_GUID,
    schoolYear: 2027,
    lessonId: 1,
    groupId: 2,
    eventCode: 2,
    achvaCode: 2,
    achvaName: 'חיסור',
    classification: 'attention',
    justifiable: false,
    lessonDate: new Date('2026-03-11T00:00:00Z'),
    lesson: 2,
    subject: 'Math',
    reporter: 'Teacher',
    remark: null,
    justification: null,
    eventAt: new Date('2026-03-11T10:00:00Z'),
    updatedAt: new Date('2026-03-11T11:00:00Z'),
    ...overrides,
  };
}

function makeMockUserItemStateService(): jest.Mocked<UserItemStateService> {
  return {
    getState: jest.fn().mockResolvedValue({ isNew: true, isArchived: false }),
    getStateBatch: jest.fn().mockResolvedValue(new Map()),
    setState: jest.fn().mockResolvedValue({ isNew: true, isArchived: false }),
    setStateBatch: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<UserItemStateService>;
}

function makeMockPrisma(overrides: Partial<Record<string, jest.Mock>>) {
  const student = makeStudent();
  return {
    student: {
      // `links: { none: {} }` asks "which children does nobody list" -- none
      // here, since the fixture child is linked to conn-1 below.
      findMany:
        overrides.studentFindMany ??
        jest.fn((args?: { where?: { links?: { none?: object } } }) =>
          Promise.resolve(args?.where?.links?.none ? [] : [student]),
        ),
      findUnique: overrides.studentFindUnique ?? jest.fn().mockResolvedValue(student),
    },
    homeworkItem: {
      count: overrides.homeworkCount ?? jest.fn().mockResolvedValue(0),
      findMany: overrides.homeworkFindMany ?? jest.fn().mockResolvedValue([]),
      findUnique: overrides.homeworkFindUnique ?? jest.fn().mockResolvedValue(null),
      findFirst: overrides.homeworkFindFirst ?? jest.fn().mockResolvedValue(null),
      update: overrides.homeworkUpdate ?? jest.fn().mockResolvedValue(makeHomeworkRow()),
      updateMany: overrides.homeworkUpdateMany ?? jest.fn().mockResolvedValue({ count: 0 }),
    },
    behaviorItem: {
      count: overrides.behaviorCount ?? jest.fn().mockResolvedValue(0),
      findMany: overrides.behaviorFindMany ?? jest.fn().mockResolvedValue([]),
      findUnique: overrides.behaviorFindUnique ?? jest.fn().mockResolvedValue(null),
      findFirst: overrides.behaviorFindFirst ?? jest.fn().mockResolvedValue(null),
      update: overrides.behaviorUpdate ?? jest.fn().mockResolvedValue(makeBehaviorRow()),
      updateMany: overrides.behaviorUpdateMany ?? jest.fn().mockResolvedValue({ count: 0 }),
    },
    subjectEnrollment: {
      count: overrides.subjectCount ?? jest.fn().mockResolvedValue(0),
      findMany: overrides.subjectFindMany ?? jest.fn().mockResolvedValue([]),
      aggregate:
        overrides.subjectAggregate ??
        jest.fn().mockResolvedValue({ _sum: { weeklyHours: 0 } }),
    },
    messageBoardItem: {
      findMany: overrides.noticeFindMany ?? jest.fn().mockResolvedValue([]),
    },
    timetableEntry: {
      findMany: overrides.timetableFindMany ?? jest.fn().mockResolvedValue([]),
    },
    // Empty by default, which is the default-schedule path: no school has
    // served bell times until the (unverified) upstream endpoint answers.
    bellSchedule: {
      findMany: overrides.bellScheduleFindMany ?? jest.fn().mockResolvedValue([]),
    },
    syncRun: {
      findFirst: overrides.syncRunFindFirst ?? jest.fn().mockResolvedValue(null),
    },
    // Visibility is the link set, not the routing stamp (ADR-0031). These
    // suites exercise one household's own child, so it is linked to conn-1.
    studentConnection: {
      findMany:
        overrides.studentLinkFindMany ??
        jest.fn().mockResolvedValue([
          { studentGuid: student.studentGuid, householdConnectionId: 'conn-1' },
        ]),
    },
    householdConnection: {
      findFirst:
        overrides.connectionFindFirst ??
        jest.fn().mockResolvedValue({ schoolYear: 2027 }),
      // The cross-child reads pair each school's children with that school's
      // year, so they list the connections rather than resolving one year.
      findMany:
        overrides.connectionFindMany ??
        jest.fn().mockResolvedValue([{ id: 'conn-1', schoolYear: 2027 }]),
      findUnique:
        overrides.connectionFindUnique ??
        jest.fn().mockResolvedValue({ id: 'conn-1', schoolYear: 2027 }),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeMockSession(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    ensureStudentsAvailable:
      overrides.ensureStudentsAvailable ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MashovSessionService>;
}

function makeMockMashovClient(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    // The env-session surface. Kept so a spec can still assert it is unused;
    // src/session/env-session-fence.spec.ts is what enforces that.
    get: overrides.get ?? jest.fn(),
    put: overrides.put ?? jest.fn(),
    delete: overrides.delete ?? jest.fn(),
    getResponse: overrides.getResponse ?? jest.fn(),
    // The per-connection surface the reads actually use.
    getForTarget: overrides.getForTarget ?? overrides.get ?? jest.fn(),
    putForTarget: overrides.putForTarget ?? overrides.put ?? jest.fn(),
    deleteForTarget: overrides.deleteForTarget ?? overrides.delete ?? jest.fn(),
    getResponseForTarget:
      overrides.getResponseForTarget ?? overrides.getResponse ?? jest.fn(),
  } as unknown as jest.Mocked<MashovHttpClient>;
}

/** The single target makeMockScope resolves everything to. */
const SCOPE_TARGET = {
  id: 'conn-1',
  schoolCode: 1234,
  schoolYear: 2027,
  username: 'parent',
  password: 'pw',
  schoolName: 'School',
};

/**
 * ConnectionScopeService stand-in. The reads under test resolve the owning
 * school through it; one connection means every lookup answers the same way,
 * which is what keeps these assertions identical to the pre-ownership ones.
 */
function makeMockScope(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const target = {
    id: 'conn-1',
    schoolCode: 1234,
    schoolYear: 2027,
    username: 'parent',
    password: 'pw',
    schoolName: 'School',
  };
  return {
    targetFor: overrides.targetFor ?? jest.fn().mockResolvedValue(target),
    targetForStudent: overrides.targetForStudent ?? jest.fn().mockResolvedValue(target),
    targetForConversation:
      overrides.targetForConversation ?? jest.fn().mockResolvedValue(target),
    targetForMessage: overrides.targetForMessage ?? jest.fn().mockResolvedValue(target),
    listTargets: overrides.listTargets ?? jest.fn().mockResolvedValue([target]),
    groupConversationsByConnection:
      overrides.groupConversationsByConnection ??
      jest.fn((ids: string[]) => Promise.resolve(new Map([['conn-1', ids]]))),
    studentGuidsForUser: overrides.studentGuidsForUser ?? jest.fn().mockResolvedValue([]),
    stampStudent: overrides.stampStudent ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as ConnectionScopeService;
}

function makeMockConfig(startYear?: string): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'MASHOV_YEAR' ? startYear : undefined)),
  } as unknown as ConfigService;
}

/** The window predicate a per-CHILD history-spanning read is expected to issue. */
function windowWhere(start: number, current: number) {
  return { OR: [{ schoolYear: 0 }, { schoolYear: { gte: start, lte: current } }] };
}

/**
 * The current-year predicate a CROSS-CHILD read issues.
 *
 * Each school's children paired with that school's year, rather than one year
 * for the household. With a single connection that is this one clause, which
 * selects exactly the rows `{ schoolYear: { in: [year, 0] } }` used to.
 */
function crossChildYearWhere(year: number, guids: string[] = [TEST_GUID]) {
  return {
    OR: [
      // Scoped to the household's own children: unscoped, one household's
      // pre-migration rows reached every other household's reads.
      { studentGuid: { in: guids }, schoolYear: { in: [0] } },
      { studentGuid: { in: guids }, schoolYear: { in: [year] } },
    ],
  };
}


describe('ChildrenService', () => {
  describe('getChildren', () => {
    it('returns {data} with computed counts and latestUpdateAt', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([
            { id: 'hw-1' },
            { id: 'hw-2' },
          ]),
          behaviorFindMany: jest.fn().mockResolvedValue([
            { id: 'beh-1', classification: 'attention' },
            { id: 'beh-2', classification: 'positive' },
          ]),
          subjectCount: jest.fn().mockResolvedValue(5),
          homeworkFindFirst: jest.fn().mockResolvedValue({
            lessonDate: new Date('2026-03-12T12:00:00Z'),
          }),
          behaviorFindFirst: jest.fn().mockResolvedValue({
            eventAt: new Date('2026-03-12T13:00:00Z'),
          }),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getChildren();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data[0]).toMatchObject({
        studentGuid: TEST_GUID,
        recentHomeworkCount: 2,
        recentBehaviorCount: 1,
        positiveBehaviorCount: 1,
        subjectCount: 5,
      });
      expect(typeof result.data[0].latestUpdateAt).toBe('string');
    });

    it('applies user-scoped unread and archived state to activity counts', async () => {
      const mockUserItemState = {
        getState: jest.fn().mockResolvedValue({ isNew: true, isArchived: false }),
        getStateBatch: jest
          .fn()
          .mockResolvedValueOnce(new Map([
            ['hw-1', { isNew: false, isArchived: false }],
            ['hw-2', { isNew: true, isArchived: true }],
          ]))
          .mockResolvedValueOnce(new Map([
            ['beh-1', { isNew: false, isArchived: false }],
            ['beh-2', { isNew: true, isArchived: true }],
          ])),
        setState: jest.fn().mockResolvedValue({ isNew: true, isArchived: false }),
        setStateBatch: jest.fn().mockResolvedValue(0),
      } as unknown as jest.Mocked<UserItemStateService>;

      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([
            { id: 'hw-1' },
            { id: 'hw-2' },
          ]),
          behaviorFindMany: jest.fn().mockResolvedValue([
            { id: 'beh-1', classification: 'attention' },
            { id: 'beh-2', classification: 'positive' },
            { id: 'beh-3', classification: 'neutral' },
          ]),
          subjectCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        mockUserItemState,
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getChildren('user-1');
      expect(result.data[0]).toMatchObject({
        recentHomeworkCount: 0,
        // beh-1 is read and beh-2 archived, so only the neutral beh-3 is
        // visible -- and a neutral row is not an attention row.
        recentBehaviorCount: 0,
        positiveBehaviorCount: 0,
        neutralBehaviorCount: 1,
      });
    });

    it('counts an unread item whose lessonDate is a month old', async () => {
      // The chips sit directly above lists that span the whole year, so a
      // rolling date floor made a school that logs weekly look unsynced. The
      // floor is gone: these rows are counted on read state and year alone.
      const homeworkFindMany = jest.fn().mockResolvedValue([{ id: 'hw-old' }]);
      const behaviorFindMany = jest.fn().mockResolvedValue([
        { id: 'beh-old', classification: 'attention' },
      ]);
      const service = new ChildrenService(
        makeMockPrisma({ homeworkFindMany, behaviorFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getChildren('user-1');

      expect(result.data[0]).toMatchObject({
        recentHomeworkCount: 1,
        recentBehaviorCount: 1,
      });
      // No `lessonDate` predicate on either count query.
      for (const call of [homeworkFindMany, behaviorFindMany]) {
        expect(call).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.not.objectContaining({ lessonDate: expect.anything() }),
          }),
        );
      }
    });

    it('splits behaviour into attention, positive and neutral buckets', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindMany: jest.fn().mockResolvedValue([
            { id: 'beh-1', classification: 'attention' },
            { id: 'beh-2', classification: 'attention' },
            { id: 'beh-3', classification: 'positive' },
            { id: 'beh-4', classification: 'neutral' },
            { id: 'beh-5', classification: 'neutral' },
            { id: 'beh-6', classification: 'neutral' },
          ]),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getChildren('user-1');

      expect(result.data[0]).toMatchObject({
        recentBehaviorCount: 2,
        positiveBehaviorCount: 1,
        neutralBehaviorCount: 3,
      });
    });
  });

  describe('getChildWorkspace', () => {
    it('returns contract shape {student, summary, lastSyncAt}', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([
            { id: 'hw-1' },
            { id: 'hw-2' },
            { id: 'hw-3' },
          ]),
          behaviorFindMany: jest.fn().mockResolvedValue([
            { id: 'beh-1', classification: 'attention' },
            { id: 'beh-2', classification: 'attention' },
            { id: 'beh-3', classification: 'positive' },
          ]),
          subjectCount: jest.fn().mockResolvedValue(4),
          subjectAggregate: jest.fn().mockResolvedValue({ _sum: { weeklyHours: 9 } }),
          syncRunFindFirst: jest.fn().mockResolvedValue({
            endedAt: new Date('2026-03-12T14:00:00Z'),
          }),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getChildWorkspace(TEST_GUID);
      expect(result.student.studentGuid).toBe(TEST_GUID);
      expect(result.summary).toEqual({
        recentHomeworkCount: 3,
        recentBehaviorCount: 2,
        positiveBehaviorCount: 1,
        neutralBehaviorCount: 0,
        subjectCount: 4,
        totalWeeklyHours: 9,
      });
      expect(result.lastSyncAt).toBe('2026-03-12T14:00:00.000Z');
    });

    it('throws NotFoundException for unknown student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          studentFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.getChildWorkspace('missing-guid')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getHomework', () => {
    it('returns paginated data with isNew and isArchived defaults when no userId', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([makeHomeworkRow()]);
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: mockFindMany,
          homeworkCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getHomework(TEST_GUID, 1, 20);
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ studentGuid: TEST_GUID }),
        }),
      );
      // without userId, state defaults to isNew=true, isArchived=false
      expect(result.pagination).toMatchObject({ total: 1, totalPages: 1 });
      expect(result.data[0].isNew).toBe(true);
      expect(result.data[0].isArchived).toBe(false);
      expect(result.data[0].lessonDate).toBe('2026-03-10T00:00:00.000Z');
    });

    it('status=archived returns no items when all items default to isNew=true', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([makeHomeworkRow()]),
          homeworkCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      // No userId → defaults to isNew=true, isArchived=false → 'archived' filter returns 0
      const result = await service.getHomework(TEST_GUID, 1, 20, 'archived');
      expect(result.data).toHaveLength(0);
    });

    it('status=all does not filter out non-archived items', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([makeHomeworkRow()]);
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: mockFindMany,
          homeworkCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getHomework(TEST_GUID, 1, 20, 'all');
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ studentGuid: TEST_GUID }),
        }),
      );
      expect(result.data).toHaveLength(1);
    });

    it('does not include isHandled field on homework items', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([makeHomeworkRow()]),
          homeworkCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getHomework(TEST_GUID, 1, 20);
      expect(result.data[0]).not.toHaveProperty('isHandled');
    });
  });

  describe('getHomeworkDetail', () => {
    it('returns a single homework detail item with isNew and isArchived defaults when no userId', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(makeHomeworkRow()),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getHomeworkDetail(TEST_GUID, 'hw-1');
      expect(result).toMatchObject({
        id: 'hw-1',
        studentGuid: TEST_GUID,
        isNew: true,
        isArchived: false,
      });
      expect(result.lessonDate).toBe('2026-03-10T00:00:00.000Z');
    });

    it('does not include isHandled field on homework detail', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(makeHomeworkRow()),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getHomeworkDetail(TEST_GUID, 'hw-1');
      expect(result).not.toHaveProperty('isHandled');
    });

    it('throws NotFoundException when homework item is missing', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.getHomeworkDetail(TEST_GUID, 'missing-hw')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when homework item belongs to another student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(
            makeHomeworkRow({ studentGuid: 'other-student-guid' }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.getHomeworkDetail(TEST_GUID, 'hw-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setHomeworkIsNew', () => {
    it('returns item with new isNew value when no userId (no DB write)', async () => {
      const homeworkUpdate = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(makeHomeworkRow()),
          homeworkUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setHomeworkIsNew(TEST_GUID, 'hw-1', false);
      // Without userId, no DB write — just returns mapped item with requested isNew
      expect(homeworkUpdate).not.toHaveBeenCalled();
      expect(result.isNew).toBe(false);
    });

    it('throws NotFoundException when homework belongs to another student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(
            makeHomeworkRow({ studentGuid: 'other-guid' }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.setHomeworkIsNew(TEST_GUID, 'hw-1', false)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('with userId: does not update isNew when item is archived', async () => {
      const mockGetState = jest.fn().mockResolvedValue({ isNew: false, isArchived: true });
      const mockSetState = jest.fn();
      const mockUserItemState = {
        getState: mockGetState,
        getStateBatch: jest.fn().mockResolvedValue(new Map()),
        setState: mockSetState,
        setStateBatch: jest.fn().mockResolvedValue(0),
      } as unknown as jest.Mocked<UserItemStateService>;
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(makeHomeworkRow()),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        mockUserItemState,
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setHomeworkIsNew(TEST_GUID, 'hw-1', true, 'user-1');
      expect(mockSetState).not.toHaveBeenCalled();
      expect(result.isArchived).toBe(true);
      expect(result.isNew).toBe(false);
    });
  });

  describe('setHomeworkManyIsNew', () => {
    it('returns updated count equal to ids length when no userId (no DB write)', async () => {
      const homeworkUpdateMany = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({ homeworkUpdateMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setHomeworkManyIsNew(TEST_GUID, ['hw-1', 'hw-2'], false);

      // Without userId, no DB write — returns count of provided ids
      expect(homeworkUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 2 });
    });

    it('returns updated=0 and skips DB update when ids are empty', async () => {
      const homeworkUpdateMany = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({ homeworkUpdateMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setHomeworkManyIsNew(TEST_GUID, [], false);

      expect(homeworkUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 0 });
    });

    it('throws NotFoundException when student is missing', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          studentFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(
        service.setHomeworkManyIsNew('missing-guid', ['hw-1'], false),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('setHomeworkArchived', () => {
    it('sets isArchived=true and forces isNew=false when archiving (no userId)', async () => {
      const homeworkUpdate = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(makeHomeworkRow()),
          homeworkUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setHomeworkArchived(TEST_GUID, 'hw-1', true);
      // No userId → no DB write, returns item with derived state
      expect(homeworkUpdate).not.toHaveBeenCalled();
      expect(result.isArchived).toBe(true);
      expect(result.isNew).toBe(false);
    });

    it('sets isArchived=false and restores isNew=true when unarchiving (no userId)', async () => {
      const homeworkUpdate = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(makeHomeworkRow()),
          homeworkUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setHomeworkArchived(TEST_GUID, 'hw-1', false);
      expect(homeworkUpdate).not.toHaveBeenCalled();
      expect(result.isArchived).toBe(false);
      expect(result.isNew).toBe(true);
    });

    it('throws NotFoundException when homework belongs to another student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(
            makeHomeworkRow({ studentGuid: 'other-guid' }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.setHomeworkArchived(TEST_GUID, 'hw-1', true)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setHomeworkManyArchived', () => {
    it('returns updated count equal to ids length when no userId (no DB write)', async () => {
      const homeworkUpdateMany = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({ homeworkUpdateMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setHomeworkManyArchived(TEST_GUID, ['hw-1', 'hw-2', 'hw-3'], true);

      expect(homeworkUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 3 });
    });

    it('returns updated count when bulk unarchiving without userId', async () => {
      const homeworkUpdateMany = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({ homeworkUpdateMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setHomeworkManyArchived(TEST_GUID, ['hw-1'], false);
      expect(homeworkUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 1 });
    });
  });

  describe('getBehavior', () => {
    it('maps classification to bucket and eventCode to priority with default isNew/isArchived when no userId', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([makeBehaviorRow()]);
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindMany: mockFindMany,
          behaviorCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getBehavior(TEST_GUID, 1, 50, 'attention', 'new');
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            studentGuid: TEST_GUID,
            classification: 'attention',
          }),
        }),
      );
      expect(result.data[0].bucket).toBe('attention');
      expect(result.data[0].priority).toBe('high');
      // defaults: isNew=true, isArchived=false
      expect(result.data[0].isNew).toBe(true);
      expect(result.data[0].isArchived).toBe(false);
    });

    it('does not include isHandled field on behavior items', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindMany: jest.fn().mockResolvedValue([makeBehaviorRow()]),
          behaviorCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getBehavior(TEST_GUID, 1, 50, 'all');
      expect(result.data[0]).not.toHaveProperty('isHandled');
    });

    it('status=all does not filter out non-archived behavior items', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([makeBehaviorRow()]);
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindMany: mockFindMany,
          behaviorCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getBehavior(TEST_GUID, 1, 50, 'attention', 'all');
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            studentGuid: TEST_GUID,
            classification: 'attention',
          }),
        }),
      );
      expect(result.data).toHaveLength(1);
    });
  });

  describe('getBehaviorDetail', () => {
    it('returns a single behavior detail item with default isNew/isArchived when no userId', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(makeBehaviorRow()),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getBehaviorDetail(TEST_GUID, 'beh-1');
      expect(result).toMatchObject({
        id: 'beh-1',
        studentGuid: TEST_GUID,
        bucket: 'attention',
        priority: 'high',
        isNew: true,
        isArchived: false,
      });
      expect(result.lessonDate).toBe('2026-03-11T00:00:00.000Z');
    });

    it('does not include isHandled field on behavior detail', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(makeBehaviorRow()),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getBehaviorDetail(TEST_GUID, 'beh-1');
      expect(result).not.toHaveProperty('isHandled');
    });

    it('throws NotFoundException when behavior item is missing', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.getBehaviorDetail(TEST_GUID, 'missing-beh')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when behavior item belongs to another student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(
            makeBehaviorRow({ studentGuid: 'other-student-guid' }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.getBehaviorDetail(TEST_GUID, 'beh-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setBehaviorIsNew', () => {
    it('returns item with new isNew value when no userId (no DB write)', async () => {
      const behaviorUpdate = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(makeBehaviorRow()),
          behaviorUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setBehaviorIsNew(TEST_GUID, 'beh-1', false);
      expect(behaviorUpdate).not.toHaveBeenCalled();
      expect(result.isNew).toBe(false);
    });

    it('throws NotFoundException when behavior belongs to another student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(
            makeBehaviorRow({ studentGuid: 'other-guid' }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.setBehaviorIsNew(TEST_GUID, 'beh-1', false)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('with userId: does not update isNew when behavior item is archived', async () => {
      const mockGetState = jest.fn().mockResolvedValue({ isNew: false, isArchived: true });
      const mockSetState = jest.fn();
      const mockUserItemState = {
        getState: mockGetState,
        getStateBatch: jest.fn().mockResolvedValue(new Map()),
        setState: mockSetState,
        setStateBatch: jest.fn().mockResolvedValue(0),
      } as unknown as jest.Mocked<UserItemStateService>;
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(makeBehaviorRow()),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        mockUserItemState,
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setBehaviorIsNew(TEST_GUID, 'beh-1', true, 'user-1');
      expect(mockSetState).not.toHaveBeenCalled();
      expect(result.isArchived).toBe(true);
      expect(result.isNew).toBe(false);
    });
  });

  describe('setBehaviorManyIsNew', () => {
    it('returns updated count equal to ids length when no userId (no DB write)', async () => {
      const behaviorUpdateMany = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({ behaviorUpdateMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setBehaviorManyIsNew(TEST_GUID, ['beh-1', 'beh-2'], false);

      expect(behaviorUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 2 });
    });

    it('returns updated=0 and skips DB update when ids are empty', async () => {
      const behaviorUpdateMany = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({ behaviorUpdateMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setBehaviorManyIsNew(TEST_GUID, [], true);

      expect(behaviorUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 0 });
    });
  });

  describe('setBehaviorArchived', () => {
    it('sets isArchived=true and forces isNew=false when archiving (no userId)', async () => {
      const behaviorUpdate = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(makeBehaviorRow()),
          behaviorUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setBehaviorArchived(TEST_GUID, 'beh-1', true);
      expect(behaviorUpdate).not.toHaveBeenCalled();
      expect(result.isArchived).toBe(true);
      expect(result.isNew).toBe(false);
    });

    it('sets isArchived=false and restores isNew=true when unarchiving (no userId)', async () => {
      const behaviorUpdate = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(makeBehaviorRow()),
          behaviorUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setBehaviorArchived(TEST_GUID, 'beh-1', false);
      expect(behaviorUpdate).not.toHaveBeenCalled();
      expect(result.isArchived).toBe(false);
      expect(result.isNew).toBe(true);
    });

    it('throws NotFoundException when behavior belongs to another student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(
            makeBehaviorRow({ studentGuid: 'other-guid' }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.setBehaviorArchived(TEST_GUID, 'beh-1', true)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setBehaviorManyArchived', () => {
    it('returns updated count equal to ids length when no userId (no DB write)', async () => {
      const behaviorUpdateMany = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({ behaviorUpdateMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setBehaviorManyArchived(TEST_GUID, ['beh-1', 'beh-2'], true);

      expect(behaviorUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 2 });
    });

    it('returns updated count when bulk unarchiving without userId', async () => {
      const behaviorUpdateMany = jest.fn();
      const service = new ChildrenService(
        makeMockPrisma({ behaviorUpdateMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.setBehaviorManyArchived(TEST_GUID, ['beh-1'], false);
      expect(behaviorUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 1 });
    });
  });

  describe('getSubjects / getNotices', () => {
    it('returns {data} envelope for subjects and notices', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          subjectFindMany: jest.fn().mockResolvedValue([
            {
              id: 'sub-1',
              studentGuid: TEST_GUID,
              groupId: 10,
              groupName: 'Math Group',
              subjectName: 'Math',
              teachers: [],
              inactiveTeachers: [],
              weeklyHours: 4,
              lessonsCount: 20,
              updatedAt: new Date('2026-03-12T00:00:00Z'),
            },
          ]),
          noticeFindMany: jest.fn().mockResolvedValue([
            {
              id: 'notice-1',
              studentGuid: TEST_GUID,
              eventId: 99,
              eventText: '<p>Hello</p>',
              expirationDate: new Date('2026-03-20T00:00:00Z'),
              inSite: true,
              updatedAt: new Date('2026-03-12T00:00:00Z'),
            },
          ]),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const subjects = await service.getSubjects(TEST_GUID);
      const notices = await service.getNotices(TEST_GUID);

      expect(Array.isArray(subjects.data)).toBe(true);
      expect(Array.isArray(notices.data)).toBe(true);
      expect(subjects.data[0].updatedAt).toBe('2026-03-12T00:00:00.000Z');
      expect(notices.data[0].expirationDate).toBe('2026-03-20T00:00:00.000Z');
    });
  });

  describe('getTimetable', () => {
    it('returns ordered entries in {data} envelope with JSON teachers mapped to arrays', async () => {
      const timetableFindMany = jest.fn().mockResolvedValue([
        {
          id: 'tt-1',
          studentGuid: TEST_GUID,
          groupId: 20,
          day: 1,
          lesson: 2,
          roomNum: '104',
          weeks: 1,
          groupName: 'Science 1',
          subjectName: 'Science',
          teachers: [{ teacherGuid: 't-1', teacherName: 'Dana Levi' }],
          updatedAt: new Date('2026-03-15T00:00:00Z'),
        },
      ]);
      const service = new ChildrenService(
        makeMockPrisma({
          timetableFindMany,
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getTimetable(TEST_GUID);
      expect(timetableFindMany).toHaveBeenCalledWith({
        where: { studentGuid: TEST_GUID, schoolYear: { in: [2027, 0] } },
        orderBy: [{ day: 'asc' }, { lesson: 'asc' }],
      });
      expect(result.data).toEqual([
        {
          id: 'tt-1',
          studentGuid: TEST_GUID,
          groupId: 20,
          day: 1,
          lesson: 2,
          roomNum: '104',
          weeks: 1,
          groupName: 'Science 1',
          subjectName: 'Science',
          teachers: [{ teacherGuid: 't-1', teacherName: 'Dana Levi' }],
          updatedAt: '2026-03-15T00:00:00.000Z',
        },
      ]);
    });

    it("reports source 'school' and the stored periods when the school served them", async () => {
      const bellScheduleFindMany = jest.fn().mockResolvedValue([
        { lesson: 1, startTime: '08:15', endTime: '09:00' },
        { lesson: 2, startTime: '09:15', endTime: '10:00' },
      ]);
      const service = new ChildrenService(
        makeMockPrisma({
          bellScheduleFindMany,
          connectionFindUnique: jest
            .fn()
            .mockResolvedValue({ id: 'conn-1', schoolCode: 540175, schoolYear: 2027 }),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getTimetable(TEST_GUID);

      expect(bellScheduleFindMany).toHaveBeenCalledWith({
        where: { schoolCode: 540175, schoolYear: 2027 },
        orderBy: { lesson: 'asc' },
      });
      expect(result.schedule.source).toBe('school');
      expect(result.schedule.periods).toEqual([
        { lesson: 1, startTime: '08:15', endTime: '09:00' },
        { lesson: 2, startTime: '09:15', endTime: '10:00' },
      ]);
      // Derived from the gap, never fetched: the upstream serves no break rows.
      expect(result.schedule.breaks).toEqual([
        { afterLesson: 1, startTime: '09:00', endTime: '09:15', minutes: 15, kind: 'recess' },
      ]);
    });

    it("reports source 'default' when the school served no bell times", async () => {
      // The expected state, not a fault: `GET /api/bells` is unverified and
      // may not exist for a school at all (ADR-0037). The times still render,
      // and `source` is what lets the UI caveat them.
      const service = new ChildrenService(
        makeMockPrisma({
          connectionFindUnique: jest
            .fn()
            .mockResolvedValue({ id: 'conn-1', schoolCode: 540175, schoolYear: 2027 }),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getTimetable(TEST_GUID);

      expect(result.schedule.source).toBe('default');
      expect(result.schedule.periods).toHaveLength(8);
      expect(result.schedule.periods[0]).toEqual({
        lesson: 1,
        startTime: '08:00',
        endTime: '08:45',
      });
      expect(result.schedule.breaks.filter((item) => item.kind === 'lunch')).toHaveLength(1);
    });

    it('throws NotFoundException for unknown student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          studentFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.getTimetable(TEST_GUID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getLessonHistory', () => {
    it('returns upstream array in {data} envelope', async () => {
      const get = jest.fn().mockResolvedValue([
        {
          groupName: 'שפה ג3',
          subjectName: 'שפה',
          lessonLog: {
            lessonID: 537,
            groupId: 181,
            lessonDate: '2025-09-12T00:00:00',
            lesson: 1,
            tookPlace: true,
            remark: 'טקסט קריאה',
            homeWork: 'לקרוא 3 פעמים',
            lessontype: 0,
            reporterid: 0,
            reporterGuid: 'a7246be3-18b8-45dd-874c-fa426d022348',
          },
        },
      ]);
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession(),
        makeMockMashovClient({ get }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getLessonHistory(TEST_GUID);
      expect(get).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/lessons/history`, SCOPE_TARGET,
        {
          headers: {
            Referer: `https://web.mashov.info/students/main/students/${TEST_GUID}/weeklyPlan`,
          },
        });
      expect(result).toEqual({
        data: [
          {
            groupName: 'שפה ג3',
            subjectName: 'שפה',
            lessonLog: {
              lessonID: 537,
              groupId: 181,
              lessonDate: '2025-09-12T00:00:00',
              lesson: 1,
              tookPlace: true,
              remark: 'טקסט קריאה',
              homeWork: 'לקרוא 3 פעמים',
              lessontype: 0,
              reporterid: 0,
              reporterGuid: 'a7246be3-18b8-45dd-874c-fa426d022348',
            },
          },
        ],
      });
    });

    it('returns {data: []} when upstream throws', async () => {
      const get = jest.fn().mockRejectedValue(new Error('upstream failed'));
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession(),
        makeMockMashovClient({ get }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getLessonHistory(TEST_GUID);
      expect(result).toEqual({ data: [] });
    });

    it('returns {data: []} when upstream payload is not an array', async () => {
      const get = jest.fn().mockResolvedValue({ lessonLog: {} });
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession(),
        makeMockMashovClient({ get }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getLessonHistory(TEST_GUID);
      expect(result).toEqual({ data: [] });
    });
  });

  describe('student releases', () => {
    it('getStudentReleases proxies upstream with releases referer', async () => {
      const get = jest.fn().mockResolvedValue([
        {
          id: 64,
          studentGuid: TEST_GUID,
          contactGuid: 'contact-guid-1',
          releaseDate: '2026-01-23T00:00:00',
          startHour: '11:30:00',
          remark: 'doctor',
          status: 1,
          isDeleted: false,
          requestEditTime: '2026-01-22T18:28:33',
        },
      ]);
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession(),
        makeMockMashovClient({ get }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getStudentReleases(TEST_GUID);
      expect(get).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/studentReleases`, SCOPE_TARGET,
        {
          headers: {
            Referer: 'https://web.mashov.info/students/main/studentsReleaseRequests',
          },
        });
      expect(result).toEqual([
        {
          id: 64,
          studentGuid: TEST_GUID,
          contactGuid: 'contact-guid-1',
          releaseDate: '2026-01-23T00:00:00',
          startHour: '11:30:00',
          remark: 'doctor',
          status: 1,
          isDeleted: false,
          requestEditTime: '2026-01-22T18:28:33',
        },
      ]);
    });

    it('createStudentRelease proxies upstream body and request path', async () => {
      const put = jest.fn().mockResolvedValue(undefined);
      const body = {
        releaseDate: '2026-03-20T02:00:00',
        remark: 'aaa',
        studentGuid: TEST_GUID,
        startHour: '09:00:00',
      };
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession(),
        makeMockMashovClient({ put }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await service.createStudentRelease(TEST_GUID, body);
      expect(put).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/studentRelease/request`,
        body, SCOPE_TARGET,
        {
          headers: {
            Referer: 'https://web.mashov.info/students/main/studentsReleaseRequests',
          },
        });
    });

    it('updateStudentRelease proxies upstream body and path', async () => {
      const put = jest.fn().mockResolvedValue(undefined);
      const body = {
        id: 84,
        studentGuid: TEST_GUID,
        contactGuid: 'contact-guid-1',
        releaseDate: '2026-03-20T00:00:00',
        startHour: '09:00:00',
        remark: 'updated',
        status: 1,
        isDeleted: false,
        requestEditTime: '2026-03-19T21:44:35',
        releaseDateMoment: '2026-03-20T09:00:00',
        isExpired: false,
        isDirty_menu: true,
      };
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession(),
        makeMockMashovClient({ put }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await service.updateStudentRelease(TEST_GUID, 84, body);
      expect(put).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/studentRelease/84/request`,
        body,
        SCOPE_TARGET,
      );
    });

    it('deleteStudentRelease proxies upstream delete path', async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession(),
        makeMockMashovClient({ delete: remove }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await service.deleteStudentRelease(TEST_GUID, 84);
      expect(remove).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/studentRelease/84`,
        SCOPE_TARGET,
      );
    });
  });

  describe('school activities', () => {
    it('getSchoolActivities proxies upstream with school activities referer', async () => {
      const get = jest.fn().mockResolvedValue([
        {
          id: 1,
          title: 'טיול כיתה',
          isAnswered: false,
          activityType: 1,
        },
      ]);
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession(),
        makeMockMashovClient({ get }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getSchoolActivities(TEST_GUID);
      expect(get).toHaveBeenCalledWith('/api/schoolActivities/permitted', SCOPE_TARGET, {
        headers: {
          Referer: 'https://web.mashov.info/students/main/schoolActivities',
        },
      });
      expect(result).toEqual([
        {
          id: 1,
          title: 'טיול כיתה',
          isAnswered: false,
          activityType: 1,
        },
      ]);
    });
  });

  describe('latestUpdateAt', () => {
    it('omits latestUpdateAt when there is no content, ignoring student.updatedAt', async () => {
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getChildren('user-1');

      expect(result.data[0].latestUpdateAt).toBeNull();
    });

    it('reports the newest content date, not the sign-in timestamp', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindFirst: jest
            .fn()
            .mockResolvedValue({ lessonDate: new Date('2026-11-14T00:00:00Z') }),
          behaviorFindFirst: jest
            .fn()
            .mockResolvedValue({ eventAt: new Date('2026-11-10T00:00:00Z') }),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getChildren('user-1');

      expect(result.data[0].latestUpdateAt).toBe('2026-11-14T00:00:00.000Z');
    });
  });

  describe('school year scoping', () => {
    it("excludes last year's homework from the recent count", async () => {
      const homeworkFindMany = jest.fn().mockResolvedValue([]);
      const service = new ChildrenService(
        makeMockPrisma({ homeworkFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await service.getChildren('user-1');

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining(crossChildYearWhere(2027)),
        }),
      );
    });

    it("excludes last year's behaviour from the recent count", async () => {
      const behaviorFindMany = jest.fn().mockResolvedValue([]);
      const service = new ChildrenService(
        makeMockPrisma({ behaviorFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await service.getChildren('user-1');

      expect(behaviorFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining(crossChildYearWhere(2027)),
        }),
      );
    });

    it("excludes last year's subjects from subjectCount", async () => {
      const subjectCount = jest.fn().mockResolvedValue(0);
      const service = new ChildrenService(
        makeMockPrisma({ subjectCount }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await service.getChildren('user-1');

      expect(subjectCount).toHaveBeenCalledWith({
        where: expect.objectContaining(crossChildYearWhere(2027)),
      });
    });

    // -----------------------------------------------------------------------
    // Per-tab year scope (ADR-0036).
    //
    // `לא נקרא` and `הכל` are the default view, so they hold the current year
    // alone; `ארכיון` keeps the whole `MASHOV_YEAR` window, which makes it the
    // one place last year is still reachable. These assertions are the inverse
    // of the ones ADR-0025 added, deliberately.
    // -----------------------------------------------------------------------

    it('keeps the unread homework tab on the current year', async () => {
      const homeworkFindMany = jest.fn().mockResolvedValue([]);
      const service = new ChildrenService(
        makeMockPrisma({ homeworkFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2026'),
        makeMockScope(),
      );

      await service.getHomework(TEST_GUID, 1, 20, 'new', 'user-1');

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ schoolYear: { in: [2027, 0] } }),
        }),
      );
    });

    it('keeps the "all" homework tab on the current year', async () => {
      const homeworkFindMany = jest.fn().mockResolvedValue([]);
      const service = new ChildrenService(
        makeMockPrisma({ homeworkFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2026'),
        makeMockScope(),
      );

      await service.getHomework(TEST_GUID, 1, 20, 'all', 'user-1');

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ schoolYear: { in: [2027, 0] } }),
        }),
      );
    });

    it('spans the history window on the homework archive tab', async () => {
      const homeworkFindMany = jest.fn().mockResolvedValue([]);
      const service = new ChildrenService(
        makeMockPrisma({ homeworkFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2026'),
        makeMockScope(),
      );

      await service.getHomework(TEST_GUID, 1, 20, 'archived', 'user-1');

      expect(homeworkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining(windowWhere(2026, 2027)),
        }),
      );
    });

    it('archives a prior-year homework row that has no state row at all', async () => {
      // No `user_item_state` row means "never opened", which used to read as
      // unread. A year the student has left is history, so the derivation
      // outranks the absent row -- with no backfill and nothing written at
      // rollover.
      const homeworkFindMany = jest.fn().mockResolvedValue([
        makeHomeworkRow({ id: 'hw-last-year', schoolYear: 2026 }),
      ]);
      const service = new ChildrenService(
        makeMockPrisma({ homeworkFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2026'),
        makeMockScope(),
      );

      const archived = await service.getHomework(TEST_GUID, 1, 20, 'archived', 'user-1');
      expect(archived.pagination.total).toBe(1);
      expect(archived.data[0]).toMatchObject({
        id: 'hw-last-year',
        isArchived: true,
        isNew: false,
        isPastYear: true,
      });

      const unread = await service.getHomework(TEST_GUID, 1, 20, 'new', 'user-1');
      expect(unread.pagination.total).toBe(0);

      const all = await service.getHomework(TEST_GUID, 1, 20, 'all', 'user-1');
      expect(all.pagination.total).toBe(0);
    });

    it('does not treat a pre-migration homework row as a past year', async () => {
      // `schoolYear = 0` is "unknown", and `currentYearScope` admits it. Read
      // as last year it would archive every row in a half-migrated database.
      const homeworkFindMany = jest.fn().mockResolvedValue([
        makeHomeworkRow({ id: 'hw-legacy', schoolYear: 0 }),
      ]);
      const service = new ChildrenService(
        makeMockPrisma({ homeworkFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2026'),
        makeMockScope(),
      );

      const unread = await service.getHomework(TEST_GUID, 1, 20, 'new', 'user-1');
      expect(unread.pagination.total).toBe(1);
      expect(unread.data[0]).toMatchObject({ isPastYear: false, isArchived: false });
    });

    it('matches the header chip: the unread total equals unreadHomeworkCount', async () => {
      // The invariant this whole change exists to buy. One prior-year row and
      // two current-year ones: the chip counts the current year, so the `לא
      // נקרא` total has to as well.
      const rows = [
        makeHomeworkRow({ id: 'hw-a', schoolYear: 2027 }),
        makeHomeworkRow({ id: 'hw-b', schoolYear: 2027 }),
        makeHomeworkRow({ id: 'hw-old', schoolYear: 2026 }),
      ];
      // The chip's read is current-year-scoped in SQL, so the prior-year row
      // never reaches it; the list's `new` tab is scoped the same way.
      const homeworkFindMany = jest.fn((args?: { where?: { schoolYear?: { in?: number[] } } }) => {
        const years = args?.where?.schoolYear?.in;
        return Promise.resolve(
          years ? rows.filter((row) => years.includes(row.schoolYear)) : rows,
        );
      });
      const service = new ChildrenService(
        makeMockPrisma({ homeworkFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2026'),
        makeMockScope(),
      );

      const list = await service.getHomework(TEST_GUID, 1, 20, 'new', 'user-1');
      const workspace = await service.getChildWorkspace(TEST_GUID, 'user-1');

      expect(list.pagination.total).toBe(2);
      expect(workspace.summary.recentHomeworkCount).toBe(list.pagination.total);
    });

    it('keeps the unread behaviour tab on the current year', async () => {
      const behaviorFindMany = jest.fn().mockResolvedValue([]);
      const service = new ChildrenService(
        makeMockPrisma({ behaviorFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2026'),
        makeMockScope(),
      );

      await service.getBehavior(TEST_GUID, 1, 20, 'all', 'new', 'user-1');

      expect(behaviorFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ schoolYear: { in: [2027, 0] } }),
        }),
      );
    });

    it('spans the history window on the behaviour archive tab', async () => {
      const behaviorFindMany = jest.fn().mockResolvedValue([]);
      const service = new ChildrenService(
        makeMockPrisma({ behaviorFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2026'),
        makeMockScope(),
      );

      await service.getBehavior(TEST_GUID, 1, 20, 'all', 'archived', 'user-1');

      expect(behaviorFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining(windowWhere(2026, 2027)),
        }),
      );
    });

    it('archives a prior-year behaviour row that has no state row at all', async () => {
      const behaviorFindMany = jest.fn().mockResolvedValue([
        makeBehaviorRow({ id: 'beh-last-year', schoolYear: 2026 }),
      ]);
      const service = new ChildrenService(
        makeMockPrisma({ behaviorFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2026'),
        makeMockScope(),
      );

      const archived = await service.getBehavior(TEST_GUID, 1, 20, 'all', 'archived', 'user-1');
      expect(archived.data[0]).toMatchObject({
        id: 'beh-last-year',
        isArchived: true,
        isNew: false,
        isPastYear: true,
      });

      const unread = await service.getBehavior(TEST_GUID, 1, 20, 'all', 'new', 'user-1');
      expect(unread.pagination.total).toBe(0);
    });

    it('keeps the timetable on the current year alone even with the window open', async () => {
      // One row per (studentGuid, schoolYear, day, lesson). A range would
      // return two subjects for the same slot, and the payload carries no year
      // to tell them apart.
      const timetableFindMany = jest.fn().mockResolvedValue([]);
      const service = new ChildrenService(
        makeMockPrisma({ timetableFindMany }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2025'),
        makeMockScope(),
      );

      await service.getTimetable(TEST_GUID, 'user-1');

      expect(timetableFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ schoolYear: { in: [2027, 0] } }),
        }),
      );
    });

    it('does not double-count a recurring groupId in subjectCount', async () => {
      // groupId recurs yearly, so a range doubles the subject list and count.
      const subjectCount = jest.fn().mockResolvedValue(0);
      const service = new ChildrenService(
        makeMockPrisma({ subjectCount }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2025'),
        makeMockScope(),
      );

      await service.getChildren('user-1');

      expect(subjectCount).toHaveBeenCalledWith({
        where: expect.objectContaining(crossChildYearWhere(2027)),
      });
    });

    it('sums weekly hours for the current year alone', async () => {
      const subjectAggregate = jest
        .fn()
        .mockResolvedValue({ _sum: { weeklyHours: 30 } });
      const service = new ChildrenService(
        makeMockPrisma({ subjectAggregate }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2025'),
        makeMockScope(),
      );

      await service.getChildWorkspace(TEST_GUID, 'user-1');

      expect(subjectAggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ schoolYear: { in: [2027, 0] } }),
        }),
      );
    });

    it('keeps latestUpdateAt on the current year alone even with the window open', async () => {
      // A range here would let last June's homework report as this year's
      // latest update — the blindness that hid the frozen year for months.
      const homeworkFindFirst = jest.fn().mockResolvedValue(null);
      const behaviorFindFirst = jest.fn().mockResolvedValue(null);
      const service = new ChildrenService(
        makeMockPrisma({ homeworkFindFirst, behaviorFindFirst }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig('2025'),
        makeMockScope(),
      );

      const result = await service.getChildren('user-1');

      for (const mock of [homeworkFindFirst, behaviorFindFirst]) {
        expect(mock).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining(crossChildYearWhere(2027)),
          }),
        );
      }
      expect(result.data[0].latestUpdateAt).toBeNull();
    });

    it('falls back to the calendar year when there is no connection', async () => {
      const subjectFindMany = jest.fn().mockResolvedValue([]);
      const service = new ChildrenService(
        makeMockPrisma({
          subjectFindMany,
          connectionFindFirst: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await service.getSubjects(TEST_GUID);

      const { where } = subjectFindMany.mock.calls[0][0];
      expect(where.schoolYear.in[0]).toBe(calendarSchoolYear(new Date()));
    });
  });

  describe('student fallback + attachment downloads', () => {
    it('retries student lookup after ensureStudentsAvailable when student is initially missing', async () => {
      const studentFindUnique = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeStudent());
      const ensureStudentsAvailable = jest.fn().mockResolvedValue(undefined);
      const service = new ChildrenService(
        makeMockPrisma({
          studentFindUnique,
        }),
        makeMockSession({ ensureStudentsAvailable }),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.getChildWorkspace(TEST_GUID);
      expect(result.student.studentGuid).toBe(TEST_GUID);
      expect(ensureStudentsAvailable).toHaveBeenCalledTimes(1);
      expect(studentFindUnique).toHaveBeenCalledTimes(2);
    });

    it('returns the NOT_FOUND envelope when the student is still missing', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          studentFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.getSubjects(TEST_GUID)).rejects.toMatchObject({
        response: {
          error: {
            code: 'NOT_FOUND',
            message: expect.stringContaining(TEST_GUID),
            details: [],
          },
        },
      });
    });

    it("passes the caller's userId to the roster self-heal", async () => {
      const ensureStudentsAvailable = jest.fn().mockResolvedValue(undefined);
      const service = new ChildrenService(
        makeMockPrisma({
          studentFindUnique: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(makeStudent()),
        }),
        makeMockSession({ ensureStudentsAvailable }),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await service.getChildWorkspace(TEST_GUID, 'user-9');

      expect(ensureStudentsAvailable).toHaveBeenCalledWith('user-9');
    });

    it("passes the caller's userId to the roster self-heal on the children list", async () => {
      const ensureStudentsAvailable = jest.fn().mockResolvedValue(undefined);
      const service = new ChildrenService(
        makeMockPrisma({}),
        makeMockSession({ ensureStudentsAvailable }),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await service.getChildren('user-9');

      expect(ensureStudentsAvailable).toHaveBeenCalledWith('user-9');
    });

    it('throws NotFoundException after fallback student lookup still fails', async () => {
      const ensureStudentsAvailable = jest.fn().mockResolvedValue(undefined);
      const service = new ChildrenService(
        makeMockPrisma({
          studentFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession({ ensureStudentsAvailable }),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(service.getSubjects(TEST_GUID)).rejects.toThrow(NotFoundException);
      expect(ensureStudentsAvailable).toHaveBeenCalledTimes(1);
    });

    it('downloads homework attachment via candidate fallback and decodes file name', async () => {
      const getResponse = jest.fn().mockImplementation(async (path: string) => {
        if (path === `/api/students/${TEST_GUID}/files/hw-file-1/homework%20file.pdf`) {
          return {
            data: new Uint8Array([1, 2, 3]).buffer,
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': "attachment; filename*=UTF-8''homework%20file.pdf",
            },
          };
        }

        throw new Error('not found');
      });
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(
            makeHomeworkRow({
              files: [{ fileId: 'hw-file-1', fileName: 'homework file.pdf' }],
            }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient({ getResponse }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.downloadHomeworkAttachment(TEST_GUID, 'hw-1', 'hw-file-1');
      expect(getResponse).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/studyFiles/hw-file-1/homework%20file.pdf`, SCOPE_TARGET,
        expect.any(Object));
      expect(getResponse).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/files/hw-file-1/homework%20file.pdf`, SCOPE_TARGET,
        expect.any(Object));
      expect(result.contentType).toBe('application/pdf');
      expect(result.fileName).toBe('homework file.pdf');
      expect(result.buffer.equals(Buffer.from([1, 2, 3]))).toBe(true);
    });

    it('throws NotFoundException when homework attachment id is missing from payload', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(
            makeHomeworkRow({
              files: [{ fileId: 'hw-file-x', fileName: 'other.pdf' }],
            }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(
        service.downloadHomeworkAttachment(TEST_GUID, 'hw-1', 'hw-file-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('downloads behavior attachment via lesson endpoint fallback with string lessonId metadata', async () => {
      const getResponse = jest.fn().mockImplementation(async (path: string) => {
        if (path === '/api/lessons/7/files/beh-file-1/behavior.pdf') {
          return {
            data: new Uint8Array([7, 8]).buffer,
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="behavior.pdf"',
            },
          };
        }

        throw new Error('not found');
      });
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(
            makeBehaviorRow({
              lessonId: 9,
              rawPayload: {
                attachments: [
                  {
                    id: 'beh-file-1',
                    name: 'behavior.pdf',
                    url: 'files/beh-file-1',
                    lessonId: '7',
                  },
                ],
              },
            }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient({ getResponse }),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      const result = await service.downloadBehaviorAttachment(TEST_GUID, 'beh-1', 'beh-file-1');
      expect(getResponse).toHaveBeenCalledWith(
        '/api/lessons/7/files/beh-file-1/behavior.pdf', SCOPE_TARGET,
        expect.any(Object));
      expect(result.fileName).toBe('behavior.pdf');
      expect(result.buffer.equals(Buffer.from([7, 8]))).toBe(true);
    });

    it('throws NotFoundException when behavior attachment is missing', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(
            makeBehaviorRow({
              rawPayload: {
                files: [{ fileId: 'different-file', fileName: 'other.pdf' }],
              },
            }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
        makeMockConfig(),
        makeMockScope(),
      );

      await expect(
        service.downloadBehaviorAttachment(TEST_GUID, 'beh-1', 'beh-file-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

describe('ChildrenService household isolation', () => {
  /**
   * The claim `docs/prd/PRD-current.md` has made since Phase 2 -- "a secure,
   * multi-tenant system where multiple parents ... view only their own
   * children's data" -- was not true. `Student` had no owner column, so
   * `getChildren()` returned every active student row in the database and
   * `getStudentOrThrow` only checked that the row existed. Any signed-in
   * parent could list, and read, every child in the system.
   */
  interface OwnedStudent {
    id: string;
    studentGuid: string;
    privateName: string;
    familyName: string;
    fullName: string;
    classCode: string;
    classNum: number;
    gender: string;
    isActive: boolean;
    householdConnectionId: string | null;
    /**
     * The connections that LIST this child -- visibility, which has to be a
     * set (ADR-0031). `householdConnectionId` beside it is routing only.
     */
    links: string[];
    updatedAt: Date;
  }

  const MINE: OwnedStudent = {
    id: 'row-mine',
    studentGuid: 'guid-mine',
    privateName: 'Mika',
    familyName: 'Kors',
    fullName: 'Mika Kors',
    classCode: 'ז',
    classNum: 3,
    gender: 'F',
    isActive: true,
    householdConnectionId: 'conn-mine',
    links: ['conn-mine'],
    updatedAt: new Date('2026-11-01T00:00:00Z'),
  };
  const THEIRS = {
    ...MINE,
    id: 'row-theirs',
    studentGuid: 'guid-theirs',
    fullName: 'Someone Else',
    householdConnectionId: 'conn-theirs',
    links: ['conn-theirs'],
  };
  const UNSTAMPED = {
    ...MINE,
    id: 'row-unstamped',
    studentGuid: 'guid-unstamped',
    fullName: 'Not Yet Attributed',
    householdConnectionId: null,
    links: [],
  };
  /**
   * The child both parents list, and the whole reason for ADR-0031.
   *
   * Two parents, their own Mashov accounts at one school, the same children --
   * the shape ADR-0016 requires and PRD open question 2 describes. The routing
   * stamp names the OTHER parent's connection here on purpose: that is exactly
   * the state the second parent's sync leaves behind, and under the old
   * stamp-as-visibility rule it emptied the first parent's `/children`.
   */
  const SHARED = {
    ...MINE,
    id: 'row-shared',
    studentGuid: 'guid-shared',
    fullName: 'Shared Child',
    householdConnectionId: 'conn-theirs',
    links: ['conn-mine', 'conn-theirs'],
  };

  /**
   * The connection rows behind the school fields, for both parents.
   *
   * One school, two parents, their own `displayLabel` each -- so a response
   * carrying the other parent's label is visible rather than indistinguishable.
   */
  const CONNECTION_ROWS: Record<
    string,
    { id: string; schoolCode: number; schoolName: string; displayLabel: string | null }
  > = {
    'conn-mine': {
      id: 'conn-mine',
      schoolCode: 111,
      schoolName: 'בית ספר אחד',
      displayLabel: 'שלי',
    },
    'conn-theirs': {
      id: 'conn-theirs',
      schoolCode: 111,
      schoolName: 'בית ספר אחד',
      displayLabel: 'שלהם',
    },
  };

  /** Prisma that honours ownership on both the list and the single read. */
  function makePrisma(students: OwnedStudent[], myConnections: string[]) {
    // Interprets the real predicate shape: an OR of "some link names one of my
    // connections" and "no links at all".
    const matchesHousehold = (student: OwnedStudent, where: Record<string, unknown>) => {
      const or = where.OR as Array<Record<string, unknown>> | undefined;
      if (!or) return true;
      return or.some((clause) => {
        const links = clause.links as
          | { some?: { householdConnectionId?: { in?: string[] } }; none?: object }
          | undefined;
        if (links?.none) return student.links.length === 0;
        const wanted = links?.some?.householdConnectionId?.in;
        if (wanted) return student.links.some((id) => wanted.includes(id));
        return false;
      });
    };

    return {
      studentConnection: {
        // Two shapes: one guid for the per-child guard, and `{ in: [...] }`
        // for `linksForStudents`, which answers a whole list in one query.
        findMany: jest.fn(({ where }) => {
          const guids = (where.studentGuid as { in?: string[] } | string | undefined);
          const wanted =
            typeof guids === 'string'
              ? [guids]
              : guids?.in ?? students.map((student) => student.studentGuid);
          return Promise.resolve(
            students
              .filter((student) => wanted.includes(student.studentGuid))
              .flatMap((student) =>
                student.links.map((id) => ({
                  studentGuid: student.studentGuid,
                  householdConnectionId: id,
                })),
              ),
          );
        }),
      },
      student: {
        findMany: jest.fn(({ where } = {}) =>
          Promise.resolve(students.filter((student) => matchesHousehold(student, where ?? {}))),
        ),
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(
            students.find((student) => student.studentGuid === where.studentGuid) ?? null,
          ),
        ),
      },
      householdConnection: {
        findFirst: jest.fn(({ where }) =>
          Promise.resolve(
            where?.id && where?.userId
              ? myConnections.includes(where.id as string)
                ? { id: where.id }
                : null
              : { schoolYear: 2027 },
          ),
        ),
        // Two callers: `activeConnectionIdsFor`, which asks for one user's
        // active connections, and the school map's detail read, which asks for
        // rows by id and needs the labelling columns.
        findMany: jest.fn((args?: { where?: Record<string, unknown> }) => {
          const ids = (args?.where?.id as { in?: string[] } | undefined)?.in;
          if (ids) {
            return Promise.resolve(
              ids
                .map((id) => CONNECTION_ROWS[id])
                .filter((row): row is (typeof CONNECTION_ROWS)[string] => Boolean(row)),
            );
          }
          return Promise.resolve(myConnections.map((id) => ({ id, schoolYear: 2027 })));
        }),
        findUnique: jest.fn().mockResolvedValue({ id: 'conn-mine', schoolYear: 2027 }),
      },
      homeworkItem: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      behaviorItem: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      subjectEnrollment: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { weeklyHours: 0 } }),
      },
      messageBoardItem: { findMany: jest.fn().mockResolvedValue([]) },
      timetableEntry: { findMany: jest.fn().mockResolvedValue([]) },
      bellSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      studentRelease: { findMany: jest.fn().mockResolvedValue([]) },
      schoolActivity: { findMany: jest.fn().mockResolvedValue([]) },
      mailConversation: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      syncRun: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as jest.Mocked<PrismaService>;
  }

  function makeService(students: OwnedStudent[], myConnections: string[]) {
    return new ChildrenService(
      makePrisma(students, myConnections),
      makeMockSession(),
      makeMockMashovClient(),
      makeMockUserItemStateService(),
      makeMockConfig(),
      makeMockScope(),
    );
  }

  it("lists only the caller's own children", async () => {
    const service = makeService([MINE, THEIRS], ['conn-mine']);

    const result = await service.getChildren('user-mine');

    expect(result.data.map((child) => child.studentGuid)).toEqual(['guid-mine']);
  });

  it("returns 404, not 403, for another household's child", async () => {
    // 404 because a 403 confirms the guid names a real child -- and the guids
    // appear in URLs, so that is exactly the fact a stranger must not probe
    // for. The message matches the genuine not-found one for the same reason.
    const service = makeService([MINE, THEIRS], ['conn-mine']);

    await expect(service.getChildWorkspace('guid-theirs', 'user-mine')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('uses the same message for a foreign child as for a missing one', async () => {
    const service = makeService([MINE, THEIRS], ['conn-mine']);

    const foreign = await service
      .getChildWorkspace('guid-theirs', 'user-mine')
      .catch((error: { response: { error: { message: string } } }) => error.response.error.message);
    const missing = await service
      .getChildWorkspace('guid-nonexistent', 'user-mine')
      .catch((error: { response: { error: { message: string } } }) => error.response.error.message);

    expect(foreign).toBe('Student not found: guid-theirs');
    expect(missing).toBe('Student not found: guid-nonexistent');
  });

  it("lets the caller read their own child", async () => {
    const service = makeService([MINE, THEIRS], ['conn-mine']);

    await expect(service.getChildWorkspace('guid-mine', 'user-mine')).resolves.toMatchObject({
      student: expect.objectContaining({ studentGuid: 'guid-mine' }),
    });
  });

  it('shows a shared child to BOTH parents, whichever one holds the stamp', async () => {
    // B1. Before the visibility edge, the second parent to sync re-stamped the
    // shared rows and the first parent's children vanished until their own
    // next sync flipped it back -- children oscillating one cycle at a time,
    // with each parent's read/unread flags unreachable while the other held
    // the stamp.
    const mine = makeService([SHARED], ['conn-mine']);
    const theirs = makeService([SHARED], ['conn-theirs']);

    const forMine = await mine.getChildren('user-mine');
    const forTheirs = await theirs.getChildren('user-theirs');

    expect(forMine.data.map((child) => child.studentGuid)).toEqual(['guid-shared']);
    expect(forTheirs.data.map((child) => child.studentGuid)).toEqual(['guid-shared']);
  });

  /**
   * R6 — `/children` derived its school fields from the routing stamp while
   * `/dashboard` and `/feed` went through the visibility edge.
   *
   * For a child stamped to the other parent's connection, `/children` emitted
   * a `schoolId` the caller does not own with `schoolName`, `schoolShortLabel`
   * and `semel` all `null`: the badge vanished on `/children` while `/home`
   * showed one, and `MorePageClient`'s unlink flow (`child.schoolId ===
   * link.id`) could not clear the child it was about to delete.
   */
  it("reports the caller's own connection as the shared child's school", async () => {
    const mine = makeService([SHARED], ['conn-mine']);

    const result = await mine.getChildren('user-mine');

    expect(result.data[0]).toMatchObject({
      // Was 'conn-theirs', the stamp -- an id the caller does not own.
      schoolId: 'conn-mine',
      // All three were null, because the stamp was not in the caller's label
      // map at all.
      semel: 111,
      schoolName: 'בית ספר אחד',
      schoolShortLabel: 'שלי',
    });
  });

  it('gives the other parent their own connection for the same child', async () => {
    const theirs = makeService([SHARED], ['conn-theirs']);

    const result = await theirs.getChildren('user-theirs');

    expect(result.data[0]).toMatchObject({
      schoolId: 'conn-theirs',
      schoolShortLabel: 'שלהם',
    });
  });

  it('reports no school for an unstamped, unlinked child rather than a foreign one', async () => {
    // `null` across all four is the contract's "no badge", and the right
    // answer while ownership is genuinely unknown.
    const service = makeService([UNSTAMPED], ['conn-mine']);

    const result = await service.getChildren('user-mine');

    expect(result.data[0]).toMatchObject({
      schoolId: null,
      schoolName: null,
      schoolShortLabel: null,
      semel: null,
    });
  });

  it('lets both parents open a shared child, not just the stamped one', async () => {
    const mine = makeService([SHARED], ['conn-mine']);

    await expect(mine.getChildWorkspace('guid-shared', 'user-mine')).resolves.toMatchObject({
      student: expect.objectContaining({ studentGuid: 'guid-shared' }),
    });
  });

  it('still refuses a child whose only link is another household\'s', async () => {
    // The edge must widen visibility for a shared child without widening it
    // for an unrelated one: one link to a foreign connection is still foreign.
    const service = makeService([MINE, THEIRS], ['conn-mine']);

    const result = await service.getChildren('user-mine');

    expect(result.data.map((child) => child.studentGuid)).toEqual(['guid-mine']);
    await expect(service.getChildWorkspace('guid-theirs', 'user-mine')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('returns an empty list for a user with no connection, not every child', async () => {
    // The failure mode that matters: falling back to "everything" when the
    // household resolves to nothing is how an unscoped read hides.
    const service = makeService([MINE, THEIRS], []);

    const result = await service.getChildren('user-with-no-school');

    expect(result.data).toEqual([]);
  });

  it('still admits an unstamped child, in both the list and the single read', async () => {
    // NULL means "ownership unknown, re-stamp on the next roster refresh", not
    // "nobody's". Refusing these would empty the app on a single-school
    // deployment that has not re-synced since the ownership migration.
    const service = makeService([MINE, UNSTAMPED, THEIRS], ['conn-mine']);

    const result = await service.getChildren('user-mine');

    expect(result.data.map((child) => child.studentGuid).sort()).toEqual([
      'guid-mine',
      'guid-unstamped',
    ]);
    await expect(
      service.getChildWorkspace('guid-unstamped', 'user-mine'),
    ).resolves.toBeTruthy();
  });

  it('applies no household filter when there is no caller', async () => {
    // The digest and the cron paths pass no userId. They are server-side and
    // deliberately global; tightening them here would silently stop the
    // digest.
    const service = makeService([MINE, THEIRS], ['conn-mine']);

    const result = await service.getChildren();

    expect(result.data.map((child) => child.studentGuid).sort()).toEqual([
      'guid-mine',
      'guid-theirs',
    ]);
  });
});

describe('ChildrenService ownership guard coverage', () => {
  /**
   * Every route that takes a studentGuid must enforce ownership.
   *
   * Nine of them did not: they called `requireStudent(studentGuid)` without a
   * userId, so the guard inside `getStudentOrThrow` was skipped entirely. Two
   * of those nine are writes and one is a delete, and all of them resolve the
   * upstream target from the row's OWN stamp -- i.e. from the victim's
   * connection, using the victim's decrypted Mashov password. Household B
   * could create and cancel early-release requests inside household A's
   * Mashov account, and stream A's children's homework attachments.
   *
   * Guids are not a secret: they appear in URLs and in every /children
   * response.
   */
  const THEIRS = {
    id: 'row-theirs',
    studentGuid: 'guid-theirs',
    privateName: 'Someone',
    familyName: 'Else',
    fullName: 'Someone Else',
    classCode: 'ז',
    classNum: 3,
    gender: 'F',
    isActive: true,
    householdConnectionId: 'conn-theirs',
    updatedAt: new Date('2026-11-01T00:00:00Z'),
  };

  function makeService() {
    const prisma = {
      student: {
        findUnique: jest.fn().mockResolvedValue(THEIRS),
        findMany: jest.fn().mockResolvedValue([THEIRS]),
      },
      // The foreign child is listed by the other household's connection and
      // by nobody else, so the caller has no link to it.
      studentConnection: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { studentGuid: 'guid-theirs', householdConnectionId: 'conn-theirs' },
          ]),
      },
      // The caller owns conn-mine only, never conn-theirs.
      householdConnection: {
        findFirst: jest.fn(({ where }) =>
          Promise.resolve(
            where?.id && where?.userId
              ? where.id === 'conn-mine'
                ? { id: 'conn-mine' }
                : null
              : { schoolYear: 2027 },
          ),
        ),
        findMany: jest.fn().mockResolvedValue([{ id: 'conn-mine', schoolYear: 2027 }]),
        findUnique: jest.fn().mockResolvedValue({ id: 'conn-mine', schoolYear: 2027 }),
      },
      homeworkItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'hw-1',
          studentGuid: 'guid-theirs',
          files: [{ fileId: 'f1', fileName: 'note.pdf' }],
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      behaviorItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'beh-1',
          studentGuid: 'guid-theirs',
          rawPayload: { files: [{ fileId: 'f1', fileName: 'note.pdf' }] },
          lessonId: 5,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      subjectEnrollment: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { weeklyHours: 0 } }),
      },
      messageBoardItem: { findMany: jest.fn().mockResolvedValue([]) },
      timetableEntry: { findMany: jest.fn().mockResolvedValue([]) },
      bellSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      studentRelease: { findMany: jest.fn().mockResolvedValue([]) },
      schoolActivity: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as jest.Mocked<PrismaService>;

    const client = makeMockMashovClient();
    const service = new ChildrenService(
      prisma,
      makeMockSession(),
      client,
      makeMockUserItemStateService(),
      makeMockConfig(),
      makeMockScope(),
    );
    return { service, client };
  }

  /** Every call below targets a child the caller does not own. */
  const FOREIGN = 'guid-theirs';
  const CALLER = 'user-mine';

  const ROUTES: Array<{
    name: string;
    call: (service: ChildrenService) => Promise<unknown>;
  }> = [
    { name: 'getLessonPlans', call: (s) => s.getLessonPlans(FOREIGN, CALLER) },
    { name: 'getLessonHistory', call: (s) => s.getLessonHistory(FOREIGN, CALLER) },
    { name: 'getStudentReleases', call: (s) => s.getStudentReleases(FOREIGN, CALLER) },
    { name: 'getSchoolActivities', call: (s) => s.getSchoolActivities(FOREIGN, CALLER) },
    {
      name: 'createStudentRelease',
      call: (s) => s.createStudentRelease(FOREIGN, { date: '2026-11-20' }, CALLER),
    },
    {
      name: 'updateStudentRelease',
      call: (s) => s.updateStudentRelease(FOREIGN, 7, { date: '2026-11-21' }, CALLER),
    },
    { name: 'deleteStudentRelease', call: (s) => s.deleteStudentRelease(FOREIGN, 7, CALLER) },
    {
      name: 'downloadHomeworkAttachment',
      call: (s) => s.downloadHomeworkAttachment(FOREIGN, 'hw-1', 'f1', CALLER),
    },
    {
      name: 'downloadBehaviorAttachment',
      call: (s) => s.downloadBehaviorAttachment(FOREIGN, 'beh-1', 'f1', CALLER),
    },
  ];

  it.each(ROUTES)('$name refuses a child the caller does not own', async ({ call }) => {
    const { service } = makeService();

    await expect(call(service)).rejects.toMatchObject({ status: 404 });
  });

  it.each(ROUTES)('$name reaches no upstream call for a foreign child', async ({ call }) => {
    // The guard has to run BEFORE the target is resolved. Refusing after the
    // request has already been sent with the victim's credentials would be no
    // protection at all -- the release would already be created or cancelled.
    const { service, client } = makeService();

    await call(service).catch(() => undefined);

    expect(client.getForTarget).not.toHaveBeenCalled();
    expect(client.putForTarget).not.toHaveBeenCalled();
    expect(client.deleteForTarget).not.toHaveBeenCalled();
    expect(client.getResponseForTarget).not.toHaveBeenCalled();
  });
});

describe('ChildrenService per-child reads and the connection router', () => {
  /**
   * The router scopes its unstamped-row fallback to the caller. A per-child
   * read that resolves a target without saying who is asking is how one
   * household's request ended up sent upstream under another household's
   * decrypted Mashov password.
   */
  const OWNED_GUID = 'guid-mine';
  const CALLER = 'user-mine';

  const OWNED = {
    id: 'row-mine',
    studentGuid: OWNED_GUID,
    privateName: 'Child',
    familyName: 'Mine',
    fullName: 'Child Mine',
    classCode: 'ז',
    classNum: 1,
    gender: 'M',
    isActive: true,
    householdConnectionId: 'conn-mine',
    updatedAt: new Date('2026-11-01T00:00:00Z'),
  };

  function makeService(targetForStudent: jest.Mock) {
    const prisma = {
      student: {
        findUnique: jest.fn().mockResolvedValue(OWNED),
        findMany: jest.fn().mockResolvedValue([OWNED]),
      },
      studentConnection: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { studentGuid: OWNED_GUID, householdConnectionId: 'conn-mine' },
          ]),
      },
      householdConnection: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conn-mine', schoolYear: 2027 }),
        findMany: jest.fn().mockResolvedValue([{ id: 'conn-mine', schoolYear: 2027 }]),
        findUnique: jest.fn().mockResolvedValue({ id: 'conn-mine', schoolYear: 2027 }),
      },
      homeworkItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'hw-1',
          studentGuid: OWNED_GUID,
          files: [{ fileId: 'f1', fileName: 'note.pdf' }],
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      behaviorItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'beh-1',
          studentGuid: OWNED_GUID,
          rawPayload: { files: [{ fileId: 'f1', fileName: 'note.pdf' }] },
          lessonId: 5,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      studentRelease: { findMany: jest.fn().mockResolvedValue([]) },
      schoolActivity: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as jest.Mocked<PrismaService>;

    return new ChildrenService(
      prisma,
      makeMockSession(),
      makeMockMashovClient(),
      makeMockUserItemStateService(),
      makeMockConfig(),
      makeMockScope({ targetForStudent }),
    );
  }

  const ROUTES: Array<{ name: string; call: (service: ChildrenService) => Promise<unknown> }> = [
    { name: 'getLessonPlans', call: (s) => s.getLessonPlans(OWNED_GUID, CALLER) },
    { name: 'getLessonHistory', call: (s) => s.getLessonHistory(OWNED_GUID, CALLER) },
    { name: 'getStudentReleases', call: (s) => s.getStudentReleases(OWNED_GUID, CALLER) },
    { name: 'getSchoolActivities', call: (s) => s.getSchoolActivities(OWNED_GUID, CALLER) },
    {
      name: 'createStudentRelease',
      call: (s) => s.createStudentRelease(OWNED_GUID, { date: '2026-11-20' }, CALLER),
    },
    {
      name: 'updateStudentRelease',
      call: (s) => s.updateStudentRelease(OWNED_GUID, 7, { date: '2026-11-21' }, CALLER),
    },
    { name: 'deleteStudentRelease', call: (s) => s.deleteStudentRelease(OWNED_GUID, 7, CALLER) },
    {
      name: 'downloadHomeworkAttachment',
      call: (s) => s.downloadHomeworkAttachment(OWNED_GUID, 'hw-1', 'f1', CALLER),
    },
    {
      name: 'downloadBehaviorAttachment',
      call: (s) => s.downloadBehaviorAttachment(OWNED_GUID, 'beh-1', 'f1', CALLER),
    },
  ];

  it.each(ROUTES)('$name tells the router who is asking', async ({ call }) => {
    const targetForStudent = jest.fn().mockResolvedValue({
      id: 'conn-mine',
      schoolCode: 1234,
      schoolYear: 2027,
      username: 'parent',
      password: 'pw',
      schoolName: 'School',
    });
    const service = makeService(targetForStudent);

    await call(service).catch(() => undefined);

    expect(targetForStudent).toHaveBeenCalledWith(OWNED_GUID, CALLER);
  });
});
