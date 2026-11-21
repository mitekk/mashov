import axios from 'axios';
import { SchoolYearService, calendarSchoolYear } from './school-year.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockHttp = {
  get: jest.fn(),
  post: jest.fn(),
  interceptors: { request: { use: jest.fn() } },
};

function makeService(options: {
  env?: Record<string, string | undefined>;
  storedYear?: number | null;
}) {
  const config = {
    get: jest.fn((key: string) => options.env?.[key]),
  } as unknown as ConfigService;

  const prisma = {
    householdConnection: {
      findFirst: jest.fn().mockResolvedValue(
        options.storedYear === null || options.storedYear === undefined
          ? null
          : { schoolYear: options.storedYear },
      ),
    },
  } as unknown as PrismaService;

  return new SchoolYearService(config, prisma);
}

describe('calendarSchoolYear', () => {
  it('treats September as the next school year', () => {
    expect(calendarSchoolYear(new Date(2026, 8, 1))).toBe(2027);
  });

  it('treats August as the previous school year', () => {
    expect(calendarSchoolYear(new Date(2026, 7, 31))).toBe(2026);
  });

  it('treats June as the year that is ending', () => {
    expect(calendarSchoolYear(new Date(2026, 5, 28))).toBe(2026);
  });
});

describe('SchoolYearService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.setSystemTime(new Date(2026, 10, 17));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('resolveForSchool', () => {
    it('does not let MASHOV_YEAR change the resolved current year', async () => {
      // MASHOV_YEAR is the earliest year to fetch, not the year in scope.
      // Honouring it here is the frozen-year condition this service exists to
      // prevent, and production has carried a stale value for months.
      mockHttp.get.mockResolvedValue({ data: [] });
      const service = makeService({ env: { MASHOV_YEAR: '2031' } });

      await expect(service.resolveForSchool(1234)).resolves.toEqual({
        year: 2027,
        source: 'calendar',
      });
      expect(mockHttp.get).toHaveBeenCalled();
    });

    it('resolves the current year from the calendar when MASHOV_YEAR is far in the past', async () => {
      mockHttp.get.mockResolvedValue({ data: [] });
      const service = makeService({ env: { MASHOV_YEAR: '2019' } });

      const resolved = await service.resolveForSchool(1234);

      expect(resolved.year).toBe(2027);
    });

    it('returns the highest year the schools API reports for the semel', async () => {
      mockHttp.get.mockResolvedValue({
        data: [
          { semel: 9999, name: 'Other', years: [2030] },
          { semel: 1234, name: 'Ours', years: [2025, 2028, 2026] },
        ],
      });
      const service = makeService({});

      await expect(service.resolveForSchool(1234)).resolves.toEqual({
        year: 2028,
        source: 'schools-api',
      });
    });

    it('prefers the calendar year when the schools API lags behind it', async () => {
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 1234, name: 'Ours', years: [2024, 2025] }],
      });
      const service = makeService({});

      await expect(service.resolveForSchool(1234)).resolves.toEqual({
        year: 2027,
        source: 'calendar',
      });
    });

    it('never publishes a year more than one ahead of the calendar year', async () => {
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 1234, name: 'Ours', years: [2099] }],
      });
      const service = makeService({});

      const resolved = await service.resolveForSchool(1234);
      expect(resolved.year).toBe(2028);
    });

    it('falls back to the calendar year when the schools API is unreachable', async () => {
      mockHttp.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const service = makeService({});

      await expect(service.resolveForSchool(1234)).resolves.toEqual({
        year: 2027,
        source: 'calendar',
      });
    });

    it('never regresses below the stored connection year', async () => {
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 1234, name: 'Ours', years: [2024] }],
      });
      // 2028 is the ceiling (calendar 2027 + 1), so this is a legitimate
      // connection already correctly on next year.
      const service = makeService({ storedYear: 2028 });

      const resolved = await service.resolveForSchool(1234);
      expect(resolved.year).toBe(2028);
      expect(resolved.source).toBe('stored');
    });

    it('clamps a stored year that is itself absurd', async () => {
      // A fat-fingered hotfix UPDATE (`schoolYear = 2072`) must not pin every
      // connection at that school to a year with no data and no way back: the
      // rollover task will not walk a stored year down, so an unclamped stored
      // value is irreversible without a second manual UPDATE and a restart.
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 1234, name: 'Ours', years: [2027] }],
      });
      const service = makeService({ storedYear: 2072 });

      const resolved = await service.resolveForSchool(1234);
      expect(resolved.year).toBe(2028);
    });

    it('caches the resolution per semel within the TTL', async () => {
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 1234, name: 'Ours', years: [2027] }],
      });
      const service = makeService({});

      await service.resolveForSchool(1234);
      await service.resolveForSchool(1234);

      expect(mockHttp.get).toHaveBeenCalledTimes(1);
    });

    it('re-fetches once the cache TTL has elapsed', async () => {
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 1234, name: 'Ours', years: [2027] }],
      });
      const service = makeService({});

      await service.resolveForSchool(1234);
      jest.setSystemTime(new Date(2026, 10, 17, 7));
      await service.resolveForSchool(1234);

      expect(mockHttp.get).toHaveBeenCalledTimes(2);
    });

    it('forgets a cached resolution when invalidated', async () => {
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 1234, name: 'Ours', years: [2027] }],
      });
      const service = makeService({});

      await service.resolveForSchool(1234);
      service.invalidate(1234);
      await service.resolveForSchool(1234);

      expect(mockHttp.get).toHaveBeenCalledTimes(2);
    });

    it('does not share a cache entry between two schools', async () => {
      mockHttp.get.mockResolvedValue({
        data: [
          { semel: 1234, name: 'Ours', years: [2027] },
          { semel: 5678, name: 'Theirs', years: [2028] },
        ],
      });
      const service = makeService({});

      await expect(service.resolveForSchool(1234)).resolves.toMatchObject({ year: 2027 });
      await expect(service.resolveForSchool(5678)).resolves.toMatchObject({ year: 2028 });
    });
  });

  describe('reconcileFromLogin', () => {
    it('keeps the candidate when the login response agrees with it', () => {
      const service = makeService({});

      expect(
        service.reconcileFromLogin(2027, {
          credential: { year: 2027 },
          accessToken: {
            schoolSettings: { schoolYear: 2027 },
            userSchoolYears: [2026, 2027],
          },
        }),
      ).toEqual({ year: 2027, changed: false });
    });

    it('prefers the active year Mashov reports over the candidate that was sent', () => {
      const service = makeService({});

      expect(
        service.reconcileFromLogin(2028, {
          credential: { year: 2028 },
          accessToken: {
            schoolSettings: { schoolYear: 2027 },
            userSchoolYears: [2026, 2027],
          },
        }),
      ).toEqual({ year: 2027, changed: true });
    });

    it('falls back to the greatest enrolled year at or below the school year', () => {
      const service = makeService({});

      expect(
        service.reconcileFromLogin(2028, {
          credential: { year: 2028 },
          accessToken: {
            schoolSettings: { schoolYear: 2028 },
            userSchoolYears: [2025, 2026],
          },
        }),
      ).toEqual({ year: 2026, changed: true });
    });

    it('falls back to the credential year when schoolSettings carries none', () => {
      const service = makeService({});

      expect(
        service.reconcileFromLogin(2028, {
          credential: { year: 2027 },
          accessToken: {},
        }),
      ).toEqual({ year: 2027, changed: true });
    });

    it('keeps the candidate when the login response carries no year at all', () => {
      const service = makeService({});

      expect(service.reconcileFromLogin(2027, {})).toEqual({
        year: 2027,
        changed: false,
      });
    });
  });

  describe('schoolNameFor', () => {
    // T13 finding 1. School B's Mashov login omits
    // `schoolSettings.schoolName`, so every writer stored null and the
    // `?? String(schoolCode)` fallbacks made the chip and the contact card read
    // `484121`. The name was in the public `/api/schools` list all along — the
    // sign-in form loads it to populate the picker — and this service already
    // fetches that list on every login to resolve the year.
    it('returns the name the public school list carries', async () => {
      mockHttp.get.mockResolvedValue({
        data: [
          { semel: 484121, name: 'חטיבת נעורים בראשית - צור יצחק (חטב)', years: [2027] },
          { semel: 482273, name: 'יצחק נבון - צור יצחק (יסודי)', years: [2027] },
        ],
      });
      const service = makeService({});

      await expect(service.schoolNameFor(484121)).resolves.toBe(
        'חטיבת נעורים בראשית - צור יצחק (חטב)',
      );
    });

    it('serves a resolved semel from the cache without a second HTTP call', async () => {
      // The whole point of putting this here: no new upstream call per login.
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 484121, name: 'בית ספר ב', years: [2027] }],
      });
      const service = makeService({});

      await service.resolveForSchool(484121);
      const callsAfterResolve = mockHttp.get.mock.calls.length;

      await expect(service.schoolNameFor(484121)).resolves.toBe('בית ספר ב');
      expect(mockHttp.get).toHaveBeenCalledTimes(callsAfterResolve);
    });

    it('returns null when the list is unavailable', async () => {
      mockHttp.get.mockRejectedValue(new Error('upstream down'));
      const service = makeService({});

      await expect(service.schoolNameFor(484121)).resolves.toBeNull();
    });

    it('returns null when the list has no entry for the semel', async () => {
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 482273, name: 'בית ספר א', years: [2027] }],
      });
      const service = makeService({});

      await expect(service.schoolNameFor(484121)).resolves.toBeNull();
    });

    it('returns null for an entry whose name is blank', async () => {
      // A blank name is worse than the semel: `?? String(schoolCode)` would not
      // fire on an empty string, so the chip would render nothing at all.
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 484121, name: '   ', years: [2027] }],
      });
      const service = makeService({});

      await expect(service.schoolNameFor(484121)).resolves.toBeNull();
    });

    it('drops the cached name when the semel is invalidated', async () => {
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 484121, name: 'בית ספר ב', years: [2027] }],
      });
      const service = makeService({});

      await service.schoolNameFor(484121);
      service.invalidate(484121);
      mockHttp.get.mockResolvedValue({
        data: [{ semel: 484121, name: 'השם החדש', years: [2027] }],
      });

      await expect(service.schoolNameFor(484121)).resolves.toBe('השם החדש');
    });
  });
});
