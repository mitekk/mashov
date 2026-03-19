import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChildrenService } from './children.service';
import { MashovSessionService } from '../session/mashov-session.service';
import { MashovHttpClient } from '../session/mashov-http.client';
import { UserItemStateService } from '../common/user-item-state.service';

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
    updatedAt: new Date('2026-03-12T10:00:00Z'),
  };
}

function makeHomeworkRow(overrides: object = {}) {
  return {
    id: 'hw-1',
    studentGuid: TEST_GUID,
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
      findMany: overrides.studentFindMany ?? jest.fn().mockResolvedValue([student]),
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
    syncRun: {
      findFirst: overrides.syncRunFindFirst ?? jest.fn().mockResolvedValue(null),
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
    get: overrides.get ?? jest.fn(),
    getResponse: overrides.getResponse ?? jest.fn(),
  } as unknown as jest.Mocked<MashovHttpClient>;
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
      );

      const result = await service.getChildren('user-1');
      expect(result.data[0]).toMatchObject({
        recentHomeworkCount: 0,
        recentBehaviorCount: 1,
        positiveBehaviorCount: 0,
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
      );

      const result = await service.getChildWorkspace(TEST_GUID);
      expect(result.student.studentGuid).toBe(TEST_GUID);
      expect(result.summary).toEqual({
        recentHomeworkCount: 3,
        recentBehaviorCount: 2,
        positiveBehaviorCount: 1,
        subjectCount: 4,
        totalWeeklyHours: 9,
        attentionBehaviorCount: 2,
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
      );

      const result = await service.getTimetable(TEST_GUID);
      expect(timetableFindMany).toHaveBeenCalledWith({
        where: { studentGuid: TEST_GUID },
        orderBy: [{ day: 'asc' }, { lesson: 'asc' }],
      });
      expect(result).toEqual({
        data: [
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
        ],
      });
    });

    it('throws NotFoundException for unknown student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          studentFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
        makeMockMashovClient(),
        makeMockUserItemStateService(),
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
      );

      const result = await service.getLessonHistory(TEST_GUID);
      expect(get).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/lessons/history`,
        {
          headers: {
            Referer: `https://web.mashov.info/students/main/students/${TEST_GUID}/weeklyPlan`,
          },
        },
      );
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
      );

      const result = await service.getLessonHistory(TEST_GUID);
      expect(result).toEqual({ data: [] });
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
      );

      const result = await service.getChildWorkspace(TEST_GUID);
      expect(result.student.studentGuid).toBe(TEST_GUID);
      expect(ensureStudentsAvailable).toHaveBeenCalledTimes(1);
      expect(studentFindUnique).toHaveBeenCalledTimes(2);
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
      );

      const result = await service.downloadHomeworkAttachment(TEST_GUID, 'hw-1', 'hw-file-1');
      expect(getResponse).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/studyFiles/hw-file-1/homework%20file.pdf`,
        expect.any(Object),
      );
      expect(getResponse).toHaveBeenCalledWith(
        `/api/students/${TEST_GUID}/files/hw-file-1/homework%20file.pdf`,
        expect.any(Object),
      );
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
      );

      const result = await service.downloadBehaviorAttachment(TEST_GUID, 'beh-1', 'beh-file-1');
      expect(getResponse).toHaveBeenCalledWith(
        '/api/lessons/7/files/beh-file-1/behavior.pdf',
        expect.any(Object),
      );
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
      );

      await expect(
        service.downloadBehaviorAttachment(TEST_GUID, 'beh-1', 'beh-file-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
