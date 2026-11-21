import { ReleasesTask } from './releases.task';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';

/**
 * R11's seventh hole.
 *
 * Eight of the nine per-student tasks throw `every connection failed for
 * <guid>` when no connection answered, which closes that child's run `failed`.
 * `ReleasesTask` had no such guard: `items` stayed `[]`, so it closed the run
 * `success` with `fetchedCount: 0` per child and returned `status: 'success'`.
 *
 * That is worse than the six connection-loop tasks R11 names, which at least
 * left no row at all: a `success` row under `releases:<guid>` is what
 * `FreshnessService.getAllSourceHealth` reads as a FRESH `releases` source, so
 * a real outage is undiagnosable in exactly the window R11 is about.
 */

const CONN_A = {
  id: 'conn-a',
  userId: 'user-1',
  schoolCode: 540175,
  schoolYear: 2026,
  username: 'parent-a',
  encryptedPassword: 'enc',
};

const CHILD = {
  studentGuid: 'guid-1',
  householdConnectionId: 'conn-a',
};

describe('ReleasesTask', () => {
  let task: ReleasesTask;
  let mashovClient: { get: jest.Mock; getForConnection: jest.Mock };
  let prisma: {
    householdConnection: { findMany: jest.Mock };
    student: { findMany: jest.Mock; update: jest.Mock };
    studentConnection: { upsert: jest.Mock };
    studentRelease: { upsert: jest.Mock };
  };
  let syncRunService: { openRun: jest.Mock; closeRun: jest.Mock };

  beforeEach(() => {
    mashovClient = {
      get: jest.fn().mockResolvedValue([]),
      getForConnection: jest.fn().mockResolvedValue([]),
    };
    prisma = {
      householdConnection: { findMany: jest.fn().mockResolvedValue([CONN_A]) },
      student: {
        findMany: jest.fn().mockResolvedValue([{ ...CHILD }]),
        update: jest.fn().mockResolvedValue({}),
      },
      studentConnection: { upsert: jest.fn().mockResolvedValue({}) },
      studentRelease: { upsert: jest.fn().mockResolvedValue({}) },
    };
    syncRunService = {
      openRun: jest.fn().mockResolvedValue({ id: 'run-1' }),
      closeRun: jest.fn().mockResolvedValue({ id: 'run-1' }),
    };

    task = new ReleasesTask(
      mashovClient as unknown as MashovHttpClient,
      prisma as unknown as PrismaService,
      syncRunService as unknown as SyncRunService,
      { decrypt: jest.fn().mockReturnValue('pw') } as unknown as EncryptionService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('closes a successful fetch success, even when the child has filed nothing', async () => {
    // The guard below must not fire on an empty 200: a child with no release
    // requests is the common case, and the connection did answer.
    const result = await task.execute({ connectionId: 'conn-a' });

    expect(result.status).toBe('success');
    expect(syncRunService.closeRun).toHaveBeenCalledWith(
      'run-1',
      'success',
      expect.objectContaining({ fetchedCount: 0 }),
    );
  });

  describe('when no connection answered for a child', () => {
    it('closes that child run failed rather than success', async () => {
      // R11's own scenario: `POST /sync/refresh?schoolId=X` races a
      // deactivation. `connections` comes back empty, the child's links
      // survive the deactivation so they are still in `students`, and
      // `ordered` is `[]` -- so the fetch loop body never ran at all.
      prisma.householdConnection.findMany.mockResolvedValue([]);

      const result = await task.execute({ connectionId: 'conn-a' });

      expect(result.status).toBe('failed');
      expect(result.summary.failedCount).toBe(1);
      expect(syncRunService.closeRun).toHaveBeenCalledWith(
        'run-1',
        'failed',
        expect.objectContaining({ errorMessage: expect.stringContaining('guid-1') }),
      );
    });

    it('does not leave a green run for FreshnessService to read as a fresh source', async () => {
      prisma.householdConnection.findMany.mockResolvedValue([]);

      await task.execute({ connectionId: 'conn-a' });

      expect(syncRunService.closeRun).not.toHaveBeenCalledWith(
        'run-1',
        'success',
        expect.anything(),
      );
    });

    it('fails the child when every connection threw, not only when there were none', async () => {
      // The same hole on the global cron path: three 403s in a row left
      // `items` at `[]` and closed the run green.
      mashovClient.getForConnection.mockRejectedValue(
        new Error('Request failed with status code 403'),
      );

      const result = await task.execute();

      expect(result.status).toBe('failed');
      expect(syncRunService.closeRun).toHaveBeenCalledWith(
        'run-1',
        'failed',
        expect.objectContaining({ errorMessage: expect.stringContaining('every connection failed') }),
      );
    });

    it('writes no release row', async () => {
      prisma.householdConnection.findMany.mockResolvedValue([]);

      await task.execute({ connectionId: 'conn-a' });

      expect(prisma.studentRelease.upsert).not.toHaveBeenCalled();
    });
  });
});
