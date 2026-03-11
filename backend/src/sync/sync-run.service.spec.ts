import { SyncRunService } from './sync-run.service';
import { PrismaService } from '../prisma/prisma.service';
import { SyncRun } from '@prisma/client';

function makeSyncRun(overrides?: Partial<SyncRun>): SyncRun {
  return {
    id: 'run-1',
    source: 'notifications',
    status: 'running',
    startedAt: new Date('2026-03-11T10:00:00Z'),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    errorMessage: null,
    ...overrides,
  } as SyncRun;
}

function makeMockPrisma(overrides: Partial<{
  syncRunCreate: jest.Mock;
  syncRunUpdate: jest.Mock;
  syncRunFindFirst: jest.Mock;
  syncRunFindMany: jest.Mock;
}>): jest.Mocked<PrismaService> {
  return {
    syncRun: {
      create: overrides.syncRunCreate ?? jest.fn().mockResolvedValue(makeSyncRun()),
      update: overrides.syncRunUpdate ?? jest.fn().mockResolvedValue(makeSyncRun()),
      findFirst: overrides.syncRunFindFirst ?? jest.fn().mockResolvedValue(null),
      findMany: overrides.syncRunFindMany ?? jest.fn().mockResolvedValue([]),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

describe('SyncRunService', () => {
  describe('openRun', () => {
    it('creates a sync run record with status=running', async () => {
      const mockCreate = jest.fn().mockResolvedValue(makeSyncRun());
      const service = new SyncRunService(makeMockPrisma({ syncRunCreate: mockCreate }));

      await service.openRun('notifications');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: 'notifications',
            status: 'running',
            startedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('returns the created SyncRun', async () => {
      const expected = makeSyncRun({ id: 'run-abc' });
      const service = new SyncRunService(
        makeMockPrisma({ syncRunCreate: jest.fn().mockResolvedValue(expected) }),
      );

      const result = await service.openRun('notifications');
      expect(result.id).toBe('run-abc');
      expect(result.status).toBe('running');
    });
  });

  describe('closeRun', () => {
    it('closes the run with success status and counts', async () => {
      const mockUpdate = jest.fn().mockResolvedValue(makeSyncRun({ status: 'success', fetchedCount: 10 }));
      const service = new SyncRunService(makeMockPrisma({ syncRunUpdate: mockUpdate }));

      await service.closeRun('run-1', 'success', { fetchedCount: 10, createdCount: 5, updatedCount: 5 });

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: expect.objectContaining({
            status: 'success',
            endedAt: expect.any(Date),
            fetchedCount: 10,
          }),
        }),
      );
    });

    it('closes the run with failed status and error message', async () => {
      const mockUpdate = jest.fn().mockResolvedValue(makeSyncRun({ status: 'failed' }));
      const service = new SyncRunService(makeMockPrisma({ syncRunUpdate: mockUpdate }));

      await service.closeRun('run-1', 'failed', { errorMessage: 'Network timeout' });

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed', errorMessage: 'Network timeout' }),
        }),
      );
    });
  });

  describe('getLatestSuccessfulRun', () => {
    it('returns null when no successful run exists', async () => {
      const service = new SyncRunService(
        makeMockPrisma({ syncRunFindFirst: jest.fn().mockResolvedValue(null) }),
      );

      const result = await service.getLatestSuccessfulRun('notifications');
      expect(result).toBeNull();
    });

    it('returns the latest successful run for the given source', async () => {
      const run = makeSyncRun({ status: 'success', endedAt: new Date() });
      const service = new SyncRunService(
        makeMockPrisma({ syncRunFindFirst: jest.fn().mockResolvedValue(run) }),
      );

      const result = await service.getLatestSuccessfulRun('notifications');
      expect(result?.status).toBe('success');
    });
  });

  describe('getAllSourceHealth', () => {
    it('returns an empty Map when there are no sync runs', async () => {
      const service = new SyncRunService(
        makeMockPrisma({ syncRunFindMany: jest.fn().mockResolvedValue([]) }),
      );

      const result = await service.getAllSourceHealth();
      expect(result.size).toBe(0);
    });

    it('returns only the latest run per source (deduplication by source)', async () => {
      const runs = [
        makeSyncRun({ id: 'run-2', source: 'notifications', status: 'success', startedAt: new Date('2026-03-11T10:00:00Z') }),
        makeSyncRun({ id: 'run-1', source: 'notifications', status: 'failed', startedAt: new Date('2026-03-11T09:00:00Z') }),
        makeSyncRun({ id: 'run-3', source: 'mail_inbox', status: 'success', startedAt: new Date('2026-03-11T10:00:00Z') }),
      ];

      const service = new SyncRunService(
        makeMockPrisma({ syncRunFindMany: jest.fn().mockResolvedValue(runs) }),
      );

      const result = await service.getAllSourceHealth();
      expect(result.size).toBe(2);
      // First occurrence in the ordered array wins
      expect(result.get('notifications')?.id).toBe('run-2');
    });
  });

  describe('getLatestSuccessfulRuns', () => {
    it('returns only successful runs, deduplicated by source', async () => {
      const runs = [
        makeSyncRun({ id: 'run-2', source: 'notifications', status: 'success', endedAt: new Date('2026-03-11T10:00:00Z') }),
        makeSyncRun({ id: 'run-1', source: 'notifications', status: 'success', endedAt: new Date('2026-03-10T10:00:00Z') }),
      ];

      const service = new SyncRunService(
        makeMockPrisma({ syncRunFindMany: jest.fn().mockResolvedValue(runs) }),
      );

      const result = await service.getLatestSuccessfulRuns();
      expect(result.size).toBe(1);
      expect(result.get('notifications')?.id).toBe('run-2');
    });
  });
});
