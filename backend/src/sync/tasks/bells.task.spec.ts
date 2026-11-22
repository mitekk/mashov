import { Logger } from '@nestjs/common';
import { BellsTask } from './bells.task';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';

/**
 * `GET /api/bells` is school-wide and unverified (ADR-0037). Both facts are
 * assertions here: one upstream call per school rather than per connection,
 * and a missing endpoint closing the run green rather than red — because a
 * red run for an endpoint that may not exist is an alert nobody can action,
 * and the read path already has a default schedule to fall back to.
 */

/** One upstream period row, in the shape `apis/get-api-bells.md` documents. */
function bell(lessonNumber: unknown, startTime: unknown, endTime: unknown) {
  return { lessonNumber, startTime, endTime };
}

function connection(overrides: object = {}) {
  return {
    id: 'conn-a',
    userId: 'user-1',
    schoolCode: 540175,
    schoolYear: 2027,
    username: 'parent-a',
    encryptedPassword: 'enc',
    ...overrides,
  };
}

describe('BellsTask', () => {
  let task: BellsTask;
  let mashovClient: { get: jest.Mock; getForConnection: jest.Mock };
  let prisma: {
    householdConnection: { findMany: jest.Mock };
    bellSchedule: { upsert: jest.Mock };
  };
  let syncRunService: { openRun: jest.Mock; closeRun: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    mashovClient = {
      get: jest.fn(),
      getForConnection: jest
        .fn()
        .mockResolvedValue([bell(1, '08:15:00', '09:00:00')]),
    };
    prisma = {
      householdConnection: { findMany: jest.fn().mockResolvedValue([connection()]) },
      bellSchedule: { upsert: jest.fn().mockResolvedValue({}) },
    };
    syncRunService = {
      openRun: jest.fn().mockResolvedValue({ id: 'run-1' }),
      closeRun: jest.fn().mockResolvedValue({ id: 'run-1' }),
    };

    task = new BellsTask(
      mashovClient as unknown as MashovHttpClient,
      prisma as unknown as PrismaService,
      syncRunService as unknown as SyncRunService,
      { decrypt: jest.fn().mockReturnValue('pw') } as unknown as EncryptionService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('stores the school periods and closes the run success', async () => {
    mashovClient.getForConnection.mockResolvedValue([
      bell(1, '08:15:00', '09:00:00'),
      bell(2, '09:15:00', '10:00:00'),
    ]);

    const result = await task.execute();

    expect(result.status).toBe('success');
    expect(result.summary).toMatchObject({ fetchedCount: 2, updatedCount: 2, failedCount: 0 });
    expect(mashovClient.getForConnection).toHaveBeenCalledWith(
      '/api/bells',
      'conn-a',
      540175,
      2027,
      'parent-a',
      'pw',
      { headers: { 'Referer': 'https://web.mashov.info/students/main/dashboard' } },
    );
    expect(syncRunService.openRun).toHaveBeenCalledWith('bells:540175', undefined);
    expect(syncRunService.closeRun).toHaveBeenCalledWith(
      'run-1',
      'success',
      expect.objectContaining({ fetchedCount: 2, updatedCount: 2 }),
    );
  });

  it('normalizes the upstream seconds away and keys the row by school and year', async () => {
    await task.execute();

    expect(prisma.bellSchedule.upsert).toHaveBeenCalledWith({
      where: {
        schoolCode_schoolYear_lesson: { schoolCode: 540175, schoolYear: 2027, lesson: 1 },
      },
      create: {
        schoolCode: 540175,
        schoolYear: 2027,
        lesson: 1,
        startTime: '08:15',
        endTime: '09:00',
      },
      update: { startTime: '08:15', endTime: '09:00' },
    });
  });

  it('makes one upstream call for two connections at the same school', async () => {
    // Two parents of one child, or one parent with children in two classes:
    // the bell schedule is the same rows either way, and asking twice is a
    // guaranteed duplicate call on every run.
    prisma.householdConnection.findMany.mockResolvedValue([
      connection(),
      connection({ id: 'conn-b', userId: 'user-2', username: 'parent-b' }),
    ]);

    await task.execute();

    expect(mashovClient.getForConnection).toHaveBeenCalledTimes(1);
    expect(syncRunService.openRun).toHaveBeenCalledTimes(1);
  });

  it('asks each school once when the household spans two', async () => {
    prisma.householdConnection.findMany.mockResolvedValue([
      connection(),
      connection({ id: 'conn-b', schoolCode: 999001 }),
    ]);

    await task.execute();

    expect(mashovClient.getForConnection).toHaveBeenCalledTimes(2);
    expect(mashovClient.getForConnection.mock.calls.map((call) => call[2])).toEqual([
      540175, 999001,
    ]);
  });

  describe('when the endpoint is not there', () => {
    it('closes an empty array success with nothing fetched', async () => {
      mashovClient.getForConnection.mockResolvedValue([]);

      const result = await task.execute();

      expect(result.status).toBe('success');
      expect(result.summary.fetchedCount).toBe(0);
      expect(prisma.bellSchedule.upsert).not.toHaveBeenCalled();
      expect(syncRunService.closeRun).toHaveBeenCalledWith(
        'run-1',
        'success',
        expect.objectContaining({ fetchedCount: 0 }),
      );
    });

    it('closes a 404 success too, rather than failing a run nobody can fix', async () => {
      // `MashovHttpClient` flattens the axios error into this message shape.
      mashovClient.getForConnection.mockRejectedValue(
        new Error(
          'Upstream GET /api/bells (connection conn-a) failed with status 404: Request failed',
        ),
      );

      const result = await task.execute();

      expect(result.status).toBe('success');
      expect(result.summary.failedCount).toBe(0);
      expect(syncRunService.closeRun).toHaveBeenCalledWith(
        'run-1',
        'success',
        expect.objectContaining({ fetchedCount: 0 }),
      );
    });

    it('still fails on a transport or auth failure', async () => {
      mashovClient.getForConnection.mockRejectedValue(
        new Error(
          'Upstream GET /api/bells (connection conn-a) failed with status 403: Forbidden',
        ),
      );

      const result = await task.execute();

      expect(result.status).toBe('failed');
      expect(result.summary.failedCount).toBe(1);
      expect(syncRunService.closeRun).toHaveBeenCalledWith(
        'run-1',
        'failed',
        expect.objectContaining({ errorMessage: expect.stringContaining('403') }),
      );
    });
  });

  it('skips a malformed period without failing the run', async () => {
    mashovClient.getForConnection.mockResolvedValue([
      bell(1, '08:15:00', '09:00:00'),
      bell(2, null, '10:00:00'),
      bell('lunch', '10:00:00', '10:20:00'),
      bell(0, '07:00:00', '07:45:00'),
    ]);

    const result = await task.execute();

    expect(result.status).toBe('success');
    expect(result.summary.failedCount).toBe(0);
    expect(prisma.bellSchedule.upsert).toHaveBeenCalledTimes(1);
  });

  it('skips a connection with no usable school year rather than stamping zero', async () => {
    prisma.householdConnection.findMany.mockResolvedValue([
      connection({ schoolYear: null }),
    ]);

    const result = await task.execute();

    expect(mashovClient.getForConnection).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
    expect(result.summary.fetchedCount).toBe(0);
  });

  it('scopes to one connection when the manual refresh names one', async () => {
    await task.execute({ connectionId: 'conn-a' });

    expect(prisma.householdConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'conn-a' }) }),
    );
    expect(syncRunService.openRun).toHaveBeenCalledWith('bells:540175', 'conn-a');
  });
});
