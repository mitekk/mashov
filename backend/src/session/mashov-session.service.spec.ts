import axios from 'axios';
import { MashovSessionService } from './mashov-session.service';
import { Logger } from '@nestjs/common';
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
    studentConnection: { upsert: jest.Mock };
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
    studentConnection: {
      upsert: jest.fn().mockResolvedValue({}),
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
        where: {
          studentGuid: { in: ['child-gone'] },
          // Scoped to the children THIS connection lists, plus the unlinked
          // ones. `inactiveChildren` is school-local, so a connection must not
          // be able to retire a child it does not list -- and since ADR-0031
          // that is a link, not the routing stamp: a child two parents share
          // is stamped to only one of them.
          OR: [
            { links: { some: { householdConnectionId: 'conn-1' } } },
            { links: { none: {} } },
          ],
        },
        data: { isActive: false },
      });
    });

    it('stamps each child with the connection whose roster listed them', async () => {
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      const [{ create, update }] = prisma.student.upsert.mock.calls[0] as [
        { create: Record<string, unknown>; update: Record<string, unknown> },
      ];
      expect(create.householdConnectionId).toBe('conn-1');
      expect(update.householdConnectionId).toBe('conn-1');
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
      // Past ROSTER_TTL_MINUTES, which is 24h: this runs on the request path,
      // so with the `students` cron gone an hourly TTL would make it a full
      // upstream login per household per hour of browsing.
      const { service } = makeHarness({
        lastStudentsRunEndedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
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

    it('is a no-op when the user has no connection', async () => {
      // This used to fall back to the shared env account, which is gone. Both
      // callers are page reads, so a throw would 500 the dashboard for a user
      // mid-setup. It must also record no `syncRun`: an owner-less `students`
      // row is admitted into every connection's snapshot by the branch-wide
      // NULL rule, satisfying the TTL gate for connections that do not exist.
      const { service, prisma } = makeHarness({ connection: null });

      await expect(service.ensureStudentsAvailable('user-1')).resolves.toBeUndefined();

      expect(mockHttp.post).not.toHaveBeenCalled();
      expect(prisma.syncRun.create).not.toHaveBeenCalled();
      // Returns before the TTL probe, so it costs no query either.
      expect(prisma.syncRun.findFirst).not.toHaveBeenCalled();
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

  describe('marking credentials stale when a login is rejected', () => {
    /**
     * An upstream rejection of the login, as axios reports it.
     *
     * `isMashovRejection` needs `axios.isAxiosError` to answer truthfully, and
     * the module is auto-mocked at the top of this file -- so the mock is given
     * the real predicate's shape for the duration of these tests.
     */
    function rejection(headers: Record<string, string> | null): Error {
      const error = Object.assign(new Error('Request failed with status code 401'), {
        isAxiosError: true,
        response: headers === null ? undefined : { status: 401, headers },
      });
      return error as Error;
    }

    beforeEach(() => {
      (mockedAxios.isAxiosError as unknown as jest.Mock).mockImplementation(
        (error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError,
      );
    });

    it('marks the connection stale when Mashov rejects the stored password', async () => {
      // THE DEFECT. `credentialStaleAt` was written in exactly one place --
      // after a reset the parent performed through our own recovery flow -- so
      // a password that went stale UPSTREAM (changed at the school, expired)
      // failed every sync login while `school-links` kept reporting a healthy
      // connection. That is what showed green throughout the #60 incident.
      const { service, prisma } = makeHarness();
      // No `Reason`, but a JSON body: Mashov answered, and classifies as
      // INVALID_CREDENTIALS.
      mockHttp.post.mockRejectedValue(rejection({ 'content-type': 'application/json' }));

      await expect(
        service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw'),
      ).rejects.toThrow();

      expect(prisma.householdConnection.update).toHaveBeenCalledWith({
        where: { id: 'conn-1' },
        data: { credentialStaleAt: expect.any(Date) },
      });
    });

    it('marks it stale when Mashov demands a password change', async () => {
      // `ChangePass` means the stored password will not work again until the
      // parent supplies a new one -- which is exactly what `credentialStale`
      // prompts for.
      const { service, prisma } = makeHarness();
      mockHttp.post.mockRejectedValue(rejection({ reason: 'ChangePass' }));

      await expect(
        service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw'),
      ).rejects.toThrow();

      expect(prisma.householdConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { credentialStaleAt: expect.any(Date) } }),
      );
    });

    it('does NOT mark it stale when the upstream never answered', async () => {
      // The amplifier of the wrong kind: a stalled proxy or a Mashov outage
      // would otherwise mark every connection's credentials stale and prompt
      // every parent to re-enter a password that is perfectly good.
      const { service, prisma } = makeHarness();
      mockHttp.post.mockRejectedValue(new Error('ECONNABORTED'));

      await expect(
        service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw'),
      ).rejects.toThrow();

      expect(prisma.householdConnection.update).not.toHaveBeenCalled();
    });

    it('does NOT mark it stale for an HTML error page', async () => {
      // A response, but not from the API: a captive portal or a proxy error
      // page. `isMashovRejection` accepts a `Reason` header or a JSON content
      // type as evidence Mashov itself answered, and this is neither.
      const { service, prisma } = makeHarness();
      mockHttp.post.mockRejectedValue(rejection({ 'content-type': 'text/html' }));

      await expect(
        service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw'),
      ).rejects.toThrow();

      expect(prisma.householdConnection.update).not.toHaveBeenCalled();
    });

    it('does NOT mark it stale when Mashov only wants a one-time code', async () => {
      // `MfaRequired` is a code, not a password. Re-entering the stored
      // password changes nothing, so prompting for it would be a dead end.
      const { service, prisma } = makeHarness();
      mockHttp.post.mockRejectedValue(rejection({ reason: 'MfaRequired' }));

      await expect(
        service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw'),
      ).rejects.toThrow();

      expect(prisma.householdConnection.update).not.toHaveBeenCalled();
    });

    it('does NOT mark it stale for a failure re-entering credentials cannot fix', async () => {
      // `SchoolClosed`, `UserInactive` and the rest are real failures, and the
      // sync will not work -- but the password is not the problem and the
      // parent can do nothing about it. A stale-credential prompt would be a
      // lie with a dead end behind it.
      for (const reason of ['SchoolClosed', 'UserInactive', 'NoChildren', 'UserSuspended']) {
        const { service, prisma } = makeHarness();
        mockHttp.post.mockRejectedValue(rejection({ reason }));

        await expect(
          service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw'),
        ).rejects.toThrow();

        expect(prisma.householdConnection.update).not.toHaveBeenCalled();
      }
    });

    it('does not re-stamp a connection already known to be stale', async () => {
      // `getAuthHeadersForConnection` runs per request. Without this guard a
      // stale connection writes a row on every single call -- an UPDATE storm
      // that also walks `credentialStaleAt` forward forever, so "stale since"
      // would always read as just now.
      const { service, prisma } = makeHarness({
        connection: { ...CONNECTION, credentialStaleAt: new Date('2026-11-20T08:00:00Z') },
      });
      mockHttp.post.mockRejectedValue(rejection({ 'content-type': 'application/json' }));

      await expect(
        service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw'),
      ).rejects.toThrow();

      expect(prisma.householdConnection.update).not.toHaveBeenCalled();
    });

    it('still surfaces the original login failure when the stamp itself fails', async () => {
      // Bookkeeping must never replace the diagnosis. The caller logs the
      // login error; a write failure here must not become the error it sees.
      const { service, prisma } = makeHarness();
      prisma.householdConnection.update.mockRejectedValue(new Error('db down'));
      mockHttp.post.mockRejectedValue(rejection({ 'content-type': 'application/json' }));

      await expect(
        service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw'),
      ).rejects.toThrow(/401/);
    });

    it('leaves a successful login alone', async () => {
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      for (const call of prisma.householdConnection.update.mock.calls) {
        expect(call[0].data).not.toHaveProperty('credentialStaleAt');
      }
    });
  });

  describe('ownership stamping', () => {
    it('grants the connection a view of every child in the roster', async () => {
      // The stamp says who to ASK upstream; the link says who may SEE. Two
      // parents at one school share children, so only the link can be a set --
      // and before it existed the second of them to sync took the children
      // away from the first (ADR-0031).
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(prisma.studentConnection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            studentGuid_householdConnectionId: {
              studentGuid: 'child-1',
              householdConnectionId: 'conn-1',
            },
          },
        }),
      );
    });

    it('re-stamps and warns when a child turns up under another connection', async () => {
      // A child who moved school. The stamp has to follow them or every
      // per-student cron keeps asking the old school and getting a 403, but it
      // is also the only trace that it happened -- nothing else in the schema
      // records a move.
      const { service, prisma } = makeHarness();
      prisma.student.findMany.mockResolvedValue([
        { studentGuid: 'child-1', householdConnectionId: 'conn-old' },
      ]);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      const [{ update }] = prisma.student.upsert.mock.calls[0] as [
        { update: Record<string, unknown> },
      ];
      expect(update.householdConnectionId).toBe('conn-1');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('child-1'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('conn-old'));
      warn.mockRestore();
    });

    it('does not warn when the stamp is unchanged', async () => {
      const { service, prisma } = makeHarness();
      prisma.student.findMany.mockResolvedValue([
        { studentGuid: 'child-1', householdConnectionId: 'conn-1' },
      ]);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('moved'));
      warn.mockRestore();
    });
  });

  describe('historical logins', () => {
    it('does not persist the roster on a login for an earlier year', async () => {
      // persistRoster writes classCode/classNum and isActive, and Student has
      // no schoolYear — identity is stable across years. A 2026 login would
      // therefore stamp the live roster with 2026's classes and resurrect
      // children who have since left.
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2026, 'parent', 'pw');

      expect(prisma.student.upsert).not.toHaveBeenCalled();
      expect(prisma.student.updateMany).not.toHaveBeenCalled();
    });

    it('does not write the connection back on a login for an earlier year', async () => {
      // The replayed uniquId may evict the live session upstream, and the
      // enrolled-years list from a dead year is not news.
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(
        loginPayload([CHILD], { userSchoolYears: [2024, 2025] }),
      );

      await service.getAuthHeadersForConnection('conn-1', 1234, 2026, 'parent', 'pw');

      expect(prisma.householdConnection.update).not.toHaveBeenCalled();
    });

    it('still returns usable headers for the earlier year', async () => {
      const { service } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      const headers = await service.getAuthHeadersForConnection(
        'conn-1',
        1234,
        2026,
        'parent',
        'pw',
      );

      expect(headers['X-Csrf-Token']).toBe('csrf-1');
      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({ year: 2026 }),
        expect.anything(),
      );
    });

    it('still persists the roster at the connection year', async () => {
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

      expect(prisma.student.upsert).toHaveBeenCalled();
    });

    it('still persists the roster when probing a later year', async () => {
      // The rollover offers a candidate year ahead of the stored one and needs
      // the roster read at it; only reaching backwards is suppressed.
      const { service, prisma } = makeHarness();
      mockHttp.post.mockResolvedValue(loginPayload([CHILD]));

      await service.getAuthHeadersForConnection('conn-1', 1234, 2028, 'parent', 'pw');

      expect(prisma.student.upsert).toHaveBeenCalled();
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

/**
 * Trusted-device re-login.
 *
 * Sixteen cron tasks re-login by decrypting `encryptedPassword`. If every one
 * of those re-logins re-opened an MFA challenge, MFA-protected accounts would
 * be structurally incompatible with background sync -- the parent signs in once
 * and then watches their data go stale overnight, with no error anyone can see.
 *
 * Mashov's own answer is the `devicePass` response header plus
 * `POST /api/loginDevice`: an empty body and that header, and no challenge.
 * This is the load-bearing half of MFA support.
 */
describe('MashovSessionService trusted-device re-login', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.create = jest.fn().mockReturnValue(mockHttp);
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  function deviceResponse(extraHeaders: Record<string, string | string[]> = {}) {
    const payload = loginPayload([CHILD]);
    return {
      data: payload.data,
      headers: { ...payload.headers, ...extraHeaders },
    };
  }

  it('persists the devicePass a password login hands back, encrypted', async () => {
    const { service, prisma } = makeHarness();
    mockHttp.post.mockResolvedValue(deviceResponse({ devicepass: 'dp-raw' }));

    await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

    const update = prisma.householdConnection.update.mock.calls.find(
      (call) => call[0].data.devicePass !== undefined,
    );
    expect(update).toBeDefined();
    // Encrypted like `encryptedPassword`, never the raw header value.
    expect(update?.[0].data.devicePass).not.toBe('dp-raw');
  });

  it('writes no devicePass when Mashov did not send one', async () => {
    const { service, prisma } = makeHarness();
    mockHttp.post.mockResolvedValue(deviceResponse());

    await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

    for (const call of prisma.householdConnection.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('devicePass');
    }
  });

  it('prefers POST /api/loginDevice when a devicePass is stored', async () => {
    const { service } = makeHarness({
      connection: { ...CONNECTION, devicePass: 'enc-dp' },
    });
    mockHttp.post.mockResolvedValue(deviceResponse());

    await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

    const paths = mockHttp.post.mock.calls.map((call) => call[0] as string);
    expect(paths[0]).toBe('/api/loginDevice');
    expect(paths).not.toContain('/api/login');
  });

  it('sends the decrypted devicePass as a header and an empty body', async () => {
    const { service } = makeHarness({
      connection: { ...CONNECTION, devicePass: 'enc-dp' },
    });
    mockHttp.post.mockResolvedValue(deviceResponse());

    await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

    const [, body, config] = mockHttp.post.mock.calls[0];
    expect(body).toEqual({});
    // `decrypt` is stubbed to 'plain-pw' in the harness.
    expect((config as { headers: Record<string, string> }).headers.devicePass).toBe(
      'plain-pw',
    );
  });

  it('never sends a password on the loginDevice path', async () => {
    const { service } = makeHarness({
      connection: { ...CONNECTION, devicePass: 'enc-dp' },
    });
    mockHttp.post.mockResolvedValue(deviceResponse());

    await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'secret');

    expect(JSON.stringify(mockHttp.post.mock.calls[0])).not.toContain('secret');
  });

  it('falls back to password login when loginDevice fails', async () => {
    // A rotated-out or revoked devicePass must degrade to the path that still
    // works, not fail the sync task.
    const { service } = makeHarness({
      connection: { ...CONNECTION, devicePass: 'enc-dp' },
    });
    mockHttp.post
      .mockRejectedValueOnce(new Error('devicePass rejected'))
      .mockResolvedValue(deviceResponse());

    const headers = await service.getAuthHeadersForConnection(
      'conn-1',
      1234,
      2027,
      'parent',
      'pw',
    );

    const paths = mockHttp.post.mock.calls.map((call) => call[0] as string);
    expect(paths).toEqual(['/api/loginDevice', '/api/login']);
    expect(headers['X-Csrf-Token']).toBe('csrf-1');
  });

  it('persists a rotated devicePass from the loginDevice response', async () => {
    // If Mashov rotates it and we keep the old one, the NEXT re-login fails and
    // sync silently falls back to a password that may no longer exist.
    const { service, prisma } = makeHarness({
      connection: { ...CONNECTION, devicePass: 'enc-dp' },
    });
    mockHttp.post.mockResolvedValue(deviceResponse({ devicepass: 'dp-rotated' }));

    await service.getAuthHeadersForConnection('conn-1', 1234, 2027, 'parent', 'pw');

    expect(
      prisma.householdConnection.update.mock.calls.some(
        (call) => call[0].data.devicePass !== undefined,
      ),
    ).toBe(true);
  });

  it('does not use the trusted-device path for a historical backfill login', async () => {
    // A backward-reaching login must touch nothing that describes the present,
    // and `loginDevice` carries no year at all -- it would return the live
    // session rather than the year the backfill asked for.
    const { service } = makeHarness({
      connection: { ...CONNECTION, devicePass: 'enc-dp', schoolYear: 2027 },
    });
    mockHttp.post.mockResolvedValue(deviceResponse());

    await service.getAuthHeadersForConnection('conn-1', 1234, 2025, 'parent', 'pw');

    expect(mockHttp.post.mock.calls[0][0]).toBe('/api/login');
  });
});
