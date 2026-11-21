import { FreshnessService } from './freshness.service';
import { SyncRunService } from './sync-run.service';
import { SyncRun } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { SchoolYearService } from '../common/school-year/school-year.service';

/** 2026-11-17 is mid-2026/27; Mashov names that year 2027. */
const NOW = new Date('2026-11-17T12:00:00Z');

function makeMockPrisma(options: {
  connection?: { schoolCode: number; schoolYear: number } | null;
  /** Several schools, for the worst-state cases. */
  connections?: Array<{ id: string; schoolCode: number; schoolYear: number }>;
  newestHomeworkAt?: Date | null;
  newestBehaviorAt?: Date | null;
} = {}) {
  return {
    householdConnection: {
      findFirst: jest.fn().mockResolvedValue(
        options.connection === undefined
          ? { schoolCode: 1234, schoolYear: 2027 }
          : options.connection,
      ),
      // Content freshness is computed per connection and reported at its
      // worst, so it lists them rather than resolving one.
      findMany: jest.fn().mockResolvedValue(
        options.connections ??
          (options.connection === undefined
            ? [{ id: 'conn-1', schoolCode: 1234, schoolYear: 2027 }]
            : options.connection === null
              ? []
              : [{ id: 'conn-1', ...options.connection }]),
      ),
    },
    student: {
      findMany: jest.fn().mockResolvedValue([{ studentGuid: 'stu-1' }]),
    },
    homeworkItem: {
      aggregate: jest.fn().mockResolvedValue({
        _max: { lessonDate: options.newestHomeworkAt ?? null },
      }),
    },
    behaviorItem: {
      aggregate: jest.fn().mockResolvedValue({
        _max: { eventAt: options.newestBehaviorAt ?? null },
      }),
    },
  } as unknown as PrismaService;
}

function makeMockSchoolYear(resolvedYear = 2027) {
  return {
    resolveForSchool: jest
      .fn()
      .mockResolvedValue({ year: resolvedYear, source: 'calendar' }),
  } as unknown as SchoolYearService;
}

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
    upstreamCount: null,
    localCount: null,
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

    service = new FreshnessService(
      mockSyncRunService,
      makeMockPrisma(),
      makeMockSchoolYear(),
    );
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
          upstreamCount: null,
          localCount: null,
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

  describe('loadSyncRuns', () => {
    it('passes the caller connection down to both reads', async () => {
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map());
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(new Map());

      await service.loadSyncRuns('conn-1');

      expect(mockSyncRunService.getAllSourceHealth).toHaveBeenCalledWith('conn-1');
      expect(mockSyncRunService.getLatestSuccessfulRuns).toHaveBeenCalledWith('conn-1');
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

    it('does not let a completed historical year make a stale live source look fresh', async () => {
      // Variant matching treats `homework:<anything>` as a fresh `homework`
      // success. A backfill named `homework:<guid>:2026` would therefore hide
      // a broken current-year homework sync — PR #8's blindness by a new
      // route. The `history:<year>:` prefix is what keeps it invisible here.
      const staleLive = makeSyncRun('homework:stu-1', 'success', 48 * 60);
      const freshHistory = makeSyncRun('history:2026:homework:stu-1', 'success', 1);
      const successRuns = new Map([
        ['homework:stu-1', staleLive],
        ['history:2026:homework:stu-1', freshHistory],
      ]);
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

      const results = await service.getAllSourceHealth(['stu-1']);

      expect(results.find((r) => r.source === 'homework:stu-1')?.status).toBe('stale');
      expect(results.some((r) => r.source.startsWith('history:'))).toBe(false);
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

    it('reports students stale when the last roster sync is older than 24 hours', async () => {
      const successRuns = new Map<string, SyncRun>([
        ['students', makeSyncRun('students', 'success', 25 * 60)],
      ]);
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

      const results = await service.getAllSourceHealth([]);
      const health = results.find((r) => r.source === 'students');
      expect(health?.status).toBe('stale');
      expect(health?.staleThresholdMinutes).toBe(24 * 60);
    });

    it('reports students fresh inside 24 hours', async () => {
      const successRuns = new Map<string, SyncRun>([
        ['students', makeSyncRun('students', 'success', 30)],
      ]);
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

      const results = await service.getAllSourceHealth([]);
      expect(results.find((r) => r.source === 'students')?.status).toBe('fresh');
    });

    it('does not fan students out into per-student variants', async () => {
      mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map());
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(new Map());

      const results = await service.getAllSourceHealth(['stu-1', 'stu-2']);
      expect(results.filter((r) => r.source.startsWith('students'))).toHaveLength(1);
    });

    it('does not carry an unstamped failure’s error onto a row a scoped success made fresh', async () => {
      // T13 finding 3. `sync_run` holds a NULL-connection `failed` row under the
      // bare source name, from a cron tick that ran before any connection
      // existed; the branch-wide NULL rule admits it into every connection's
      // snapshot. `status` came from the success variants and `lastErrorMessage`
      // from the bare key, so the row read `fresh` with the orphan's error text
      // underneath it — on a shared deployment, to every household.
      const orphanFailure = makeSyncRun('mail_inbox', 'failed', 60);
      orphanFailure.errorMessage = 'Missing required Mashov credentials in environment variables';
      const scopedSuccess = makeSyncRun('mail_inbox:conn-abc', 'success', 5);

      mockSyncRunService.getAllSourceHealth.mockResolvedValue(
        new Map<string, SyncRun>([
          ['mail_inbox', orphanFailure],
          ['mail_inbox:conn-abc', scopedSuccess],
        ]),
      );
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(
        new Map<string, SyncRun>([['mail_inbox:conn-abc', scopedSuccess]]),
      );

      const health = (await service.getAllSourceHealth([])).find(
        (r) => r.source === 'mail_inbox',
      );

      expect(health?.status).toBe('fresh');
      expect(health?.lastErrorMessage).toBeNull();
      // The attempt comes from the same variant set as the status, so it is the
      // success's own start rather than the orphan's.
      expect(health?.lastAttemptAt).toBe(scopedSuccess.startedAt.toISOString());
    });

    it('keeps the error when no success has superseded the failing attempt', async () => {
      // The other half of finding 3's fix: suppressing the error whenever the
      // status is not `failed` would silence a stale-but-failing source, which
      // still has to explain itself.
      const recentFailure = makeSyncRun('mail_inbox', 'failed', 5);
      recentFailure.errorMessage = 'upstream 502';
      const oldSuccess = makeSyncRun('mail_inbox:conn-abc', 'success', 60);

      mockSyncRunService.getAllSourceHealth.mockResolvedValue(
        new Map<string, SyncRun>([
          ['mail_inbox', recentFailure],
          ['mail_inbox:conn-abc', oldSuccess],
        ]),
      );
      mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(
        new Map<string, SyncRun>([['mail_inbox:conn-abc', oldSuccess]]),
      );

      const health = (await service.getAllSourceHealth([])).find(
        (r) => r.source === 'mail_inbox',
      );

      expect(health?.status).toBe('stale');
      expect(health?.lastErrorMessage).toBe('upstream 502');
      expect(health?.lastAttemptAt).toBe(recentFailure.startedAt.toISOString());
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

describe('FreshnessService.computeContentFreshness', () => {
  let mockSyncRunService: jest.Mocked<SyncRunService>;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.setSystemTime(NOW);
    mockSyncRunService = {
      getLatestSuccessfulRuns: jest.fn().mockResolvedValue(new Map()),
      getAllSourceHealth: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<SyncRunService>;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function build(options: Parameters<typeof makeMockPrisma>[0], resolvedYear = 2027) {
    return new FreshnessService(
      mockSyncRunService,
      makeMockPrisma(options),
      makeMockSchoolYear(resolvedYear),
    );
  }

  it('reports current when the connection is on the resolved year with recent content', async () => {
    const service = build({ newestHomeworkAt: new Date('2026-11-14T00:00:00Z') });

    const result = await service.computeContentFreshness();

    expect(result).toMatchObject({
      expectedSchoolYear: 2027,
      observedSchoolYear: 2027,
      status: 'current',
      contentAgeDays: 3,
    });
    expect(result.newestContentAt).toBe('2026-11-14T00:00:00.000Z');
  });

  it('reports stale_year when the connection year is behind the resolved year', async () => {
    const service = build({
      connection: { schoolCode: 1234, schoolYear: 2026 },
      newestHomeworkAt: new Date('2026-11-14T00:00:00Z'),
    });

    await expect(service.computeContentFreshness()).resolves.toMatchObject({
      expectedSchoolYear: 2027,
      observedSchoolYear: 2026,
      status: 'stale_year',
    });
  });

  it('still reports stale_year when only prior-year content exists and the history window is open', async () => {
    // The history window widens lists, never staleness. If MASHOV_YEAR could
    // reach this verdict, a two-year window would make last June's homework
    // count as this year's content and PR #8's only detection mechanism would
    // be gone while its cause stayed fixed.
    process.env.MASHOV_YEAR = '2025';
    try {
      const service = build({ newestHomeworkAt: new Date('2026-06-28T00:00:00Z') });

      await expect(service.computeContentFreshness()).resolves.toMatchObject({
        expectedSchoolYear: 2027,
        status: 'stale_year',
      });
    } finally {
      delete process.env.MASHOV_YEAR;
    }
  });

  it('reports stale_year when the newest content predates the school-year start', async () => {
    // Exactly production: the connection reads 2027 but the newest content is
    // the last school day of 2025/26.
    const service = build({ newestHomeworkAt: new Date('2026-06-28T00:00:00Z') });

    await expect(service.computeContentFreshness()).resolves.toMatchObject({
      status: 'stale_year',
      contentAgeDays: 142,
    });
  });

  it('takes the newer of homework and behaviour as the newest content', async () => {
    const service = build({
      newestHomeworkAt: new Date('2026-11-01T00:00:00Z'),
      newestBehaviorAt: new Date('2026-11-15T00:00:00Z'),
    });

    const result = await service.computeContentFreshness();
    expect(result.newestContentAt).toBe('2026-11-15T00:00:00.000Z');
  });

  it('does not cry stale_year in the first weeks of a new school year', async () => {
    // 5 Sep 2026: the rollover has correctly advanced to 2027 and every sync
    // succeeds, but teachers have posted nothing yet, so the newest item is
    // still last June's. Reporting stale_year here would paint a healthy
    // system red every September — exactly when operators watch this signal.
    jest.setSystemTime(new Date('2026-09-05T12:00:00Z'));
    const service = build({ newestHomeworkAt: new Date('2026-06-28T00:00:00Z') }, 2027);

    const result = await service.computeContentFreshness();

    expect(result.observedSchoolYear).toBe(2027);
    expect(result.status).not.toBe('stale_year');
  });

  it('cries stale_year once the grace period after the year start has passed', async () => {
    jest.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    const service = build({ newestHomeworkAt: new Date('2026-06-28T00:00:00Z') }, 2027);

    await expect(service.computeContentFreshness()).resolves.toMatchObject({
      status: 'stale_year',
    });
  });

  it('holds off on stale_year while the grace window is open, even with the year behind', async () => {
    // Revised: a connection behind the *candidate* year inside the grace window
    // is the correct state, not a fault. `resolveForSchool` jumps on 1
    // September while Mashov may not open the year for weeks, and
    // reconciliation deliberately keeps the connection where Mashov is. The
    // original expectation here degraded the whole dashboard every September.
    jest.setSystemTime(new Date('2026-09-05T12:00:00Z'));
    const service = build(
      {
        connection: { schoolCode: 1234, schoolYear: 2026 },
        newestHomeworkAt: new Date('2026-06-28T00:00:00Z'),
      },
      2027,
    );

    await expect(service.computeContentFreshness()).resolves.toMatchObject({
      status: 'current',
    });
  });

  it('reports no_content when there is nothing to date', async () => {
    const service = build({});

    await expect(service.computeContentFreshness()).resolves.toMatchObject({
      status: 'no_content',
      newestContentAt: null,
      contentAgeDays: null,
    });
  });

  it('falls back to the calendar year when there is no connection', async () => {
    const service = build({ connection: null });

    const result = await service.computeContentFreshness();
    expect(result.expectedSchoolYear).toBe(2027);
    expect(result.observedSchoolYear).toBe(0);
  });

  it('degrades the overall state when the content year is stale even though every sync succeeded', async () => {
    const successRuns = new Map<string, SyncRun>(
      [
        'notifications',
        'mail_counts',
        'mail_inbox',
        'homework',
        'behavior',
        'achvas',
        'groups',
        'lessons_count',
        'user_details',
        'message_board',
        'students',
      ].map((source) => [source, makeSyncRun(source, 'success', 1)]),
    );
    mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
    mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

    const service = build({ newestHomeworkAt: new Date('2026-06-28T00:00:00Z') });

    const result = await service.computeFreshness();

    expect(result.contentFreshness.status).toBe('stale_year');
    expect(result.state).toBe('degraded');
  });

  it('leaves the overall state alone when the content year is current', async () => {
    const successRuns = new Map<string, SyncRun>(
      [
        'notifications',
        'mail_counts',
        'mail_inbox',
        'homework',
        'behavior',
        'achvas',
        'groups',
        'lessons_count',
        'user_details',
        'message_board',
        'students',
      ].map((source) => [source, makeSyncRun(source, 'success', 1)]),
    );
    mockSyncRunService.getLatestSuccessfulRuns.mockResolvedValue(successRuns);
    mockSyncRunService.getAllSourceHealth.mockResolvedValue(new Map(successRuns));

    const service = build({ newestHomeworkAt: new Date('2026-11-14T00:00:00Z') });

    const result = await service.computeFreshness();
    expect(result.state).toBe('fresh');
  });

  it('reports current when the connection year lags inside the new-year grace window', async () => {
    // 20 September: the new school year has started on the calendar but Mashov
    // has not opened it yet, so the connection correctly still sits on the old
    // year. Reporting stale_year here degrades the whole dashboard every
    // September for no reason the family can act on.
    jest.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    const service = build({
      connection: { schoolCode: 1234, schoolYear: 2026 },
      newestHomeworkAt: new Date('2026-06-28T00:00:00Z'),
    });

    await expect(service.computeContentFreshness()).resolves.toMatchObject({
      expectedSchoolYear: 2027,
      observedSchoolYear: 2026,
      status: 'current',
    });
  });

  it('reports stale_year once the new-year grace window has closed', async () => {
    jest.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    const service = build({
      connection: { schoolCode: 1234, schoolYear: 2026 },
      newestHomeworkAt: new Date('2026-06-28T00:00:00Z'),
    });

    await expect(service.computeContentFreshness()).resolves.toMatchObject({
      status: 'stale_year',
    });
  });
});

describe('FreshnessService.computeContentFreshness across two schools', () => {
  /**
   * Content freshness has to be per school and reported at its worst.
   *
   * Reading one connection -- whichever `findFirst` returned -- hides a
   * genuinely stale school behind a healthy one. Measuring both schools'
   * children against one school's expected year does the opposite: a school
   * just linked, with nothing synced yet, drags the whole household to
   * `stale_year` and degrades a dashboard that is fine.
   */
  function makePrisma(
    connections: Array<{ id: string; schoolCode: number; schoolYear: number }>,
    contentByConnection: Record<string, Date | null>,
  ) {
    return {
      householdConnection: {
        findFirst: jest.fn().mockResolvedValue(connections[0] ?? null),
        findMany: jest.fn().mockResolvedValue(connections),
      },
      student: {
        // Keyed off the VISIBILITY predicate, not the routing stamp. The
        // stamp is gone from this query: it answers whose credentials fetched
        // a child, and for a child two parents share that is whichever of
        // them synced last (ADR-0031).
        findMany: jest.fn(({ where }) => {
          const connectionId = connectionIdIn(where);
          return Promise.resolve(
            connectionId ? [{ studentGuid: `stu-${connectionId}` }] : [],
          );
        }),
      },
      homeworkItem: {
        aggregate: jest.fn(({ where }) => {
          const guid: string | undefined = where?.studentGuid?.in?.[0];
          const connectionId = guid?.replace(/^stu-/, '') ?? '';
          return Promise.resolve({
            _max: { lessonDate: contentByConnection[connectionId] ?? null },
          });
        }),
      },
      behaviorItem: {
        aggregate: jest.fn().mockResolvedValue({ _max: { eventAt: null } }),
      },
    } as unknown as PrismaService;
  }

  /**
   * The connection id inside `connectionStudentWhere`'s predicate.
   *
   * `{ OR: [{ links: { some: { householdConnectionId } } }, { links: { none: {} } }] }`
   * — the second branch is the unlinked child, admitted deliberately, and
   * carries no id.
   */
  function connectionIdIn(where: unknown): string | undefined {
    const predicate = where as {
      OR?: Array<{ links?: { some?: { householdConnectionId?: string } } }>;
    };
    return predicate?.OR?.find((branch) => branch.links?.some)?.links?.some
      ?.householdConnectionId;
  }

  const FRESH = new Date(Date.UTC(2026, 10, 10));
  const CONN_CURRENT = { id: 'conn-a', schoolCode: 540175, schoolYear: 2027 };
  const CONN_FROZEN = { id: 'conn-b', schoolCode: 999999, schoolYear: 2025 };

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 10, 18)));
  });
  afterAll(() => jest.useRealTimers());

  it('reports stale_year when one school is on a dead year', async () => {
    const service = new FreshnessService(
      {} as never,
      makePrisma([CONN_CURRENT, CONN_FROZEN], { 'conn-a': FRESH, 'conn-b': FRESH }),
      makeMockSchoolYear(2027),
    );

    const result = await service.computeContentFreshness();

    expect(result.status).toBe('stale_year');
  });

  it('stays current when both schools are on the live year', async () => {
    const service = new FreshnessService(
      {} as never,
      makePrisma([CONN_CURRENT, { ...CONN_FROZEN, schoolYear: 2027 }], {
        'conn-a': FRESH,
        'conn-b': FRESH,
      }),
      makeMockSchoolYear(2027),
    );

    await expect(service.computeContentFreshness()).resolves.toMatchObject({
      status: 'current',
    });
  });

  it('does not let a school with no data yet report as a frozen year', async () => {
    // A school linked this morning has no content. That is "quiet", not
    // "asking for a dead year", and it must not degrade the dashboard for the
    // school that is working.
    const service = new FreshnessService(
      {} as never,
      makePrisma([CONN_CURRENT, { ...CONN_FROZEN, schoolYear: 2027 }], {
        'conn-a': FRESH,
        'conn-b': null,
      }),
      makeMockSchoolYear(2027),
    );

    const result = await service.computeContentFreshness();

    expect(result.status).toBe('no_content');
    // And the household's newest content is still reported, from the school
    // that has some.
    expect(result.newestContentAt).toBe(FRESH.toISOString());
  });

  it('does not hide a stale school behind a healthy one', async () => {
    // The order matters: conn-a is what findFirst would have returned, and it
    // is fine. Reading only it would report `current`.
    const service = new FreshnessService(
      {} as never,
      makePrisma([CONN_CURRENT, CONN_FROZEN], { 'conn-a': FRESH, 'conn-b': FRESH }),
      makeMockSchoolYear(2027),
    );

    await expect(service.computeContentFreshness()).resolves.toMatchObject({
      status: 'stale_year',
    });
  });

  it("lists only the caller's connections, and the whole table without one", async () => {
    // R4's second half. Unscoped, the worst verdict was taken across every
    // active connection in the database, so an unrelated household linking a
    // school this morning -- nothing synced yet -- degraded everyone's card.
    const prisma = makePrisma([CONN_CURRENT], { 'conn-a': FRESH });
    const findMany = prisma.householdConnection.findMany as jest.Mock;
    const service = new FreshnessService({} as never, prisma, makeMockSchoolYear(2027));

    await service.computeContentFreshness('user-a');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true, userId: 'user-a' } }),
    );

    // The caller-less path is the crons and the digest, and stays global.
    await service.computeContentFreshness();
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { active: true } }),
    );
  });

  it('counts a child stamped to the other connection but linked to this one', async () => {
    // The shared-child case, and the thing the stamp got wrong. Two parents at
    // one school list the same child; the child is stamped to whichever synced
    // last, so for the other one `householdConnectionId: conn.id` matched
    // nothing and the verdict was `no_content` -- which outranks `current` and
    // degraded the whole card.
    const prisma = {
      householdConnection: {
        findFirst: jest.fn().mockResolvedValue(CONN_CURRENT),
        findMany: jest.fn().mockResolvedValue([CONN_CURRENT]),
      },
      student: {
        // One row: stamped to conn-b, linked to conn-a. It is returned for
        // the caller's own connection because the LINK says so.
        findMany: jest.fn(({ where }) =>
          Promise.resolve(
            connectionIdIn(where) === 'conn-a' ? [{ studentGuid: 'stu-shared' }] : [],
          ),
        ),
      },
      homeworkItem: {
        aggregate: jest.fn(({ where }) =>
          Promise.resolve({
            _max: {
              lessonDate: where?.studentGuid?.in?.includes('stu-shared') ? FRESH : null,
            },
          }),
        ),
      },
      behaviorItem: {
        aggregate: jest.fn().mockResolvedValue({ _max: { eventAt: null } }),
      },
    } as unknown as PrismaService;
    const service = new FreshnessService({} as never, prisma, makeMockSchoolYear(2027));

    await expect(service.computeContentFreshness('user-a')).resolves.toMatchObject({
      status: 'current',
      newestContentAt: FRESH.toISOString(),
    });
    // And the stamp is not consulted at all: no top-level predicate on it.
    for (const call of (prisma.student.findMany as jest.Mock).mock.calls) {
      expect(call[0].where.householdConnectionId).toBeUndefined();
    }
  });
});
