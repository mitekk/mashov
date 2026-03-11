import { SettingsService } from './settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { SyncRun } from '@prisma/client';

function makeSyncRun(source: string, status: string, startedAt: Date): SyncRun {
  return {
    id: `run-${source}`,
    source,
    status,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 5000),
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    errorMessage: status === 'failed' ? 'timeout error' : null,
  } as SyncRun;
}

function makeMockPrisma(overrides: Partial<{
  syncRunFindMany: jest.Mock;
  parentProfileFindFirst: jest.Mock;
}>): jest.Mocked<PrismaService> {
  return {
    syncRun: {
      findMany: overrides.syncRunFindMany ?? jest.fn().mockResolvedValue([]),
    },
    parentProfile: {
      findFirst: overrides.parentProfileFindFirst ?? jest.fn().mockResolvedValue(null),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

describe('SettingsService', () => {
  describe('getSourceHealth', () => {
    it('returns an empty array when there are no sync runs', async () => {
      const service = new SettingsService(makeMockPrisma({}));
      const result = await service.getSourceHealth();
      expect(result).toEqual([]);
    });

    it('returns the latest run per source', async () => {
      const runs = [
        makeSyncRun('notifications', 'success', new Date('2026-03-11T10:00:00Z')),
        makeSyncRun('notifications', 'failed', new Date('2026-03-11T09:00:00Z')),
        makeSyncRun('mail_inbox', 'success', new Date('2026-03-11T10:00:00Z')),
      ];

      const service = new SettingsService(
        makeMockPrisma({ syncRunFindMany: jest.fn().mockResolvedValue(runs) }),
      );

      const result = await service.getSourceHealth();
      // Should return 2 entries (one per source)
      expect(result).toHaveLength(2);
    });

    it('deduplicates sources — first occurrence (most recent by startedAt) wins', async () => {
      const recentSuccess = makeSyncRun('notifications', 'success', new Date('2026-03-11T10:00:00Z'));
      const olderFailed = makeSyncRun('notifications', 'failed', new Date('2026-03-10T10:00:00Z'));

      const service = new SettingsService(
        makeMockPrisma({
          syncRunFindMany: jest.fn().mockResolvedValue([recentSuccess, olderFailed]),
        }),
      );

      const result = await service.getSourceHealth();
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('success');
    });

    it('includes errorMessage for failed runs', async () => {
      const failedRun = makeSyncRun('behavior', 'failed', new Date('2026-03-11T10:00:00Z'));

      const service = new SettingsService(
        makeMockPrisma({ syncRunFindMany: jest.fn().mockResolvedValue([failedRun]) }),
      );

      const result = await service.getSourceHealth();
      expect(result[0].errorMessage).toBe('timeout error');
    });

    it('returns null errorMessage for successful runs', async () => {
      const successRun = makeSyncRun('notifications', 'success', new Date('2026-03-11T10:00:00Z'));

      const service = new SettingsService(
        makeMockPrisma({ syncRunFindMany: jest.fn().mockResolvedValue([successRun]) }),
      );

      const result = await service.getSourceHealth();
      expect(result[0].errorMessage).toBeNull();
    });

    it('returns lastRun as ISO string', async () => {
      const run = makeSyncRun('notifications', 'success', new Date('2026-03-11T10:00:00Z'));

      const service = new SettingsService(
        makeMockPrisma({ syncRunFindMany: jest.fn().mockResolvedValue([run]) }),
      );

      const result = await service.getSourceHealth();
      expect(result[0].lastRun).toBe(run.startedAt.toISOString());
    });
  });

  describe('getProfile', () => {
    it('returns the parent profile when one exists', async () => {
      const profile = {
        id: 'profile-1',
        upstreamUserId: 'user-abc',
        displayName: 'John Parent',
        email: 'john@example.com',
        cellphone: '050-000-0000',
        detailsState: 1,
        rawPayload: null,
        updatedAt: new Date(),
      };

      const service = new SettingsService(
        makeMockPrisma({ parentProfileFindFirst: jest.fn().mockResolvedValue(profile) }),
      );

      const result = await service.getProfile();
      expect(result).toBeDefined();
      expect(result?.displayName).toBe('John Parent');
    });

    it('returns null when no parent profile exists', async () => {
      const service = new SettingsService(
        makeMockPrisma({ parentProfileFindFirst: jest.fn().mockResolvedValue(null) }),
      );

      const result = await service.getProfile();
      expect(result).toBeNull();
    });
  });
});
