import { SyncRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { HomeworkTask } from './homework.task';

function makeSyncRun(id: string): SyncRun {
  return {
    id,
    source: 'homework',
    status: 'running',
    startedAt: new Date('2026-11-17T00:00:00Z'),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    errorMessage: null,
    householdConnectionId: null,
  };
}

const STUDENT = {
  studentGuid: 'stu-1',
  fullName: 'Avi Cohen',
};

const CONNECTION = {
  id: 'conn-1',
  schoolCode: 1234,
  schoolYear: 2027,
  username: 'parent',
  encryptedPassword: 'enc',
  userId: 'user-1',
  active: true,
};

function makeHomework(overrides: Record<string, unknown> = {}) {
  return {
    lessonId: 555,
    lessonDate: '2026-11-10T00:00:00Z',
    lesson: 3,
    homework: 'Read chapter 4',
    groupId: 10,
    remark: 'ללא הערות',
    studentGuid: 'stu-1',
    subjectName: 'Math',
    ...overrides,
  };
}

describe('HomeworkTask', () => {
  let task: HomeworkTask;
  let mashovClient: { get: jest.Mock; getForConnection: jest.Mock };
  let prisma: {
    student: { findMany: jest.Mock };
    householdConnection: { findMany: jest.Mock };
    homeworkItem: { upsert: jest.Mock };
  };
  let syncRunService: { openRun: jest.Mock; closeRun: jest.Mock };

  beforeEach(() => {
    mashovClient = {
      get: jest.fn().mockResolvedValue([]),
      getForConnection: jest.fn().mockResolvedValue([makeHomework()]),
    };
    prisma = {
      student: { findMany: jest.fn().mockResolvedValue([STUDENT]) },
      householdConnection: { findMany: jest.fn().mockResolvedValue([CONNECTION]) },
      homeworkItem: { upsert: jest.fn().mockResolvedValue({}) },
    };
    syncRunService = {
      openRun: jest.fn().mockResolvedValue(makeSyncRun('run-1')),
      closeRun: jest.fn().mockResolvedValue(undefined),
    };

    task = new HomeworkTask(
      mashovClient as unknown as MashovHttpClient,
      prisma as unknown as PrismaService,
      syncRunService as unknown as SyncRunService,
      { decrypt: jest.fn().mockReturnValue('pw') } as unknown as EncryptionService,
    );
  });

  it("stamps upserts with the connection's school year", async () => {
    await task.execute();

    expect(prisma.homeworkItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ schoolYear: 2027 }),
      }),
    );
  });

  it('does not overwrite a previous-year row when a lessonId repeats', async () => {
    await task.execute();

    expect(prisma.homeworkItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          studentGuid_schoolYear_lessonId: {
            studentGuid: 'stu-1',
            schoolYear: 2027,
            lessonId: 555,
          },
        },
      }),
    );
  });

  it('keeps the year on the hashed-lessonId fallback path', async () => {
    mashovClient.getForConnection.mockResolvedValue([makeHomework({ lessonId: 0 })]);

    await task.execute();

    const call = prisma.homeworkItem.upsert.mock.calls[0][0];
    expect(call.where.studentGuid_schoolYear_lessonId.schoolYear).toBe(2027);
    expect(call.create.schoolYear).toBe(2027);
  });

  it('records a successful run per student', async () => {
    await task.execute();

    expect(syncRunService.openRun).toHaveBeenCalledWith('homework:stu-1', undefined);
    expect(syncRunService.closeRun).toHaveBeenCalledWith(
      'run-1',
      'success',
      expect.objectContaining({ fetchedCount: 1, updatedCount: 1 }),
    );
  });
});
