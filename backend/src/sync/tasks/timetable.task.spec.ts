import { SyncRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { TimetableTask } from './timetable.task';
import { calendarSchoolYear } from '../../common/school-year/school-year.service';

// Every fetch is per-connection, so the suite seeds one and the year comes
// from it. `calendarSchoolYear` keeps the stamp realistic without pinning the
// suite to a hardcoded year.
const CONN_YEAR = calendarSchoolYear(new Date());
const CONNECTION = {
  id: 'conn-1',
  schoolCode: 540175,
  schoolYear: CONN_YEAR,
  username: 'parent',
  encryptedPassword: 'enc',
};

function makeTimetableItem(overrides: Record<string, unknown> = {}) {
  return {
    timeTable: {
      groupId: 10,
      day: 1,
      lesson: 2,
      roomNum: '201',
      weeks: 1,
      ...((overrides.timeTable as Record<string, unknown> | undefined) ?? {}),
    },
    groupDetails: {
      groupId: 10,
      groupName: 'Math Group',
      subjectName: 'Math',
      groupTeachers: [{ teacherGuid: 't-1', teacherName: 'Dana Levi' }],
      groupInactiveTeachers: [],
      ...((overrides.groupDetails as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

function makeSyncRun(id: string): SyncRun {
  return {
    id,
    source: 'timetable',
    status: 'running',
    startedAt: new Date('2026-03-16T00:00:00Z'),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    upstreamCount: null,
    localCount: null,
    errorMessage: null,
    householdConnectionId: null,
  };
}

describe('TimetableTask', () => {
  let task: TimetableTask;
  let mockMashovClient: jest.Mocked<Pick<MashovHttpClient, 'getForConnection'>>;
  let mockPrisma: jest.Mocked<Pick<PrismaService, 'student' | 'timetableEntry' | 'householdConnection'>>;
  let mockSyncRunService: jest.Mocked<Pick<SyncRunService, 'openRun' | 'closeRun'>>;
  let mockEncryptionService: jest.Mocked<Pick<EncryptionService, 'decrypt'>>;

  beforeEach(() => {
    mockMashovClient = {
      getForConnection: jest.fn(),
    };
    mockPrisma = {
      student: {
        findMany: jest.fn(),
      } as unknown as PrismaService['student'],
      timetableEntry: {
        upsert: jest.fn(),
      } as unknown as PrismaService['timetableEntry'],
      householdConnection: {
        findMany: jest.fn().mockResolvedValue([CONNECTION]),
        findFirst: jest.fn().mockResolvedValue({ schoolYear: CONN_YEAR }),
      } as unknown as PrismaService['householdConnection'],
    } as unknown as jest.Mocked<Pick<PrismaService, 'student' | 'timetableEntry' | 'householdConnection'>>;
    mockSyncRunService = {
      openRun: jest.fn(),
      closeRun: jest.fn(),
    };
    mockEncryptionService = {
      decrypt: jest.fn().mockReturnValue('decrypted-password'),
    };

    task = new TimetableTask(
      mockMashovClient as unknown as MashovHttpClient,
      mockPrisma as unknown as PrismaService,
      mockSyncRunService as unknown as SyncRunService,
      mockEncryptionService as unknown as EncryptionService,
    );
  });

  it('syncs timetable for all active students and closes runs successfully', async () => {
    const student1 = { studentGuid: 'stu-1', fullName: 'Alice Cohen' };
    const student2 = { studentGuid: 'stu-2', fullName: 'Noam Levi' };
    (mockPrisma.student.findMany as jest.Mock).mockResolvedValue([student1, student2]);
    mockSyncRunService.openRun
      .mockResolvedValueOnce(makeSyncRun('run-1'))
      .mockResolvedValueOnce(makeSyncRun('run-2'));
    mockMashovClient.getForConnection
      .mockResolvedValueOnce([
        makeTimetableItem({
          timeTable: { day: 1, lesson: 1, roomNum: undefined, weeks: undefined },
        }),
      ] as never)
      .mockResolvedValueOnce([
        makeTimetableItem({
          timeTable: { day: 2, lesson: 4, roomNum: '105', weeks: 2 },
        }),
      ] as never);
    (mockPrisma.timetableEntry.upsert as jest.Mock)
      .mockResolvedValueOnce({ id: 'tt-1' })
      .mockResolvedValueOnce({ id: 'tt-2' });

    const result = await task.execute();

    expect(result).toEqual({
      status: 'success',
      summary: {
        fetchedCount: 2,
        createdCount: 0,
        updatedCount: 2,
        failedCount: 0,
      },
      errorMessages: [],
    });
    expect(mockSyncRunService.openRun).toHaveBeenNthCalledWith(1, 'timetable:stu-1', undefined);
    expect(mockSyncRunService.openRun).toHaveBeenNthCalledWith(2, 'timetable:stu-2', undefined);
    expect(mockMashovClient.getForConnection).toHaveBeenNthCalledWith(
      1,
      '/api/students/stu-1/timetable',
      CONNECTION.id,
      CONNECTION.schoolCode,
      CONN_YEAR,
      CONNECTION.username,
      'decrypted-password',
      {
        headers: {
          Referer: 'https://web.mashov.info/students/main/students/stu-1/timetable',
        },
      },
    );
    expect(mockPrisma.timetableEntry.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          studentGuid_schoolYear_day_lesson: {
            studentGuid: 'stu-1',
            schoolYear: CONN_YEAR,
            day: 1,
            lesson: 1,
          },
        },
        create: expect.objectContaining({
          roomNum: '',
          weeks: -1,
          schoolYear: CONN_YEAR,
        }),
        update: expect.objectContaining({
          roomNum: '',
          weeks: -1,
        }),
      }),
    );
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-1', 'success', {
      fetchedCount: 1,
      updatedCount: 1,
    });
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-2', 'success', {
      fetchedCount: 1,
      updatedCount: 1,
    });
  });

  it('continues after a single upsert failure and records failed status in summary', async () => {
    const student = { studentGuid: 'stu-1', fullName: 'Alice Cohen' };
    (mockPrisma.student.findMany as jest.Mock).mockResolvedValue([student]);
    mockSyncRunService.openRun.mockResolvedValue(makeSyncRun('run-1'));
    mockMashovClient.getForConnection.mockResolvedValue([
      makeTimetableItem({ timeTable: { day: 1, lesson: 1 } }),
      makeTimetableItem({ timeTable: { day: 1, lesson: 2 } }),
    ] as never);
    (mockPrisma.timetableEntry.upsert as jest.Mock)
      .mockRejectedValueOnce(new Error('constraint error'))
      .mockResolvedValueOnce({ id: 'tt-2' });

    const result = await task.execute();

    expect(result.status).toBe('failed');
    expect(result.summary).toEqual({
      fetchedCount: 2,
      createdCount: 0,
      updatedCount: 1,
      failedCount: 1,
    });
    expect(result.errorMessages).toEqual(['constraint error']);
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-1', 'success', {
      fetchedCount: 2,
      updatedCount: 1,
    });
  });

  it('marks a student run as failed when upstream timetable fetch throws and keeps processing', async () => {
    const student1 = { studentGuid: 'stu-1', fullName: 'Alice Cohen' };
    const student2 = { studentGuid: 'stu-2', fullName: 'Noam Levi' };
    (mockPrisma.student.findMany as jest.Mock).mockResolvedValue([student1, student2]);
    mockSyncRunService.openRun
      .mockResolvedValueOnce(makeSyncRun('run-1'))
      .mockResolvedValueOnce(makeSyncRun('run-2'));
    mockMashovClient.getForConnection
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce([makeTimetableItem({ timeTable: { day: 2, lesson: 1 } })] as never);
    (mockPrisma.timetableEntry.upsert as jest.Mock).mockResolvedValue({ id: 'tt-1' });

    const result = await task.execute();

    expect(result.status).toBe('failed');
    expect(result.summary).toEqual({
      fetchedCount: 1,
      createdCount: 0,
      updatedCount: 1,
      failedCount: 1,
    });
    // The per-connection fan-out wraps the cause; it must still CARRY it,
    // or /more shows "every connection failed" with no diagnosis in it.
    expect(result.errorMessages).toHaveLength(1);
    expect(result.errorMessages[0]).toContain('network timeout');
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-1', 'failed', {
      errorMessage: expect.stringContaining('network timeout'),
    });
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-2', 'success', {
      fetchedCount: 1,
      updatedCount: 1,
    });
  });

  // REMOVED: 'run() delegates to execute()'. The per-task `@Cron` and its
  // `run()` shell are gone -- background sync is scheduled by
  // `NotificationWindowTask`, for notification-enabled households only. See
  // ADR-0046 and `docs/public-resource-progress.md`.
});
