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
    it('returns the override when MASHOV_YEAR is set', async () => {
      const service = makeService({ env: { MASHOV_YEAR: '2031' } });

      await expect(service.resolveForSchool(1234)).resolves.toEqual({
        year: 2031,
        source: 'override',
      });
      expect(mockHttp.get).not.toHaveBeenCalled();
    });

    it('ignores an empty override', async () => {
      mockHttp.get.mockResolvedValue({ data: [] });
      const service = makeService({ env: { MASHOV_YEAR: '   ' } });

      const resolved = await service.resolveForSchool(1234);
      expect(resolved.source).not.toBe('override');
      expect(resolved.year).toBe(2027);
    });

    it('ignores a non-numeric override', async () => {
      mockHttp.get.mockResolvedValue({ data: [] });
      const service = makeService({ env: { MASHOV_YEAR: 'next-year' } });

      const resolved = await service.resolveForSchool(1234);
      expect(resolved.source).not.toBe('override');
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
      const service = makeService({ storedYear: 2029 });

      const resolved = await service.resolveForSchool(1234);
      expect(resolved.year).toBe(2029);
      expect(resolved.source).toBe('stored');
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
});
