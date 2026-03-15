import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChildrenService } from './children.service';
import { SessionService } from '../session/session.service';
import { MashovHttpClient } from '../session/mashov-http.client';

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
    isNew: true,
    isArchived: false,
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
    isNew: true,
    isArchived: false,
    updatedAt: new Date('2026-03-11T11:00:00Z'),
    ...overrides,
  };
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
    },
    behaviorItem: {
      count: overrides.behaviorCount ?? jest.fn().mockResolvedValue(0),
      findMany: overrides.behaviorFindMany ?? jest.fn().mockResolvedValue([]),
      findUnique: overrides.behaviorFindUnique ?? jest.fn().mockResolvedValue(null),
      findFirst: overrides.behaviorFindFirst ?? jest.fn().mockResolvedValue(null),
      update: overrides.behaviorUpdate ?? jest.fn().mockResolvedValue(makeBehaviorRow()),
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
    syncRun: {
      findFirst: overrides.syncRunFindFirst ?? jest.fn().mockResolvedValue(null),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeMockSession(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    ensureStudentsAvailable:
      overrides.ensureStudentsAvailable ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SessionService>;
}

function makeMockMashovClient(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    getResponse: overrides.getResponse ?? jest.fn(),
  } as unknown as jest.Mocked<MashovHttpClient>;
}

describe('ChildrenService', () => {
  describe('getChildren', () => {
    it('returns {data} with computed counts and latestUpdateAt', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkCount: jest.fn().mockResolvedValue(2),
          behaviorCount: jest.fn().mockResolvedValue(1),
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
      );

      const result = await service.getChildren();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data[0]).toMatchObject({
        studentGuid: TEST_GUID,
        recentHomeworkCount: 2,
        recentBehaviorCount: 1,
        subjectCount: 5,
      });
      expect(typeof result.data[0].latestUpdateAt).toBe('string');
    });
  });

  describe('getChildWorkspace', () => {
    it('returns contract shape {student, summary, lastSyncAt}', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkCount: jest.fn().mockResolvedValue(3),
          behaviorCount: jest
            .fn()
            .mockResolvedValueOnce(2) // recentBehaviorCount
            .mockResolvedValueOnce(1), // attentionBehaviorCount
          subjectCount: jest.fn().mockResolvedValue(4),
          subjectAggregate: jest.fn().mockResolvedValue({ _sum: { weeklyHours: 9 } }),
          syncRunFindFirst: jest.fn().mockResolvedValue({
            endedAt: new Date('2026-03-12T14:00:00Z'),
          }),
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.getChildWorkspace(TEST_GUID);
      expect(result.student.studentGuid).toBe(TEST_GUID);
      expect(result.summary).toEqual({
        recentHomeworkCount: 3,
        recentBehaviorCount: 2,
        subjectCount: 4,
        totalWeeklyHours: 9,
        attentionBehaviorCount: 1,
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
      );

      await expect(service.getChildWorkspace('missing-guid')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getHomework', () => {
    it('returns paginated data with isNew and isArchived from homework_item directly', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([
            makeHomeworkRow({ isNew: true, isArchived: false }),
          ]),
          homeworkCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.getHomework(TEST_GUID, 1, 20);
      expect(result.pagination).toMatchObject({ total: 1, totalPages: 1 });
      expect(result.data[0].isNew).toBe(true);
      expect(result.data[0].isArchived).toBe(false);
      expect(result.data[0].lessonDate).toBe('2026-03-10T00:00:00.000Z');
    });

    it('returns isNew=false and isArchived=true for archived items', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([
            makeHomeworkRow({ isNew: false, isArchived: true }),
          ]),
          homeworkCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.getHomework(TEST_GUID, 1, 20);
      expect(result.data[0].isNew).toBe(false);
      expect(result.data[0].isArchived).toBe(true);
    });

    it('does not include isHandled field on homework items', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([makeHomeworkRow()]),
          homeworkCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.getHomework(TEST_GUID, 1, 20);
      expect(result.data[0]).not.toHaveProperty('isHandled');
    });
  });

  describe('getHomeworkDetail', () => {
    it('returns a single homework detail item with isNew and isArchived', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(
            makeHomeworkRow({ isNew: true, isArchived: false }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
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
      );

      await expect(service.getHomeworkDetail(TEST_GUID, 'hw-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setHomeworkIsNew', () => {
    it('updates isNew on the homework item and returns updated item', async () => {
      const homeworkUpdate = jest.fn().mockResolvedValue(
        makeHomeworkRow({ isNew: false }),
      );
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(makeHomeworkRow()),
          homeworkUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.setHomeworkIsNew(TEST_GUID, 'hw-1', false);
      expect(homeworkUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'hw-1' },
          data: expect.objectContaining({ isNew: false }),
        }),
      );
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
      );

      await expect(service.setHomeworkIsNew(TEST_GUID, 'hw-1', false)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setHomeworkArchived', () => {
    it('sets isArchived=true and forces isNew=false when archiving', async () => {
      const homeworkUpdate = jest.fn().mockResolvedValue(
        makeHomeworkRow({ isNew: false, isArchived: true }),
      );
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(makeHomeworkRow({ isNew: true })),
          homeworkUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.setHomeworkArchived(TEST_GUID, 'hw-1', true);
      expect(homeworkUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isArchived: true, isNew: false }),
        }),
      );
      expect(result.isArchived).toBe(true);
      expect(result.isNew).toBe(false);
    });

    it('sets isArchived=false and restores isNew=true when unarchiving', async () => {
      const homeworkUpdate = jest.fn().mockResolvedValue(
        makeHomeworkRow({ isNew: true, isArchived: false }),
      );
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(
            makeHomeworkRow({ isNew: false, isArchived: true }),
          ),
          homeworkUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.setHomeworkArchived(TEST_GUID, 'hw-1', false);
      expect(homeworkUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isArchived: false, isNew: true }),
        }),
      );
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
      );

      await expect(service.setHomeworkArchived(TEST_GUID, 'hw-1', true)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getBehavior', () => {
    it('maps classification to bucket and eventCode to priority with isNew and isArchived', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([
        makeBehaviorRow({ isNew: true, isArchived: false }),
      ]);
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindMany: mockFindMany,
          behaviorCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.getBehavior(TEST_GUID, 1, 50, 'attention');
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            studentGuid: TEST_GUID,
            classification: 'attention',
            isArchived: false,
          }),
        }),
      );
      expect(result.data[0].bucket).toBe('attention');
      expect(result.data[0].priority).toBe('high');
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
      );

      const result = await service.getBehavior(TEST_GUID, 1, 50, 'all');
      expect(result.data[0]).not.toHaveProperty('isHandled');
    });
  });

  describe('getBehaviorDetail', () => {
    it('returns a single behavior detail item with isNew and isArchived', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(
            makeBehaviorRow({ isNew: true, isArchived: false }),
          ),
        }),
        makeMockSession(),
        makeMockMashovClient(),
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
      );

      await expect(service.getBehaviorDetail(TEST_GUID, 'beh-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setBehaviorIsNew', () => {
    it('updates isNew on the behavior item and returns updated item', async () => {
      const behaviorUpdate = jest.fn().mockResolvedValue(
        makeBehaviorRow({ isNew: false }),
      );
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(makeBehaviorRow()),
          behaviorUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.setBehaviorIsNew(TEST_GUID, 'beh-1', false);
      expect(behaviorUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'beh-1' },
          data: expect.objectContaining({ isNew: false }),
        }),
      );
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
      );

      await expect(service.setBehaviorIsNew(TEST_GUID, 'beh-1', false)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setBehaviorArchived', () => {
    it('sets isArchived=true and forces isNew=false when archiving', async () => {
      const behaviorUpdate = jest.fn().mockResolvedValue(
        makeBehaviorRow({ isNew: false, isArchived: true }),
      );
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(makeBehaviorRow({ isNew: true })),
          behaviorUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.setBehaviorArchived(TEST_GUID, 'beh-1', true);
      expect(behaviorUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isArchived: true, isNew: false }),
        }),
      );
      expect(result.isArchived).toBe(true);
      expect(result.isNew).toBe(false);
    });

    it('sets isArchived=false and restores isNew=true when unarchiving', async () => {
      const behaviorUpdate = jest.fn().mockResolvedValue(
        makeBehaviorRow({ isNew: true, isArchived: false }),
      );
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(
            makeBehaviorRow({ isNew: false, isArchived: true }),
          ),
          behaviorUpdate,
        }),
        makeMockSession(),
        makeMockMashovClient(),
      );

      const result = await service.setBehaviorArchived(TEST_GUID, 'beh-1', false);
      expect(behaviorUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isArchived: false, isNew: true }),
        }),
      );
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
      );

      await expect(service.setBehaviorArchived(TEST_GUID, 'beh-1', true)).rejects.toThrow(
        NotFoundException,
      );
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
      );

      const subjects = await service.getSubjects(TEST_GUID);
      const notices = await service.getNotices(TEST_GUID);

      expect(Array.isArray(subjects.data)).toBe(true);
      expect(Array.isArray(notices.data)).toBe(true);
      expect(subjects.data[0].updatedAt).toBe('2026-03-12T00:00:00.000Z');
      expect(notices.data[0].expirationDate).toBe('2026-03-20T00:00:00.000Z');
    });
  });
});
