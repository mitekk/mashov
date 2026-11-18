import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService } from '../sync/freshness.service';
import { SettingsService } from './settings.service';

function makeMockPrisma(overrides: Partial<Record<string, jest.Mock>>) {
  return {
    student: {
      findMany: overrides.studentFindMany ?? jest.fn().mockResolvedValue([]),
    },
    parentProfile: {
      findFirst: overrides.profileFindFirst ?? jest.fn().mockResolvedValue(null),
    },
    householdConnection: {
      findFirst: overrides.householdFindFirst ?? jest.fn().mockResolvedValue(null),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeMockFreshnessService(overrides: Partial<Record<string, jest.Mock>>) {
  return {
    loadSyncRuns:
      overrides.loadSyncRuns ??
      jest.fn().mockResolvedValue({ allRuns: new Map(), successRuns: new Map() }),
    getAllSourceHealth:
      overrides.getAllSourceHealth ?? jest.fn().mockResolvedValue([]),
    computeFreshness:
      overrides.computeFreshness ??
      jest.fn().mockResolvedValue({
        state: 'fresh',
        lastSyncAt: null,
        staleSources: [],
        contentFreshness: {
          expectedSchoolYear: 2027,
          observedSchoolYear: 2027,
          newestContentAt: '2026-11-14T00:00:00.000Z',
          contentAgeDays: 3,
          status: 'current',
        },
      }),
  } as unknown as jest.Mocked<FreshnessService>;
}

describe('SettingsService', () => {
  describe('getSourceHealth', () => {
    it('returns contract shape with sources + overallState + lastFullSyncAt', async () => {
      const service = new SettingsService(
        makeMockPrisma({
          studentFindMany: jest.fn().mockResolvedValue([
            { studentGuid: 'guid-1' },
            { studentGuid: 'guid-2' },
          ]),
        }),
        makeMockFreshnessService({
          getAllSourceHealth: jest.fn().mockResolvedValue([
            {
              source: 'notifications',
              status: 'fresh',
              lastSuccessAt: '2026-03-12T10:00:00Z',
              lastAttemptAt: '2026-03-12T10:00:00Z',
              lastErrorMessage: null,
              fetchedCount: 4,
              staleThresholdMinutes: 15,
            },
          ]),
          computeFreshness: jest.fn().mockResolvedValue({
            state: 'fresh',
            lastSyncAt: '2026-03-12T10:00:00Z',
            staleSources: [],
          }),
        }),
      );

      const result = await service.getSourceHealth('conn-1');
      expect(result).toEqual({
        sources: expect.any(Array),
        overallState: 'fresh',
        lastFullSyncAt: '2026-03-12T10:00:00Z',
      });
      expect(result.sources).toHaveLength(1);
    });
  });

  describe('getProfile', () => {
    it('returns merged profile + household fields in contract shape', async () => {
      const service = new SettingsService(
        makeMockPrisma({
          profileFindFirst: jest.fn().mockResolvedValue({
            upstreamUserId: 'user-1',
            displayName: 'Parent Name',
            email: 'parent@example.com',
            cellphone: '050-1234567',
            detailsState: 2,
            updatedAt: new Date('2026-03-12T09:00:00Z'),
          }),
          householdFindFirst: jest.fn().mockResolvedValue({
            schoolName: 'Test School',
            schoolYear: 2026,
            schoolCode: 1234,
          }),
        }),
        makeMockFreshnessService({}),
      );

      const result = await service.getProfile();
      expect(result).toEqual({
        upstreamUserId: 'user-1',
        displayName: 'Parent Name',
        email: 'parent@example.com',
        cellphone: '050-1234567',
        schoolName: 'Test School',
        schoolYear: 2026,
        schoolCode: 1234,
        detailsState: 2,
        updatedAt: '2026-03-12T09:00:00.000Z',
      });
    });

    it('returns null when parent profile does not exist', async () => {
      const service = new SettingsService(
        makeMockPrisma({
          profileFindFirst: jest.fn().mockResolvedValue(null),
        }),
        makeMockFreshnessService({}),
      );

      const result = await service.getProfile();
      expect(result).toBeNull();
    });
  });

  describe('getSourceHealth scoping', () => {
    // The leak this method was supposed to close. `student.findMany({ isActive:
    // true })` enumerated every child in the database, and
    // FreshnessService.getAllSourceHealth emits one `<source>:<guid>` entry per
    // guid *unconditionally* -- so foreign child identifiers appeared in the
    // response with status 'never_synced' even when no sync_run row for them
    // existed anywhere. Scoping the sync_run reads alone did nothing about it.
    it('enumerates per-student sources from the caller snapshot, not from every child', async () => {
      const studentFindMany = jest.fn().mockResolvedValue([
        { studentGuid: 'mine-1' },
        { studentGuid: 'a-stranger-child' },
      ]);
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([['homework:mine-1', {}], ['notifications', {}]]),
        successRuns: new Map([['behavior:mine-1', {}]]),
      });

      const service = new SettingsService(
        makeMockPrisma({ studentFindMany }),
        makeMockFreshnessService({ loadSyncRuns, getAllSourceHealth }) as never,
      );

      await service.getSourceHealth('conn-1');

      expect(studentFindMany).not.toHaveBeenCalled();
      expect(getAllSourceHealth).toHaveBeenCalledWith(['mine-1'], expect.anything());
      const [guids] = getAllSourceHealth.mock.calls[0] as [string[]];
      expect(guids).not.toContain('a-stranger-child');
    });

    it('ignores a colon-bearing key that is not a per-student source', async () => {
      // mail_counts writes `mail_counts:<connectionId>` and schoolActivities
      // writes `schoolActivities:<userId>`. Neither suffix is a student guid,
      // and treating them as one would invent per-student rows for them.
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([
          ['mail_counts:conn-1', {}],
          ['schoolActivities:user-9', {}],
          ['history:2025:homework:old-guid', {}],
        ]),
        successRuns: new Map(),
      });

      const service = new SettingsService(
        makeMockPrisma({}),
        makeMockFreshnessService({ loadSyncRuns, getAllSourceHealth }) as never,
      );

      await service.getSourceHealth('conn-1');

      expect(getAllSourceHealth).toHaveBeenCalledWith([], expect.anything());
    });

    // Any signed-in user used to get every household's sources. Per-student
    // source keys embed the student GUID, so that leaked other families'
    // child identifiers through a settings screen.
    it('returns nothing and reads nothing when the caller has no connection', async () => {
      const loadSyncRuns = jest.fn();
      const getAllSourceHealth = jest.fn();
      const computeFreshness = jest.fn();
      const studentFindMany = jest.fn();
      const service = new SettingsService(
        makeMockPrisma({ studentFindMany }),
        makeMockFreshnessService({
          loadSyncRuns,
          getAllSourceHealth,
          computeFreshness,
        }) as never,
      );

      const result = await service.getSourceHealth(null);

      expect(result.sources).toEqual([]);
      expect(result.lastFullSyncAt).toBeNull();
      expect(result.contentFreshness).toBeNull();
      expect(loadSyncRuns).not.toHaveBeenCalled();
      expect(getAllSourceHealth).not.toHaveBeenCalled();
      expect(computeFreshness).not.toHaveBeenCalled();
      expect(studentFindMany).not.toHaveBeenCalled();
    });
  });

  describe('getSourceHealth connection use', () => {
    // Each of these maps was formerly fetched twice -- once here and again
    // inside computeFreshness -- so one response made four full reads of an
    // unbounded table, held four pool connections, and timed out the request.
    it('loads the sync_run maps once and shares them with both reads', async () => {
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([['homework:guid-1', {}]]),
        successRuns: new Map(),
      });
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const computeFreshness = jest.fn().mockResolvedValue({
        state: 'fresh',
        lastSyncAt: null,
        staleSources: [],
        contentFreshness: {
          expectedSchoolYear: 2027,
          observedSchoolYear: 2027,
          newestContentAt: null,
          contentAgeDays: null,
          status: 'no_content',
        },
      });

      const service = new SettingsService(
        makeMockPrisma({}),
        makeMockFreshnessService({
          loadSyncRuns,
          getAllSourceHealth,
          computeFreshness,
        }) as never,
      );

      await service.getSourceHealth('conn-1');

      expect(loadSyncRuns).toHaveBeenCalledTimes(1);
      expect(loadSyncRuns).toHaveBeenCalledWith('conn-1');
      const snapshot = await loadSyncRuns.mock.results[0].value;
      expect(getAllSourceHealth).toHaveBeenCalledWith(['guid-1'], snapshot);
      expect(computeFreshness).toHaveBeenCalledWith(snapshot);
    });
  });
});
