import { NotFoundException } from '@nestjs/common';
import { ChildrenService } from './children.service';
import { PrismaService } from '../prisma/prisma.service';

const TEST_GUID = 'student-guid-001';

function makeMockStudent(overrides?: object) {
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
    ...overrides,
  };
}

function makeMockPrisma(overrides: Partial<{
  studentFindMany: jest.Mock;
  studentFindUnique: jest.Mock;
  homeworkFindMany: jest.Mock;
  homeworkCount: jest.Mock;
  behaviorFindMany: jest.Mock;
  behaviorCount: jest.Mock;
  subjectFindMany: jest.Mock;
  messageBoardFindMany: jest.Mock;
}>): jest.Mocked<PrismaService> {
  const student = makeMockStudent();
  return {
    student: {
      findMany: overrides.studentFindMany ?? jest.fn().mockResolvedValue([student]),
      findUnique: overrides.studentFindUnique ?? jest.fn().mockResolvedValue(student),
    },
    homeworkItem: {
      findMany: overrides.homeworkFindMany ?? jest.fn().mockResolvedValue([]),
      count: overrides.homeworkCount ?? jest.fn().mockResolvedValue(0),
    },
    behaviorItem: {
      findMany: overrides.behaviorFindMany ?? jest.fn().mockResolvedValue([]),
      count: overrides.behaviorCount ?? jest.fn().mockResolvedValue(0),
    },
    subjectEnrollment: {
      findMany: overrides.subjectFindMany ?? jest.fn().mockResolvedValue([]),
    },
    messageBoardItem: {
      findMany: overrides.messageBoardFindMany ?? jest.fn().mockResolvedValue([]),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

describe('ChildrenService', () => {
  describe('getChildren', () => {
    it('returns all active students ordered by name', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([makeMockStudent()]);
      const service = new ChildrenService(makeMockPrisma({ studentFindMany: mockFindMany }));

      const result = await service.getChildren();
      expect(result).toHaveLength(1);
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true },
          orderBy: { fullName: 'asc' },
        }),
      );
    });

    it('returns an empty array when no students exist', async () => {
      const service = new ChildrenService(
        makeMockPrisma({ studentFindMany: jest.fn().mockResolvedValue([]) }),
      );
      const result = await service.getChildren();
      expect(result).toEqual([]);
    });
  });

  describe('getChildWorkspace', () => {
    it('returns workspace data with student when student exists', async () => {
      const service = new ChildrenService(makeMockPrisma({}));
      const result = await service.getChildWorkspace(TEST_GUID);

      expect(result.student.studentGuid).toBe(TEST_GUID);
      expect(result.homework).toEqual([]);
      expect(result.behavior).toEqual([]);
      expect(result.subjects).toEqual([]);
      expect(result.notices).toEqual([]);
    });

    it('throws NotFoundException when student does not exist', async () => {
      const service = new ChildrenService(
        makeMockPrisma({ studentFindUnique: jest.fn().mockResolvedValue(null) }),
      );
      await expect(service.getChildWorkspace('non-existent-guid')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getHomework', () => {
    it('returns paginated homework items', async () => {
      const hwItems = [
        {
          id: 'hw-1',
          studentGuid: TEST_GUID,
          subjectName: 'Math',
          homeworkText: 'Do exercises',
          lessonDate: new Date(),
        },
      ];
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue(hwItems),
          homeworkCount: jest.fn().mockResolvedValue(1),
        }),
      );

      const result = await service.getHomework(TEST_GUID, 1, 20);
      expect(result.data).toHaveLength(1);
      expect(result.pagination).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it('calculates correct totalPages for pagination', async () => {
      const service = new ChildrenService(
        makeMockPrisma({
          homeworkFindMany: jest.fn().mockResolvedValue([]),
          homeworkCount: jest.fn().mockResolvedValue(25),
        }),
      );

      const result = await service.getHomework(TEST_GUID, 1, 10);
      expect(result.pagination.totalPages).toBe(3);
      expect(result.pagination.total).toBe(25);
    });

    it('throws NotFoundException when student does not exist', async () => {
      const service = new ChildrenService(
        makeMockPrisma({ studentFindUnique: jest.fn().mockResolvedValue(null) }),
      );
      await expect(service.getHomework('unknown-guid', 1, 20)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getBehavior', () => {
    it('returns paginated behavior items when bucket=all', async () => {
      const behaviorItems = [
        { id: 'beh-1', studentGuid: TEST_GUID, achvaName: 'Late', classification: 'attention' },
      ];
      const mockFindMany = jest.fn().mockResolvedValue(behaviorItems);
      const mockCount = jest.fn().mockResolvedValue(1);
      const service = new ChildrenService(
        makeMockPrisma({ behaviorFindMany: mockFindMany, behaviorCount: mockCount }),
      );

      const result = await service.getBehavior(TEST_GUID, 1, 50, 'all');
      expect(result.data).toHaveLength(1);
      // When bucket=all, no bucket filter should be applied
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentGuid: TEST_GUID },
        }),
      );
    });

    it('applies bucket filter when bucket is not "all"', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([]);
      const mockCount = jest.fn().mockResolvedValue(0);
      const service = new ChildrenService(
        makeMockPrisma({ behaviorFindMany: mockFindMany, behaviorCount: mockCount }),
      );

      await service.getBehavior(TEST_GUID, 1, 50, 'attention');
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentGuid: TEST_GUID, bucket: 'attention' },
        }),
      );
    });

    it('throws NotFoundException when student does not exist', async () => {
      const service = new ChildrenService(
        makeMockPrisma({ studentFindUnique: jest.fn().mockResolvedValue(null) }),
      );
      await expect(service.getBehavior('unknown', 1, 50, 'all')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSubjects', () => {
    it('returns subjects for a valid student', async () => {
      const subjects = [{ id: 'sub-1', studentGuid: TEST_GUID, subjectName: 'Math' }];
      const service = new ChildrenService(
        makeMockPrisma({ subjectFindMany: jest.fn().mockResolvedValue(subjects) }),
      );

      const result = await service.getSubjects(TEST_GUID);
      expect(result).toHaveLength(1);
    });

    it('throws NotFoundException when student does not exist', async () => {
      const service = new ChildrenService(
        makeMockPrisma({ studentFindUnique: jest.fn().mockResolvedValue(null) }),
      );
      await expect(service.getSubjects('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getNotices', () => {
    it('returns only non-expired notices for a valid student', async () => {
      const notices = [{ id: 'notice-1', studentGuid: TEST_GUID, eventText: 'Trip reminder' }];
      const mockFindMany = jest.fn().mockResolvedValue(notices);
      const service = new ChildrenService(
        makeMockPrisma({ messageBoardFindMany: mockFindMany }),
      );

      const result = await service.getNotices(TEST_GUID);
      expect(result).toHaveLength(1);
      // Verify expirationDate filter is applied (gt: now)
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            studentGuid: TEST_GUID,
            expirationDate: expect.objectContaining({ gt: expect.any(Date) }),
          }),
        }),
      );
    });

    it('throws NotFoundException when student does not exist', async () => {
      const service = new ChildrenService(
        makeMockPrisma({ studentFindUnique: jest.fn().mockResolvedValue(null) }),
      );
      await expect(service.getNotices('unknown')).rejects.toThrow(NotFoundException);
    });
  });
});
