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
    householdConnection: { findMany: jest.Mock; findFirst: jest.Mock };
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
      householdConnection: {
        findMany: jest.fn().mockResolvedValue([CONNECTION]),
        findFirst: jest.fn().mockResolvedValue({ schoolYear: 2027 }),
      },
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

  it('stamps shared-session rows with the stored connection year, not the calendar year', async () => {
    // The shared-session path has no user-owned connection, but reads are still
    // scoped to the stored year. Stamping writes from the calendar instead lets
    // the two diverge whenever the schools API publishes ahead of the calendar,
    // and the synced rows are then written but never displayed.
    prisma.householdConnection.findMany.mockResolvedValue([]);
    prisma.householdConnection.findFirst.mockResolvedValue({ schoolYear: 2028 });
    mashovClient.get.mockResolvedValue([makeHomework()]);

    await task.execute();

    expect(prisma.homeworkItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ schoolYear: 2028 }),
      }),
    );
  });

  it('resolves connections in a deterministic order', async () => {
    await task.execute();

    expect(prisma.householdConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: expect.anything() }),
    );
  });
  describe('historical year context', () => {
    it('stamps and fetches the context school year when given one', async () => {
      await task.execute({ connectionId: 'conn-1', schoolYear: 2026 });

      // One value feeds both the login year and the row stamp: a session is
      // scoped to the year in its login body, so a stamp that disagrees with
      // the fetch writes one year's data under another year's label.
      const fetchArgs = mashovClient.getForConnection.mock.calls[0];
      expect(fetchArgs).toContain(2026);
      expect(prisma.homeworkItem.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ schoolYear: 2026 }),
          where: {
            studentGuid_schoolYear_lessonId: {
              studentGuid: 'stu-1',
              schoolYear: 2026,
              lessonId: 555,
            },
          },
        }),
      );
    });

    it("still uses the connection's year when no context year is given", async () => {
      await task.execute({ connectionId: 'conn-1' });

      expect(mashovClient.getForConnection.mock.calls[0]).toContain(2027);
      expect(prisma.homeworkItem.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ schoolYear: 2027 }),
        }),
      );
    });

    it('prefixes the run source when given a source prefix', async () => {
      await task.execute({
        connectionId: 'conn-1',
        schoolYear: 2026,
        sourcePrefix: 'history:2026:',
      });

      expect(syncRunService.openRun).toHaveBeenCalledWith(
        'history:2026:homework:stu-1',
        'conn-1',
      );
    });

    it('refuses a historical year on the shared-session path', async () => {
      // The shared session is process-global and has no per-year identity, so
      // it would silently answer with the current year's data.
      prisma.householdConnection.findMany.mockResolvedValue([]);

      const result = await task.execute({ schoolYear: 2026 });

      expect(result.status).toBe('failed');
      expect(mashovClient.get).not.toHaveBeenCalled();
      expect(prisma.homeworkItem.upsert).not.toHaveBeenCalled();
    });

    it('still runs the shared-session path when no year is asked for', async () => {
      prisma.householdConnection.findMany.mockResolvedValue([]);

      const result = await task.execute();

      expect(result.status).toBe('success');
      expect(mashovClient.get).toHaveBeenCalled();
    });
  });
});
