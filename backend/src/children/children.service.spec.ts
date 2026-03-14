import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChildrenService } from './children.service';
import { SessionService } from '../session/session.service';

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
    },
    behaviorItem: {
      count: overrides.behaviorCount ?? jest.fn().mockResolvedValue(0),
      findMany: overrides.behaviorFindMany ?? jest.fn().mockResolvedValue([]),
      findUnique: overrides.behaviorFindUnique ?? jest.fn().mockResolvedValue(null),
      findFirst: overrides.behaviorFindFirst ?? jest.fn().mockResolvedValue(null),
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
    readState: {
      findMany: overrides.readStateFindMany ?? jest.fn().mockResolvedValue([]),
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
      );

      await expect(service.getChildWorkspace('missing-guid')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getHomework', () => {
    it('returns paginated data and merges read-state handled flags', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([
            {
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
            },
          ]),
          homeworkCount: jest.fn().mockResolvedValue(1),
          readStateFindMany: jest.fn().mockResolvedValue([
            { itemId: 'hw-1', isHandled: true },
          ]),
        }),
        makeMockSession(),
      );

      const result = await service.getHomework(TEST_GUID, 1, 20);
      expect(result.pagination).toMatchObject({ total: 1, totalPages: 1 });
      expect(result.data[0].isHandled).toBe(true);
      expect(result.data[0].lessonDate).toBe('2026-03-10T00:00:00.000Z');
    });
  });

  describe('getHomeworkDetail', () => {
    it('returns a single homework detail item with handled state', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue({
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
          }),
          readStateFindMany: jest.fn().mockResolvedValue([
            { itemId: 'hw-1', isHandled: true },
          ]),
        }),
        makeMockSession(),
      );

      const result = await service.getHomeworkDetail(TEST_GUID, 'hw-1');
      expect(result).toMatchObject({
        id: 'hw-1',
        studentGuid: TEST_GUID,
        isHandled: true,
      });
      expect(result.lessonDate).toBe('2026-03-10T00:00:00.000Z');
    });

    it('throws NotFoundException when homework item is missing', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
      );

      await expect(service.getHomeworkDetail(TEST_GUID, 'missing-hw')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when homework item belongs to another student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindUnique: jest.fn().mockResolvedValue({
            id: 'hw-1',
            studentGuid: 'other-student-guid',
            lessonId: 1,
            groupId: 2,
            lessonDate: new Date('2026-03-10T00:00:00Z'),
            lesson: 3,
            subjectName: 'Math',
            homeworkText: 'Page 10',
            remark: null,
            files: [],
            updatedAt: new Date('2026-03-10T01:00:00Z'),
          }),
        }),
        makeMockSession(),
      );

      await expect(service.getHomeworkDetail(TEST_GUID, 'hw-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getBehavior', () => {
    it('maps classification to bucket and eventCode to priority', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([
        {
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
        },
      ]);
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindMany: mockFindMany,
          behaviorCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockSession(),
      );

      const result = await service.getBehavior(TEST_GUID, 1, 50, 'attention');
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentGuid: TEST_GUID, classification: 'attention' },
        }),
      );
      expect(result.data[0].bucket).toBe('attention');
      expect(result.data[0].priority).toBe('high');
    });
  });

  describe('getBehaviorDetail', () => {
    it('returns a single behavior detail item with handled state', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue({
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
          }),
          readStateFindMany: jest.fn().mockResolvedValue([
            { itemId: 'beh-1', isHandled: true },
          ]),
        }),
        makeMockSession(),
      );

      const result = await service.getBehaviorDetail(TEST_GUID, 'beh-1');
      expect(result).toMatchObject({
        id: 'beh-1',
        studentGuid: TEST_GUID,
        bucket: 'attention',
        priority: 'high',
        isHandled: true,
      });
      expect(result.lessonDate).toBe('2026-03-11T00:00:00.000Z');
    });

    it('throws NotFoundException when behavior item is missing', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockSession(),
      );

      await expect(service.getBehaviorDetail(TEST_GUID, 'missing-beh')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when behavior item belongs to another student', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          behaviorFindUnique: jest.fn().mockResolvedValue({
            id: 'beh-1',
            studentGuid: 'other-student-guid',
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
          }),
        }),
        makeMockSession(),
      );

      await expect(service.getBehaviorDetail(TEST_GUID, 'beh-1')).rejects.toThrow(
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
