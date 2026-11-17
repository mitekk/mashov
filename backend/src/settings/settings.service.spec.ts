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

      const result = await service.getSourceHealth();
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
});
