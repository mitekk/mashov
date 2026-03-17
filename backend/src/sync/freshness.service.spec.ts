import { FreshnessService } from './freshness.service';
import { SyncRunService } from './sync-run.service';
import { SyncRun } from '@prisma/client';

// Helper to build a minimal SyncRun with an endedAt offset from now
function makeSyncRun(
  source: string,
  status: 'success' | 'failed' | 'running',
  minutesAgo: number,
): SyncRun {
  const endedAt = new Date(Date.now() - minutesAgo * 60 * 1000);
  return {
    id: `run-${source}-${minutesAgo}`,
    source,
    status,
    startedAt: new Date(endedAt.getTime() - 5000),
    endedAt,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    errorMessage: null,
  } as SyncRun;
}

describe('FreshnessService', () => {
  let service: FreshnessService;
  let mockSyncRunService: jest.Mocked<SyncRunService>;

  beforeEach(() => {
    mockSyncRunService = {
      getLatestSuccessfulRuns: jest.fn(),
      getAllSourceHealth: jest.fn(),
    } as unknown as jest.Mocked<SyncRunService>;

    service = new FreshnessService(mockSyncRunService);
  });

  describe('computeFreshness', () => {
    describe('threshold logic', () => {
      it('returns fresh when notifications were synced within 15 minutes', async () => {
        const successRuns = new Map<string, SyncRun>([
          ['notifications', makeSyncRun('notifications', 'success', 5)],
          ['mail_counts', makeSyncRun('mail_counts', 'success', 5)],
          ['mail_inbox', makeSyncRun('mail_inbox', 'success', 5)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.state).toBe('fresh');
        expect(result.staleSources).not.toContain('notifications');
      });

      it('marks notifications as stale when last sync was more than 15 minutes ago', async () => {
        const successRuns = new Map<string, SyncRun>([
          ['notifications', makeSyncRun('notifications', 'success', 20)],
          ['mail_counts', makeSyncRun('mail_counts', 'success', 20)],
          ['mail_inbox', makeSyncRun('mail_inbox', 'success', 20)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.staleSources).toContain('notifications');
      });

      it('treats homework as stale when last sync was more than 24 hours ago', async () => {
        const minutesIn25h = 25 * 60;
        const successRuns = new Map<string, SyncRun>([
          ['homework:student-1', makeSyncRun('homework:student-1', 'success', minutesIn25h)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.staleSources).toContain('homework');
      });

      it('treats homework as fresh when last sync was within 24 hours', async () => {
        const minutesIn12h = 12 * 60;
        const successRuns = new Map<string, SyncRun>([
          ['homework:student-1', makeSyncRun('homework:student-1', 'success', minutesIn12h)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.staleSources).not.toContain('homework');
      });

      it('treats behavior as stale when last sync was more than 24 hours ago', async () => {
        const minutesIn25h = 25 * 60;
        const successRuns = new Map<string, SyncRun>([
          ['behavior:student-1', makeSyncRun('behavior:student-1', 'success', minutesIn25h)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.staleSources).toContain('behavior');
      });

      it('treats groups as stale when last sync was more than 7 days ago', async () => {
        const minutesIn8Days = 8 * 24 * 60;
        const successRuns = new Map<string, SyncRun>([
          ['groups:student-1', makeSyncRun('groups:student-1', 'success', minutesIn8Days)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.staleSources).toContain('groups');
      });

      it('treats achvas as fresh when last sync was within 7 days', async () => {
        const minutesIn3Days = 3 * 24 * 60;
        const successRuns = new Map<string, SyncRun>([
          ['achvas', makeSyncRun('achvas', 'success', minutesIn3Days)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.staleSources).not.toContain('achvas');
      });
    });

    describe('app-shell state derivation', () => {
      it('returns stale when no sync has ever run', async () => {
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(new Map());
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map());

        const result = await service.computeFreshness();
        expect(result.state).toBe('stale');
        expect(result.lastSyncAt).toBeNull();
      });

      it('returns fresh when all sources are within thresholds', async () => {
        const successRuns = new Map<string, SyncRun>([
          ['notifications', makeSyncRun('notifications', 'success', 5)],
          ['mail_counts', makeSyncRun('mail_counts', 'success', 5)],
          ['mail_inbox', makeSyncRun('mail_inbox', 'success', 5)],
          ['homework:guid', makeSyncRun('homework:guid', 'success', 60)],
          ['behavior:guid', makeSyncRun('behavior:guid', 'success', 60)],
          ['achvas', makeSyncRun('achvas', 'success', 60)],
          ['groups:guid', makeSyncRun('groups:guid', 'success', 60)],
          ['lessons_count:guid', makeSyncRun('lessons_count:guid', 'success', 60)],
          ['user_details', makeSyncRun('user_details', 'success', 60)],
          ['message_board:guid', makeSyncRun('message_board:guid', 'success', 60)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.state).toBe('fresh');
        expect(result.staleSources).toHaveLength(0);
      });

      it('returns stale when one or two sources are stale', async () => {
        const successRuns = new Map<string, SyncRun>([
          ['notifications', makeSyncRun('notifications', 'success', 20)], // stale (>15min)
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.state).toBe('stale');
      });

      it('returns degraded when there are failures and more than 2 stale sources', async () => {
        // 3+ stale sources with failures
        const now = new Date();
        const staleRun = (source: string) =>
          makeSyncRun(source, 'success', 25 * 60); // 25h ago = stale for mail

        const successRuns = new Map<string, SyncRun>([
          ['notifications', staleRun('notifications')],
          ['mail_counts', staleRun('mail_counts')],
          ['mail_inbox', staleRun('mail_inbox')],
        ]);

        const failedRun: SyncRun = {
          id: 'run-failed',
          source: 'notifications',
          status: 'failed',
          startedAt: new Date(now.getTime() - 1000),
          endedAt: new Date(now.getTime() - 500),
          fetchedCount: null,
          createdCount: null,
          updatedCount: null,
          errorMessage: 'timeout',
        } as SyncRun;

        const allRuns = new Map<string, SyncRun>([
          ...successRuns,
          ['notifications', failedRun],
        ]);

        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(allRuns);

        const result = await service.computeFreshness();
        expect(result.state).toBe('degraded');
      });

      it('uses best-wins: fresh when a fresh per-connection key exists alongside a stale bare key', async () => {
        // Regression: shared-session run (bare key, 3h ago) + per-connection run (1min ago)
        // should resolve to fresh, not stale.
        const successRuns = new Map<string, SyncRun>([
          ['mail_counts', makeSyncRun('mail_counts', 'success', 3 * 60)],         // stale bare key
          ['mail_counts:conn-abc', makeSyncRun('mail_counts:conn-abc', 'success', 1)], // fresh connection key
          ['mail_inbox', makeSyncRun('mail_inbox', 'success', 3 * 60)],            // stale bare key
          ['mail_inbox:conn-abc', makeSyncRun('mail_inbox:conn-abc', 'success', 1)],   // fresh connection key
          ['notifications', makeSyncRun('notifications', 'success', 1)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.staleSources).not.toContain('mail_counts');
        expect(result.staleSources).not.toContain('mail_inbox');
        expect(result.state).toBe('fresh');
      });

      it('uses best-wins: still stale when all per-connection keys are also stale', async () => {
        const successRuns = new Map<string, SyncRun>([
          ['mail_counts', makeSyncRun('mail_counts', 'success', 3 * 60)],
          ['mail_counts:conn-abc', makeSyncRun('mail_counts:conn-abc', 'success', 2 * 60)],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.staleSources).toContain('mail_counts');
      });

      it('includes lastSyncAt from the most recent successful run', async () => {
        const recentRun = makeSyncRun('notifications', 'success', 5);
        const olderRun = makeSyncRun('mail_inbox', 'success', 10);
        const successRuns = new Map<string, SyncRun>([
          ['notifications', recentRun],
          ['mail_inbox', olderRun],
        ]);
        mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
        mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

        const result = await service.computeFreshness();
        expect(result.lastSyncAt).toBe(recentRun.endedAt!.toISOString());
      });
    });
  });

  describe('getAllSourceHealth', () => {
    it('returns never_synced status when no runs exist for a source', async () => {
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map());
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(new Map());

      const results = await service.getAllSourceHealth([]);
      const notificationsHealth = results.find((r) => r.source === 'notifications');
      expect(notificationsHealth).toBeDefined();
      expect(notificationsHealth?.status).toBe('never_synced');
    });

    it('returns fresh status when last success was within threshold', async () => {
      const successRun = makeSyncRun('notifications', 'success', 5);
      const successRuns = new Map([['notifications', successRun]]);
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

      const results = await service.getAllSourceHealth([]);
      const health = results.find((r) => r.source === 'notifications');
      expect(health?.status).toBe('fresh');
      expect(health?.staleThresholdMinutes).toBe(15);
    });

    it('returns stale status when last success exceeded the threshold', async () => {
      const staleRun = makeSyncRun('notifications', 'success', 30);
      const successRuns = new Map([['notifications', staleRun]]);
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

      const results = await service.getAllSourceHealth([]);
      const health = results.find((r) => r.source === 'notifications');
      expect(health?.status).toBe('stale');
    });

    it('returns failed status when latest run failed and no successful run exists', async () => {
      const failedRun = makeSyncRun('notifications', 'failed', 5);
      failedRun.errorMessage = 'network error';
      const allRuns = new Map([['notifications', failedRun]]);
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(allRuns);
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(new Map());

      const results = await service.getAllSourceHealth([]);
      const health = results.find((r) => r.source === 'notifications');
      expect(health?.status).toBe('failed');
      expect(health?.lastErrorMessage).toBe('network error');
    });

    it('resolves fresh when only a per-connection variant key exists (no bare key)', async () => {
      // Regression: mail tasks write mail_counts:{conn.id}; bare mail_counts may not exist.
      const freshConnRun = makeSyncRun('mail_counts:conn-abc', 'success', 5);
      const successRuns = new Map([['mail_counts:conn-abc', freshConnRun]]);
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

      const results = await service.getAllSourceHealth([]);
      const health = results.find((r) => r.source === 'mail_counts');
      expect(health?.status).toBe('fresh');
      expect(health?.lastSuccessAt).toBe(freshConnRun.endedAt!.toISOString());
    });

    it('resolves stale bare key to fresh when a fresher per-connection key exists', async () => {
      const staleBarRun = makeSyncRun('mail_counts', 'success', 3 * 60);
      const freshConnRun = makeSyncRun('mail_counts:conn-abc', 'success', 5);
      const successRuns = new Map<string, SyncRun>([
        ['mail_counts', staleBarRun],
        ['mail_counts:conn-abc', freshConnRun],
      ]);
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

      const results = await service.getAllSourceHealth([]);
      const health = results.find((r) => r.source === 'mail_counts');
      expect(health?.status).toBe('fresh');
    });

    it('includes per-student sources when studentGuids are provided', async () => {
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map());
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(new Map());

      const studentGuids = ['student-abc', 'student-xyz'];
      const results = await service.getAllSourceHealth(studentGuids);

      const sources = results.map((r) => r.source);
      expect(sources).toContain('homework:student-abc');
      expect(sources).toContain('homework:student-xyz');
      expect(sources).toContain('behavior:student-abc');
      expect(sources).toContain('groups:student-xyz');
    });
  });
});
