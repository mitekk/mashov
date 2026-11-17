import axios from 'axios';
import { MashovSessionService } from './mashov-session.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { EncryptionService } from './encryption.service';
import type { SchoolYearService } from '../common/school-year/school-year.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockHttp = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  interceptors: { request: { use: jest.fn() } },
};

const LOGIN_COOKIES = [
  'Csrf-Token=csrf-1; Path=/',
  'MashovAuthToken=auth-1; Path=/',
  'uniquId=uniq-1; Path=/',
];

function loginPayload(
  children: unknown[],
  extra: Record<string, unknown> = {},
): { data: unknown; headers: Record<string, string[]> } {
  return {
    data: {
      credential: { userId: 'parent-1', displayName: 'Parent', semel: 1234, year: 2027 },
      accessToken: {
        userSettings: { detailsState: 1 },
        schoolSettings: { schoolName: 'School', schoolYear: 2027 },
        children,
        username: 'parent',
        ...extra,
      },
    },
    headers: { 'set-cookie': LOGIN_COOKIES },
  };
}

const CHILD = {
  childGuid: 'child-1',
  familyName: 'Cohen',
  privateName: 'Avi',
  classCode: 'ז',
  classNum: 3,
  gender: 'M',
  groups: [1, 2],
};

const CONNECTION = {
  id: 'conn-1',
  schoolCode: 1234,
  schoolYear: 2027,
  username: 'parent',
  encryptedPassword: 'enc-pw',
  mashovUniqueId: 'uniq-0',
  userId: 'user-1',
};

interface Harness {
  service: MashovSessionService;
  prisma: {
    student: {
      upsert: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    householdConnection: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
    };
    syncRun: { findFirst: jest.Mock; create: jest.Mock };
  };
}

function makeHarness(
  options: {
    connection?: unknown;
    lastStudentsRunEndedAt?: Date | null;
    reconcile?: jest.Mock;
  } = {},
): Harness {
  const prisma = {
    student: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    householdConnection: {
      findFirst: jest.fn().mockResolvedValue(
        options.connection === undefined ? CONNECTION : options.connection,
      ),
      findUnique: jest.fn().mockResolvedValue(
        options.connection === undefined ? CONNECTION : options.connection,
      ),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    syncRun: {
      findFirst: jest.fn().mockImplementation(({ where }) =>
        // Mirrors the real scoping: a run only counts for the connection it ran
        // for, so another household's success cannot suppress this one.
        options.lastStudentsRunEndedAt &&
        (where.householdConnectionId === undefined ||
          where.householdConnectionId === 'conn-1')
          ? { endedAt: options.lastStudentsRunEndedAt }
          : null,
      ),
      create: jest.fn().mockResolvedValue({}),
    },
  };

  const config = {
    get: jest.fn((key: string) =>
      ({
        MASHOV_SEMEL: 1234,
        MASHOV_USERNAME: 'env-user',
        MASHOV_PASSWORD: 'env-pass',
      })[key],
    ),
  } as unknown as ConfigService;

  const encryption = {
    encrypt: jest.fn().mockReturnValue('enc-pw'),
    decrypt: jest.fn().mockReturnValue('plain-pw'),
  } as unknown as EncryptionService;

  const schoolYear = {
    resolveForSchool: jest.fn().mockResolvedValue({ year: 2027, source: 'calendar' }),
    reconcileFromLogin:
      options.reconcile ??
      jest.fn((candidate: number) => ({ year: candidate, changed: false })),
    invalidate: jest.fn(),
  } as unknown as SchoolYearService;

  const service = new MashovSessionService(
    config,
    prisma as unknown as PrismaService,
    encryption,
    schoolYear,
  );

  return { service, prisma: prisma as unknown as Harness['prisma'] };
}

describe('MashovSessionService', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    // ensureStudentsAvailable short-circuits under NODE_ENV=test so suites do
    // not reach upstream; these tests exercise the real path with a mock.
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('getAuthHeadersForConnection', () => {
    it('persists the roster on the per-connection login path', async () => {
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(prisma.student.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentGuid: 'child-1' },
          update: expect.objectContaining({ classCode: 'ז', classNum: 3, isActive: true }),
        }),
      );
    });

    it('still returns usable auth headers', async () => {
      const { service } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      const headers = await service.getAuthHeadersForConnection(
        'conn-1',
        1234,
        2027,
        'parent',
        'pw',
      );

      expect(headers['X-Csrf-Token']).toBe('csrf-1');
      expect(headers.Cookie).toContain('MashovAuthToken=auth-1');
    });

    it('deactivates the children Mashov lists as inactive', async () => {
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(
        loginPayload([CHILD], { inactiveChildren: [{ childGuid: 'child-gone' }] }),
      );

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(prisma.student.updateMany).toHaveBeenCalledWith({
        where: { studentGuid: { in: ['child-gone'] } },
        data: { isActive: false },
      });
    });

    it('does not deactivate students in neither list', async () => {
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(prisma.student.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('refreshRosterForConnection', () => {
    it('reports what it created, updated and deactivated', async () => {
      const { service, prisma } = makeHarness();
      prisma.student.findMany.mockResolvedValue([{ studentGuid: 'child-1' }]);
      mockHttp.post.mockResolvedValue(
        loginPayload(
          [CHILD, { ...CHILD, childGuid: 'child-2' }],
          { inactiveChildren: ['child-gone'] },
        ),
      );
      prisma.student.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.refreshRosterForConnection('conn-1');

      expect(result).toEqual({ created: 1, updated: 1, deactivated: 1, year: 2027 });
    });

    it('forces a fresh login rather than reusing cached cookies', async () => {
      const { service } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');
      await service.refreshRosterForConnection('conn-1');

      expect(mockHttp.post).toHaveBeenCalledTimes(2);
    });

    it('persists the year Mashov confirms, not the one it was asked for', async () => {
      // The rollover may advance a connection on the calendar alone. If Mashov
      // has not opened that year, its answer has to win and be written down —
      // otherwise the daily cron sets the bad year back every morning and the
      // family's data flip-flops until the year really opens.
      const { service, prisma } = makeHarness({
        reconcile: jest.fn().mockReturnValue({ year: 2026, changed: true }),
      });
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      const result = await service.refreshRosterForConnection('conn-1', 2027);

      expect(result.year).toBe(2026);
      expect(prisma.householdConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conn-1' },
          data: expect.objectContaining({ schoolYear: 2026 }),
        }),
      );
    });

    it('logs in at the year override rather than the stored one', async () => {
      const { service } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.refreshRosterForConnection('conn-1', 2029);

      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({ year: 2029 }),
        expect.anything(),
      );
    });

    it('does not rewrite the connection when Mashov agrees', async () => {
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.refreshRosterForConnection('conn-1');

      expect(prisma.householdConnection.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schoolYear: expect.anything() }),
        }),
      );
    });

    it('throws when the connection does not exist', async () => {
      const { service } = makeHarness({ connection: null });

      await expect(service.refreshRosterForConnection('ghost')).rejects.toThrow(
        /ghost/,
      );
    });
  });

  describe('ensureStudentsAvailable', () => {
    it('refreshes the roster even when active students already exist', async () => {
      const { service, prisma } = makeHarness();
      prisma.student.count.mockResolvedValue(3);
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.ensureStudentsAvailable('user-1');

      expect(mockHttp.post).toHaveBeenCalledTimes(1);
      expect(prisma.student.upsert).toHaveBeenCalled();
    });

    it('skips the refresh when a successful students run is inside the TTL', async () => {
      const { service } = makeHarness({
        lastStudentsRunEndedAt: new Date(Date.now() - 10 * 60 * 1000),
      });
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.ensureStudentsAvailable('user-1');

      expect(mockHttp.post).not.toHaveBeenCalled();
    });

    it('refreshes once the TTL has elapsed', async () => {
      const { service } = makeHarness({
        lastStudentsRunEndedAt: new Date(Date.now() - 120 * 60 * 1000),
      });
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.ensureStudentsAvailable('user-1');

      expect(mockHttp.post).toHaveBeenCalledTimes(1);
    });

    it("is not suppressed by another household's successful roster sync", async () => {
      // Household A's roster sync fails every cycle (changed password) while
      // B's succeeds. A global TTL probe would read B's fresh run and skip A's
      // self-heal forever — the same gating failure this function replaced.
      const { service, prisma } = makeHarness({
        connection: {
          ...CONNECTION,
          id: 'conn-other',
        },
        lastStudentsRunEndedAt: new Date(Date.now() - 4 * 60 * 1000),
      });
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.ensureStudentsAvailable('user-2');

      expect(prisma.syncRun.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ householdConnectionId: 'conn-other' }),
        }),
      );
      expect(mockHttp.post).toHaveBeenCalledTimes(1);
    });

    it("uses the requesting user's credentials rather than the env account", async () => {
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.ensureStudentsAvailable('user-1');

      expect(prisma.householdConnection.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', active: true }),
        }),
      );
      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({ username: 'parent', password: 'plain-pw' }),
        expect.anything(),
      );
    });

    it('falls back to the env account when the user has no connection', async () => {
      const { service } = makeHarness({ connection: null });
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.ensureStudentsAvailable('user-1');

      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({ username: 'env-user' }),
        expect.anything(),
      );
    });

    it('joins an in-flight refresh instead of logging in twice', async () => {
      const { service } = makeHarness();
      let release!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      mockHttp.post.mockReturnValue(pending);

      const first = service.ensureStudentsAvailable('user-1');
      // Let the first call get as far as registering itself in-flight.
      await new Promise((resolve) => setImmediate(resolve));
      const second = service.ensureStudentsAvailable('user-1');
      release(loginPayload([CHILD]));
      await Promise.all([first, second]);

      expect(mockHttp.post).toHaveBeenCalledTimes(1);
    });

    it('swallows an upstream failure rather than breaking the page load', async () => {
      const { service } = makeHarness();
      mockHttp.post.mockRejectedValue(new Error('upstream down'));

      await expect(service.ensureStudentsAvailable('user-1')).resolves.toBeUndefined();
    });
  });

  describe('login (shared env session)', () => {
    it('persists the year Mashov confirms, not the candidate it was asked for', async () => {
      const reconcile = jest.fn(() => ({ year: 2026, changed: true }));
      const { service, prisma } = makeHarness({ reconcile });
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.login();

      expect(prisma.householdConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schoolYear: 2026 }),
        }),
      );
    });

    it('re-logs in once at the year Mashov confirms', async () => {
      const reconcile = jest.fn(() => ({ year: 2026, changed: true }));
      const { service } = makeHarness({ reconcile });
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.login();

      expect(mockHttp.post).toHaveBeenCalledTimes(2);
      expect(mockHttp.post).toHaveBeenLastCalledWith(
        '/api/login',
        expect.objectContaining({ year: 2026 }),
        expect.anything(),
      );
    });

    it('does not re-login when Mashov agrees with the candidate year', async () => {
      const { service } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.login();

      expect(mockHttp.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('enrolled school years', () => {
    it('persists the enrolled school years from the login body', async () => {
      // The backfill needs to know which years a child actually has, or it
      // spends a login per year on years with no records at all.
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(
        loginPayload([CHILD], { userSchoolYears: [2025, 2026, 2027] }),
      );

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(prisma.householdConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conn-1' },
          data: expect.objectContaining({ schoolYears: [2025, 2026, 2027] }),
        }),
      );
    });

    it('leaves the enrolled years untouched when the login omits them', async () => {
      // Overwriting with [] would make the backfill skip every year rather
      // than fall back to the capped window.
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(prisma.householdConnection.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schoolYears: expect.anything() }),
        }),
      );
    });

    it('ignores a non-numeric entry rather than writing it', async () => {
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(
        loginPayload([CHILD], { userSchoolYears: [2026, 'nope', null, 2027] }),
      );

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(prisma.householdConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schoolYears: [2026, 2027] }),
        }),
      );
    });
  });

  describe('per-year session cache', () => {
    it('does not reuse a session cached for a different year on the same connection', async () => {
      // The backfill and the live crons hold one connection between them. A
      // cache keyed on connectionId alone hands the second caller the first
      // caller's year-scoped cookies, and the wrong-year response is a valid
      // 200 that no retry can detect.
      const { service } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');
      await service.getAuthHeadersForConnection('conn-1', 1234, 2026, 'parent', 'pw');

      expect(mockHttp.post).toHaveBeenCalledTimes(2);
      expect(mockHttp.post).toHaveBeenLastCalledWith(
        '/api/login',
        expect.objectContaining({ year: 2026 }),
        expect.anything(),
      );
    });

    it("keeps two years' sessions concurrently", async () => {
      const { service } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');
      await service.getAuthHeadersForConnection('conn-1', 1234, 2026, 'parent', 'pw');
      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');
      await service.getAuthHeadersForConnection('conn-1', 1234, 2026, 'parent', 'pw');

      expect(mockHttp.post).toHaveBeenCalledTimes(2);
    });

    it('evicts only the year asked for on forceRefresh', async () => {
      const { service } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');
      await service.getAuthHeadersForConnection('conn-1', 1234, 2026, 'parent', 'pw');
      await service.getAuthHeadersForConnection('conn-1', 1234, 2026, 'parent', 'pw', true);
      expect(mockHttp.post).toHaveBeenCalledTimes(3);

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(mockHttp.post).toHaveBeenCalledTimes(3);
    });

    it("still evicts the superseded year's session after a year correction", async () => {
      const { service } = makeHarness({
        reconcile: jest.fn().mockReturnValue({ year: 2026, changed: true }),
      });
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.refreshRosterForConnection('conn-1', 2027);
      const afterCorrection = mockHttp.post.mock.calls.length;

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(mockHttp.post.mock.calls.length).toBe(afterCorrection + 1);
    });
  });

  describe('ensureStudentsAvailable syncRun bookkeeping', () => {
    it('records a successful students run so the TTL gate is satisfied next time', async () => {
      const { service, prisma } = makeHarness({ lastStudentsRunEndedAt: null });
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.ensureStudentsAvailable('user-1');

      expect(prisma.syncRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: 'students',
            status: 'success',
            householdConnectionId: 'conn-1',
          }),
        }),
      );
    });

    it('records a failed students run when the refresh throws', async () => {
      const { service, prisma } = makeHarness({ lastStudentsRunEndedAt: null });
      mockHttp.post.mockRejectedValue(new Error('upstream down'));

      await service.ensureStudentsAvailable('user-1');

      expect(prisma.syncRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ source: 'students', status: 'failed' }),
        }),
      );
    });
  });
});
