import { SyncRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { TimetableTask } from './timetable.task';
import { calendarSchoolYear } from '../../common/school-year/school-year.service';

// This suite exercises the legacy shared-session path (no household
// connection), where the year falls back to the calendar.
const FALLBACK_YEAR = calendarSchoolYear(new Date());

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
    errorMessage: null,
    householdConnectionId: null,
  };
}

describe('TimetableTask', () => {
  let task: TimetableTask;
  let mockMashovClient: jest.Mocked<Pick<MashovHttpClient, 'get'>>;
  let mockPrisma: jest.Mocked<Pick<PrismaService, 'student' | 'timetableEntry' | 'householdConnection'>>;
  let mockSyncRunService: jest.Mocked<Pick<SyncRunService, 'openRun' | 'closeRun'>>;
  let mockEncryptionService: jest.Mocked<Pick<EncryptionService, 'decrypt'>>;

  beforeEach(() => {
    mockMashovClient = {
      get: jest.fn(),
    };
    mockPrisma = {
      student: {
        findMany: jest.fn(),
      } as unknown as PrismaService['student'],
      timetableEntry: {
        upsert: jest.fn(),
      } as unknown as PrismaService['timetableEntry'],
      householdConnection: {
        findMany: jest.fn().mockResolvedValue([]),
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
    mockMashovClient.get
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
    expect(mockMashovClient.get).toHaveBeenNthCalledWith(
      1,
      '/api/students/stu-1/timetable',
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
            schoolYear: FALLBACK_YEAR,
            day: 1,
            lesson: 1,
          },
        },
        create: expect.objectContaining({
          roomNum: '',
          weeks: -1,
          schoolYear: FALLBACK_YEAR,
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
    mockMashovClient.get.mockResolvedValue([
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
    mockMashovClient.get
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
    expect(result.errorMessages).toEqual(['network timeout']);
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-1', 'failed', {
      errorMessage: 'network timeout',
    });
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-2', 'success', {
      fetchedCount: 1,
      updatedCount: 1,
    });
  });

  it('run() delegates to execute()', async () => {
    const executeSpy = jest.spyOn(task, 'execute').mockResolvedValue({
      status: 'success',
      summary: {
        fetchedCount: 0,
        createdCount: 0,
        updatedCount: 0,
        failedCount: 0,
      },
      errorMessages: [],
    });

    await task.run();

    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});
