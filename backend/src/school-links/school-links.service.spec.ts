import { PrismaService } from '../prisma/prisma.service';
import { SchoolLinksService } from './school-links.service';

function conn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-a',
    schoolCode: 540175,
    schoolYear: 2026,
    username: 'parent-a',
    encryptedPassword: 'enc:secret-password',
    schoolName: 'אורט רמון',
    displayLabel: null,
    active: true,
    userId: 'user-1',
    lastLoginAt: new Date('2026-11-18T08:00:00Z'),
    createdAt: new Date('2026-09-01T08:00:00Z'),
    mashovUniqueId: 'uniq',
    upstreamUserId: 'mashov-1',
    cachedNewCount: 3,
    schoolYears: [2026],
    linkedByUserId: null,
    linkedAt: null,
    updatedAt: new Date('2026-11-18T08:00:00Z'),
    ...overrides,
  };
}

function makePrisma(options: {
  connections?: Array<Record<string, unknown>>;
  studentCounts?: Array<{ householdConnectionId: string; _count: { _all: number } }>;
  lastRuns?: Array<{ householdConnectionId: string; _max: { endedAt: Date | null } }>;
} = {}) {
  const findMany = jest.fn().mockResolvedValue(options.connections ?? [conn()]);
  const studentGroupBy = jest.fn().mockResolvedValue(options.studentCounts ?? []);
  const syncRunGroupBy = jest.fn().mockResolvedValue(options.lastRuns ?? []);

  return {
    prisma: {
      householdConnection: { findMany },
      student: { groupBy: studentGroupBy },
      syncRun: { groupBy: syncRunGroupBy },
    } as unknown as PrismaService,
    findMany,
    studentGroupBy,
  };
}

/** The service with every collaborator stubbed; overrides replace one. */
function makeService(
  prisma: PrismaService,
  overrides: {
    redis?: unknown;
    encryption?: unknown;
    schoolYear?: unknown;
    validator?: unknown;
    sync?: unknown;
  } = {},
) {
  return new SchoolLinksService(
    prisma,
    (overrides.redis ?? {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(undefined),
    }) as never,
    (overrides.encryption ?? { encrypt: jest.fn((value: string) => `enc:${value}`) }) as never,
    (overrides.schoolYear ?? {
      resolveForSchool: jest.fn().mockResolvedValue({ year: 2027, source: 'calendar' }),
      reconcileFromLogin: jest.fn((candidate: number) => ({ year: candidate, changed: false })),
      invalidate: jest.fn(),
    }) as never,
    (overrides.validator ?? { validate: jest.fn() }) as never,
    (overrides.sync ?? { refreshAll: jest.fn().mockResolvedValue({ status: 'success' }) }) as never,
  );
}

describe('SchoolLinksService', () => {
  describe('listLinks', () => {
    it('never returns the password in any form', async () => {
      // The one assertion that must not be allowed to rot. A link row is the
      // only place the management screen reads a connection, and the row it
      // comes from holds the encrypted Mashov password.
      const { prisma } = makePrisma();
      const links = await makeService(prisma).listLinks('user-1');

      const serialised = JSON.stringify(links);
      expect(serialised).not.toContain('enc:secret-password');
      expect(serialised).not.toContain('encryptedPassword');
      expect(serialised).not.toContain('password');
      expect(Object.keys(links[0])).not.toContain('encryptedPassword');
    });

    it("scopes to the caller's own active connections", async () => {
      const { prisma, findMany } = makePrisma();
      await makeService(prisma).listLinks('user-1');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', active: true } }),
      );
    });

    it('returns an empty list, and no further queries, for a household with none', async () => {
      const { prisma, studentGroupBy } = makePrisma({ connections: [] });
      await expect(makeService(prisma).listLinks('user-1')).resolves.toEqual([]);
      expect(studentGroupBy).not.toHaveBeenCalled();
    });

    it('counts each school\'s children', async () => {
      const { prisma } = makePrisma({
        connections: [conn(), conn({ id: 'conn-b', schoolCode: 999999, username: 'parent-b', schoolName: 'תיכון רמון' })],
        studentCounts: [
          { householdConnectionId: 'conn-a', _count: { _all: 2 } },
          { householdConnectionId: 'conn-b', _count: { _all: 1 } },
        ],
      });

      const links = await makeService(prisma).listLinks('user-1');

      expect(links.map((link) => link.childrenCount)).toEqual([2, 1]);
    });

    it('reports zero children rather than omitting a school with none', async () => {
      // A school linked a moment ago has no children yet. It still has to
      // appear, or the parent cannot unlink the thing they just created.
      const { prisma } = makePrisma({ studentCounts: [] });

      const links = await makeService(prisma).listLinks('user-1');

      expect(links).toHaveLength(1);
      expect(links[0].childrenCount).toBe(0);
    });

    it('leaves lastSyncAt null until a run has SUCCEEDED', async () => {
      // The UI shows "מסנכרן נתונים…" while this is null. A failed run must
      // not read as a finished sync -- a parent watching a school that cannot
      // sync should keep seeing that, not a reassuring timestamp.
      const { prisma } = makePrisma({ lastRuns: [] });

      const links = await makeService(prisma).listLinks('user-1');

      expect(links[0].lastSyncAt).toBeNull();
    });

    it('reports the newest successful run as lastSyncAt', async () => {
      const endedAt = new Date('2026-11-18T09:30:00Z');
      const { prisma } = makePrisma({
        lastRuns: [{ householdConnectionId: 'conn-a', _max: { endedAt } }],
      });

      const links = await makeService(prisma).listLinks('user-1');

      expect(links[0].lastSyncAt).toBe(endedAt.toISOString());
    });

    it('marks only the most recently used school as primary', async () => {
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-b', username: 'parent-b', lastLoginAt: new Date('2026-11-18T10:00:00Z') }),
          conn({ id: 'conn-a' }),
        ],
      });

      const links = await makeService(prisma).listLinks('user-1');

      expect(links.map((link) => link.isPrimary)).toEqual([true, false]);
    });

    it('resolves short labels as a set, so two schools never share one', async () => {
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-a', schoolName: 'אורט רמון - חטיבת ביניים' }),
          conn({ id: 'conn-b', username: 'parent-b', schoolName: 'אורט רמון - חטיבה עליונה' }),
        ],
      });

      const links = await makeService(prisma).listLinks('user-1');

      expect(links[0].shortLabel).not.toBe(links[1].shortLabel);
    });

    it('falls back to the semel when a school has no name', async () => {
      const { prisma } = makePrisma({ connections: [conn({ schoolName: null })] });

      const links = await makeService(prisma).listLinks('user-1');

      expect(links[0].schoolName).toBe('540175');
      expect(links[0].shortLabel).toBe('540175');
    });
  });

  describe('listMeSchools', () => {
    it('carries only what a badge needs, and no management fields', async () => {
      const { prisma } = makePrisma();

      const schools = await makeService(prisma).listMeSchools('user-1');

      expect(Object.keys(schools[0]).sort()).toEqual([
        'id',
        'schoolName',
        'schoolYear',
        'semel',
        'shortLabel',
      ]);
    });

    it('agrees with listLinks about which schools exist and in what order', async () => {
      // Both come from one method deliberately: two implementations of "which
      // schools are these" would drift, and the badge and the management
      // screen would disagree in front of the user.
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-b', username: 'parent-b', lastLoginAt: new Date('2026-11-18T10:00:00Z') }),
          conn({ id: 'conn-a' }),
        ],
      });
      const service = makeService(prisma);

      const [links, schools] = await Promise.all([
        service.listLinks('user-1'),
        service.listMeSchools('user-1'),
      ]);

      expect(schools.map((school) => school.id)).toEqual(links.map((link) => link.id));
      expect(schools.map((school) => school.shortLabel)).toEqual(
        links.map((link) => link.shortLabel),
      );
    });
  });
});

describe('SchoolLinksService.createLink', () => {
  const CHILD = {
    childGuid: 'guid-b1',
    familyName: 'Kors',
    privateName: 'Noa',
    classCode: 'י',
    classNum: 1,
    gender: 'F',
    groups: [1],
  };

  function loginPayload(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        credential: { userId: 'mashov-b', displayName: 'Parent', semel: 999999, year: 2027 },
        accessToken: {
          userSettings: { detailsState: 1 },
          schoolSettings: { schoolName: 'תיכון רמון', schoolYear: 2027 },
          children: [CHILD],
          username: 'parent-b',
          ...overrides,
        },
      },
      newUniqueId: 'uniq-b',
    };
  }

  function makePrisma(options: {
    existing?: Array<{ id: string; schoolCode: number; username: string }>;
    orphanUserId?: string | null;
  } = {}) {
    const upsert = jest.fn().mockResolvedValue({ id: 'conn-new' });
    const studentUpsert = jest.fn().mockResolvedValue({});
    const studentUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

    return {
      upsert,
      studentUpsert,
      studentUpdateMany,
      prisma: {
        householdConnection: {
          findMany: jest.fn(({ select }) =>
            Promise.resolve(
              select?.id && select?.schoolCode
                ? (options.existing ?? [])
                : [
                    {
                      id: 'conn-new',
                      schoolCode: 999999,
                      schoolYear: 2027,
                      username: 'parent-b',
                      schoolName: 'תיכון רמון',
                      displayLabel: null,
                      active: true,
                      lastLoginAt: new Date('2026-11-18T10:00:00Z'),
                      createdAt: new Date('2026-11-18T10:00:00Z'),
                    },
                  ],
            ),
          ),
          findUnique: jest.fn().mockResolvedValue(
            options.orphanUserId === undefined ? null : { userId: options.orphanUserId },
          ),
          upsert,
        },
        student: {
          upsert: studentUpsert,
          updateMany: studentUpdateMany,
          groupBy: jest.fn().mockResolvedValue([
            { householdConnectionId: 'conn-new', _count: { _all: 1 } },
          ]),
        },
        syncRun: { groupBy: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService,
    };
  }

  it('persists the connection and its children, and returns the link', async () => {
    const { prisma, upsert, studentUpsert } = makePrisma();
    const validate = jest.fn().mockResolvedValue(loginPayload());
    const service = makeService(prisma, { validator: { validate } });

    const link = await service.createLink('user-1', {
      semel: 999999,
      username: 'parent-b',
      password: 'pw',
    });

    expect(link).toMatchObject({ id: 'conn-new', semel: 999999, childrenCount: 1 });
    expect(upsert).toHaveBeenCalled();
    // The child is stamped with the new connection, so it is owned from the
    // first moment rather than waiting for a sync to attribute it.
    expect(studentUpsert.mock.calls[0][0].create.householdConnectionId).toBe('conn-new');
  });

  it('does NOT await the background refresh', async () => {
    // Holding the request open for a full sync would time out at the proxy and
    // tell the parent the link failed, after it had already succeeded.
    const { prisma } = makePrisma();
    let resolveRefresh: (() => void) | undefined;
    const refreshAll = jest.fn(
      () => new Promise<void>((resolve) => {
        resolveRefresh = () => resolve();
      }),
    );
    const service = makeService(prisma, {
      validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      sync: { refreshAll },
    });

    await expect(
      service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
    ).resolves.toBeTruthy();

    expect(refreshAll).toHaveBeenCalledWith({ connectionId: 'conn-new' });
    resolveRefresh?.();
  });

  it('survives a background refresh that rejects', async () => {
    const { prisma } = makePrisma();
    const service = makeService(prisma, {
      validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      sync: { refreshAll: jest.fn().mockRejectedValue(new Error('upstream down')) },
    });

    await expect(
      service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
    ).resolves.toBeTruthy();
  });

  describe('refusals', () => {
    it('refuses the same account twice with CONNECTION_ALREADY_LINKED', async () => {
      const { prisma } = makePrisma({
        existing: [{ id: 'conn-a', schoolCode: 999999, username: 'parent-b' }],
      });
      const validate = jest.fn();
      const service = makeService(prisma, { validator: { validate } });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({
        response: { error: { code: 'CONNECTION_ALREADY_LINKED' } },
      });
      // Refused before reaching Mashov: no point spending a login on it.
      expect(validate).not.toHaveBeenCalled();
    });

    it('refuses a second account at the same school with SCHOOL_ALREADY_LINKED', async () => {
      // The schema permits it, but it duplicates every child and breaks the
      // one-chip-per-school model, so it is refused rather than half-supported.
      const { prisma } = makePrisma({
        existing: [{ id: 'conn-a', schoolCode: 999999, username: 'mother' }],
      });
      const service = makeService(prisma, { validator: { validate: jest.fn() } });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'father', password: 'pw' }),
      ).rejects.toMatchObject({
        response: { error: { code: 'SCHOOL_ALREADY_LINKED' } },
      });
    });

    it('refuses beyond four active links with LIMIT_REACHED', async () => {
      const { prisma } = makePrisma({
        existing: [1, 2, 3, 4].map((n) => ({
          id: `conn-${n}`,
          schoolCode: 100 + n,
          username: `p${n}`,
        })),
      });
      const service = makeService(prisma, { validator: { validate: jest.fn() } });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({ response: { error: { code: 'LIMIT_REACHED' } } });
    });

    it("refuses an account already owned by another household", async () => {
      const { prisma } = makePrisma({ orphanUserId: 'someone-else' });
      const service = makeService(prisma, { validator: { validate: jest.fn() } });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({
        response: { error: { code: 'CONNECTION_ALREADY_LINKED' } },
      });
    });

    it('re-parents an unowned connection rather than refusing it', async () => {
      // What makes unlink-then-relink work: unlink sets userId = null, and the
      // row survives.
      const { prisma, upsert } = makePrisma({ orphanUserId: null });
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).resolves.toBeTruthy();
      expect(upsert).toHaveBeenCalled();
    });

    it('refuses an account with no children, persisting nothing', async () => {
      // A childless connection shows up as a school with no children and a
      // chip that matches nothing, which a parent cannot diagnose.
      const { prisma, upsert } = makePrisma();
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload({ children: [] })) },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({
        response: { error: { code: 'NO_CHILDREN_FOUND' } },
      });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('distinguishes an account whose children are all inactive', async () => {
      const { prisma, upsert } = makePrisma();
      const service = makeService(prisma, {
        validator: {
          validate: jest.fn().mockResolvedValue(
            loginPayload({ children: [], inactiveChildren: [{ childGuid: 'gone' }] }),
          ),
        },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({
        response: { error: { code: 'NO_ACTIVE_CHILDREN' } },
      });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('rate-limits to five attempts per fifteen minutes', async () => {
      // This endpoint brute-forces upstream credentials from inside an
      // authenticated session, which sign-in's per-IP limit does not cover.
      const { prisma } = makePrisma();
      const incr = jest.fn().mockResolvedValue(6);
      const service = makeService(prisma, {
        redis: { incr, expire: jest.fn() },
        validator: { validate: jest.fn() },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({ response: { error: { code: 'RATE_LIMITED' } } });
    });

    it('keys the rate limit on the user, not the IP', async () => {
      const { prisma } = makePrisma();
      const incr = jest.fn().mockResolvedValue(1);
      const service = makeService(prisma, {
        redis: { incr, expire: jest.fn() },
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      });

      await service.createLink('user-1', {
        semel: 999999,
        username: 'parent-b',
        password: 'pw',
      });

      expect(incr).toHaveBeenCalledWith('ratelimit:school-link:user-1');
    });

    it('propagates the validator\'s UPSTREAM_ERROR rather than reporting bad credentials', async () => {
      // The split that matters: telling a parent their password is wrong
      // during an outage sends them round a loop retyping a correct one.
      const { prisma } = makePrisma();
      const service = makeService(prisma, {
        validator: {
          validate: jest.fn().mockRejectedValue(
            Object.assign(new Error('upstream'), {
              response: { error: { code: 'UPSTREAM_ERROR' } },
            }),
          ),
        },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({ response: { error: { code: 'UPSTREAM_ERROR' } } });
    });
  });

  describe('year resolution', () => {
    it("resolves this school's year independently of the household's other school", async () => {
      const { prisma } = makePrisma();
      const resolveForSchool = jest.fn().mockResolvedValue({ year: 2027, source: 'calendar' });
      const validate = jest.fn().mockResolvedValue(loginPayload());
      const service = makeService(prisma, {
        validator: { validate },
        schoolYear: {
          resolveForSchool,
          reconcileFromLogin: jest.fn((candidate: number) => ({ year: candidate, changed: false })),
          invalidate: jest.fn(),
        },
      });

      await service.createLink('user-1', {
        semel: 999999,
        username: 'parent-b',
        password: 'pw',
      });

      expect(resolveForSchool).toHaveBeenCalledWith(999999);
      expect(validate).toHaveBeenCalledWith(expect.objectContaining({ year: 2027 }));
    });

    it('re-logs in once at the year Mashov confirms', async () => {
      const { prisma } = makePrisma();
      const validate = jest.fn().mockResolvedValue(loginPayload());
      const service = makeService(prisma, {
        validator: { validate },
        schoolYear: {
          resolveForSchool: jest.fn().mockResolvedValue({ year: 2028, source: 'calendar' }),
          reconcileFromLogin: jest.fn().mockReturnValue({ year: 2027, changed: true }),
          invalidate: jest.fn(),
        },
      });

      await service.createLink('user-1', {
        semel: 999999,
        username: 'parent-b',
        password: 'pw',
      });

      expect(validate).toHaveBeenCalledTimes(2);
      expect(validate).toHaveBeenLastCalledWith(expect.objectContaining({ year: 2027 }));
    });

    it('keeps the first login when the corrected re-login fails', async () => {
      // The credentials are already proven good, so this must not surface as
      // INVALID_CREDENTIALS.
      const { prisma } = makePrisma();
      const validate = jest
        .fn()
        .mockResolvedValueOnce(loginPayload())
        .mockRejectedValueOnce(new Error('re-login refused'));
      const service = makeService(prisma, {
        validator: { validate },
        schoolYear: {
          resolveForSchool: jest.fn().mockResolvedValue({ year: 2028, source: 'calendar' }),
          reconcileFromLogin: jest.fn().mockReturnValue({ year: 2027, changed: true }),
          invalidate: jest.fn(),
        },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).resolves.toBeTruthy();
    });
  });
});
