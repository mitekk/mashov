import { UnauthorizedException } from '@nestjs/common';
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
      // Children are counted over the visibility edge (ADR-0031), so a child
      // the other parent's connection holds the stamp for still counts here.
      studentConnection: { groupBy: studentGroupBy },
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
    connectionService?: unknown;
    appSession?: unknown;
  } = {},
) {
  return new SchoolLinksService(
    prisma,
    (overrides.redis ?? {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    }) as never,
    (overrides.encryption ?? { encrypt: jest.fn((value: string) => `enc:${value}`) }) as never,
    (overrides.schoolYear ?? {
      resolveForSchool: jest.fn().mockResolvedValue({ year: 2027, source: 'calendar' }),
      reconcileFromLogin: jest.fn((candidate: number) => ({ year: candidate, changed: false })),
      invalidate: jest.fn(),
    }) as never,
    (overrides.validator ?? { validate: jest.fn() }) as never,
    (overrides.sync ?? { refreshAll: jest.fn().mockResolvedValue({ status: 'success' }) }) as never,
    (overrides.connectionService ?? {
      updateConnection: jest.fn().mockResolvedValue({ ok: true }),
      deleteConnection: jest.fn().mockResolvedValue({ ok: true }),
    }) as never,
    (overrides.appSession ?? {
      revokeAllSessionsForUser: jest.fn().mockResolvedValue(undefined),
    }) as never,
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
    /** Active connections the foreign owner holds BESIDES the one being added. */
    orphanOtherActive?: number;
    orphanSessions?: Array<{ sessionToken: string }>;
    orphanItemStates?: Array<Record<string, unknown>>;
    /** Digest subscriptions the surviving household already holds. */
    targetRecipients?: Array<{ studentGuid: string; channel: string; address: string }>;
  } = {}) {
    const upsert = jest.fn().mockResolvedValue({ id: 'conn-new' });
    const studentUpsert = jest.fn().mockResolvedValue({});
    const linkUpsert = jest.fn().mockResolvedValue({});
    const studentUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

    // Everything the merge transaction writes. `$transaction` runs the
    // callback against this same object, which is how the assertions below
    // see the writes without a real database.
    const connectionUpdate = jest.fn().mockResolvedValue({ id: 'conn-foreign' });
    // Guarded: the re-point is an updateMany keyed on the owner we decided
    // against, so a connection that changed hands under us updates 0 rows.
    const connectionUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const appUserUpdate = jest.fn().mockResolvedValue({});
    const sessionFindMany = jest
      .fn()
      .mockResolvedValue(options.orphanSessions ?? [{ sessionToken: 'tok-orphan' }]);
    const sessionUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const digestUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    // The surviving household's own subscriptions, for the collision check.
    const digestFindMany = jest.fn().mockResolvedValue(options.targetRecipients ?? []);
    const digestDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const ledgerUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const executeRaw = jest.fn().mockResolvedValue(0);
    const activityUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const itemStateFindMany = jest
      .fn()
      .mockResolvedValue(options.orphanItemStates ?? []);
    const itemStateCreateMany = jest.fn().mockResolvedValue({ count: 0 });
    const connectionCount = jest
      .fn()
      .mockResolvedValue(options.orphanOtherActive ?? 0);

    const prisma: Record<string, unknown> = {};
    const transaction = jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.resolve([]),
    );

    return {
      upsert,
      studentUpsert,
      linkUpsert,
      studentUpdateMany,
      connectionUpdate,
      connectionUpdateMany,
      appUserUpdate,
      sessionFindMany,
      sessionUpdateMany,
      digestUpdateMany,
      digestFindMany,
      digestDeleteMany,
      ledgerUpdateMany,
      deliveryUpdateMany,
      executeRaw,
      activityUpdateMany,
      itemStateFindMany,
      itemStateCreateMany,
      connectionCount,
      transaction,
      prisma: Object.assign(prisma, {
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
            options.orphanUserId === undefined
              ? null
              : {
                  id: 'conn-foreign',
                  userId: options.orphanUserId,
                  upstreamUserId: 'mashov-foreign',
                },
          ),
          count: connectionCount,
          update: connectionUpdate,
          updateMany: connectionUpdateMany,
          upsert,
        },
        appUser: { update: appUserUpdate },
        appSession: { findMany: sessionFindMany, updateMany: sessionUpdateMany },
        digestRecipient: {
          updateMany: digestUpdateMany,
          findMany: digestFindMany,
          deleteMany: digestDeleteMany,
        },
        digestReportedItem: { updateMany: ledgerUpdateMany },
        digestDelivery: { updateMany: deliveryUpdateMany },
        $executeRaw: executeRaw,
        schoolActivity: { updateMany: activityUpdateMany },
        userItemState: { findMany: itemStateFindMany, createMany: itemStateCreateMany },
        $transaction: transaction,
        studentConnection: {
          upsert: linkUpsert,
          groupBy: jest.fn().mockResolvedValue([
            { householdConnectionId: 'conn-new', _count: { _all: 1 } },
          ]),
        },
        student: {
          upsert: studentUpsert,
          updateMany: studentUpdateMany,
        },
        syncRun: { groupBy: jest.fn().mockResolvedValue([]) },
      }) as unknown as PrismaService,
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

  it('grants the new connection a view of its children', async () => {
    // Stamping alone was not enough: the stamp routes, the link decides who
    // may see. A child the other parent's connection already lists must gain a
    // second link rather than have its stamp taken over (ADR-0031).
    const { prisma, linkUpsert } = makePrisma();
    const validate = jest.fn().mockResolvedValue(loginPayload());
    const service = makeService(prisma, { validator: { validate } });

    await service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' });

    expect(linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          studentGuid_householdConnectionId: {
            studentGuid: 'guid-b1',
            householdConnectionId: 'conn-new',
          },
        },
      }),
    );
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

    // B2. This used to be a flat `CONNECTION_ALREADY_LINKED` with no way
    // forward in the app: a parent who signed into school B first could never
    // add B from school A's session, and nothing explained why. It is now an
    // offer -- but only once the caller has proved they hold that school's
    // password, which is the same authorisation adoption relies on
    // (ADR-0029). The stub therefore has to resolve a real login payload; a
    // bare `jest.fn()` no longer reaches the decision.
    it('offers a merge for an account another household owns', async () => {
      const { prisma, upsert } = makePrisma({ orphanUserId: 'someone-else' });
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({
        response: {
          error: {
            code: 'MERGE_AVAILABLE',
            // What the parent needs to recognise the household, and nothing
            // more: no email, no phone, no other parent's name.
            merge: { schoolName: 'תיכון רמון', childrenCount: 1 },
          },
        },
      });
      // Two calls, not one. A merge revokes another household's sessions and
      // moves its state; it must not ride along on submitting the form.
      expect(upsert).not.toHaveBeenCalled();
    });

    // A wrong password must answer the same thing it answers for any school.
    // Deciding the merge after validation strictly REDUCES what a caller
    // learns: today's refusal arrives with no password proven at all.
    it('answers INVALID_CREDENTIALS with no hint that the account exists elsewhere', async () => {
      const { prisma } = makePrisma({ orphanUserId: 'someone-else' });
      const service = makeService(prisma, {
        validator: {
          validate: jest.fn().mockRejectedValue(
            new UnauthorizedException({
              error: { code: 'INVALID_CREDENTIALS', message: 'bad', details: [] },
            }),
          ),
        },
      });

      const error = await service
        .createLink('user-1', { semel: 999999, username: 'parent-b', password: 'wrong' })
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(error).toMatchObject({
        response: { error: { code: 'INVALID_CREDENTIALS' } },
      });
      expect(JSON.stringify(error)).not.toContain('MERGE');
      expect(JSON.stringify(error)).not.toContain('someone-else');
    });

    // `AppUser.mergedIntoUserId` is defined for the case where the AppUser's
    // ONLY connection was absorbed. A household actively using two schools is
    // not an orphan, and pulling one school out of it would leave the pointer
    // naming a household that still exists -- so that state keeps today's
    // refusal.
    it('refuses rather than offers when the other household has more schools', async () => {
      const { prisma } = makePrisma({
        orphanUserId: 'someone-else',
        orphanOtherActive: 1,
      });
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({
        response: { error: { code: 'CONNECTION_ALREADY_LINKED' } },
      });
    });

    it('performs the merge when the parent confirms it', async () => {
      const {
        prisma,
        connectionUpdateMany,
        appUserUpdate,
        sessionUpdateMany,
        digestUpdateMany,
        digestDeleteMany,
        activityUpdateMany,
        itemStateCreateMany,
        transaction,
        upsert,
      } = makePrisma({
        orphanUserId: 'someone-else',
        orphanItemStates: [
          { userId: 'someone-else', itemType: 'homework', itemId: 'hw-1', isNew: false, isArchived: true },
        ],
      });
      const revokeAllSessionsForUser = jest.fn().mockResolvedValue(undefined);
      const del = jest.fn().mockResolvedValue(undefined);
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
        redis: { incr: jest.fn().mockResolvedValue(1), expire: jest.fn(), del },
        appSession: { revokeAllSessionsForUser },
      });

      await expect(
        service.createLink('user-1', {
          semel: 999999,
          username: 'parent-b',
          password: 'pw',
          confirmMerge: true,
        }),
      ).resolves.toBeTruthy();

      expect(transaction).toHaveBeenCalled();
      // Re-parented with the audit fields: who asserted "this account is
      // mine", and when. Nothing reads them for scoping (ADR-0029).
      expect(connectionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // Keyed on the owner the verdict was made against, so a connection
          // that changed hands in the meantime matches nothing.
          where: { id: 'conn-foreign', userId: 'someone-else' },
          data: expect.objectContaining({ userId: 'user-1', linkedByUserId: 'user-1' }),
        }),
      );
      expect(appUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'someone-else' },
          data: { mergedIntoUserId: 'user-1' },
        }),
      );
      expect(sessionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'someone-else', revokedAt: null },
        }),
      );
      // The Redis mirror is what actually ends a session: `validateSession`
      // answers from `session:<token>` without consulting the DB, so a row
      // revoked in Postgres stays live until the key is gone. Deleted both
      // before the transaction (self-healing on rollback) and after it
      // (closing the repopulation race).
      // TWICE, on both sides of the transaction, and that is not belt-and-
      // braces: `revokeAllSessionsForUser` only deletes keys for sessions its
      // own `revokedAt: null` query returns, and the transaction has already
      // revoked every one of them -- so post-commit it finds nothing and
      // clears nothing. A request that re-validated mid-transaction (the
      // uncommitted `revokedAt` is invisible to it) repopulates the key with
      // a rolling 300s TTL and the orphan's session survives indefinitely.
      // The second pass over the tokens read BEFORE the transaction is what
      // actually closes that.
      expect(del.mock.calls.filter(([key]) => key === 'session:tok-orphan')).toHaveLength(2);
      // Still called, for a different reason: it catches a session minted
      // *during* the merge, which the pre-read list cannot know about.
      expect(revokeAllSessionsForUser).toHaveBeenCalledWith('someone-else');
      expect(digestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'someone-else' },
          data: { userId: 'user-1' },
        }),
      );
      // Nothing to delete: this household holds no subscription the orphan
      // could collide with.
      expect(digestDeleteMany).not.toHaveBeenCalled();
      expect(activityUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'someone-else', householdConnectionId: 'conn-foreign' },
          data: { userId: 'user-1' },
        }),
      );
      // Copied, not moved, and conflicts skipped: the surviving household's
      // own value for an item it already has wins, because a merge that 500s
      // halfway is worse than one that keeps A's preference.
      expect(itemStateCreateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDuplicates: true,
          data: [
            {
              userId: 'user-1',
              itemType: 'homework',
              itemId: 'hw-1',
              isNew: false,
              isArchived: true,
            },
          ],
        }),
      );
      // And the link is then persisted as any other link is.
      expect(upsert).toHaveBeenCalled();
    });

    it('moves the dedup ledger and the delivery log with the subscription', async () => {
      // Both tables gained a `userId` with the per-user digest (ADR-0035), and
      // the merge has to carry them or the repointed recipient -- whose
      // `activeFrom` can be months old -- arrives at the merged household with
      // an empty ledger, and its next run re-reports the whole active window:
      // today's behaviour, three days of new homework, fourteen of
      // hint-matched due homework, seven of consent forms.
      const { prisma, ledgerUpdateMany, deliveryUpdateMany, executeRaw } = makePrisma({
        orphanUserId: 'someone-else',
      });
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
        redis: { incr: jest.fn().mockResolvedValue(1), expire: jest.fn(), del: jest.fn() },
        appSession: { revokeAllSessionsForUser: jest.fn().mockResolvedValue(undefined) },
      });

      await expect(
        service.createLink('user-1', {
          semel: 999999,
          username: 'parent-b',
          password: 'pw',
          confirmMerge: true,
        }),
      ).resolves.toBeTruthy();

      // The colliding ledger rows go first, by correlated subquery rather than
      // an IN list: the ledger is unbounded, so a list of its keys would
      // eventually exceed Postgres's bind-parameter limit and break the merge
      // for good.
      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(ledgerUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'someone-else' },
          data: { userId: 'user-1' },
        }),
      );
      expect(deliveryUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'someone-else' },
          data: { userId: 'user-1' },
        }),
      );
    });

    it('drops the orphan subscription the surviving household already holds', async () => {
      // Exactly the household this feature exists for: both parents have
      // linked the same family chat for the same child. The recipient key now
      // carries the userId, so re-pointing the orphan's row onto an identical
      // tuple is a P2002 inside the transaction -- the whole merge 500s and
      // the parent cannot combine their schools at all. The surviving row
      // wins; the orphan's duplicate is dropped.
      const { prisma, digestDeleteMany, digestUpdateMany } = makePrisma({
        orphanUserId: 'someone-else',
        targetRecipients: [{ studentGuid: 'stu-1', channel: 'telegram', address: '98765' }],
      });
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
        redis: { incr: jest.fn().mockResolvedValue(1), expire: jest.fn(), del: jest.fn() },
        appSession: { revokeAllSessionsForUser: jest.fn().mockResolvedValue(undefined) },
      });

      await expect(
        service.createLink('user-1', {
          semel: 999999,
          username: 'parent-b',
          password: 'pw',
          confirmMerge: true,
        }),
      ).resolves.toBeTruthy();

      expect(digestDeleteMany).toHaveBeenCalledWith({
        where: {
          userId: 'someone-else',
          OR: [{ studentGuid: 'stu-1', channel: 'telegram', address: '98765' }],
        },
      });
      // The rest still travels: only the colliding tuple is dropped.
      expect(digestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'someone-else' } }),
      );
    });

    // `MASHOV_ENABLE_SCHOOL_LINK_ADOPTION=false` is documented as the switch
    // for turning the whole trust model off. The merge is a strictly MORE
    // invasive version of it -- it revokes the other household's sessions and
    // moves its rows -- so the switch has to cover it too, or it goes inert
    // for exactly the households that merged.
    it('refuses the merge when adoption is disabled', async () => {
      const previous = process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION;
      process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION = 'false';
      try {
        const { prisma, transaction } = makePrisma({ orphanUserId: 'someone-else' });
        const service = makeService(prisma, {
          validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
        });

        await expect(
          service.createLink('user-1', {
            semel: 999999,
            username: 'parent-b',
            password: 'pw',
            confirmMerge: true,
          }),
        ).rejects.toMatchObject({
          response: { error: { code: 'CONNECTION_ALREADY_LINKED' } },
        });
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION;
        else process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION = previous;
      }
    });

    it('does not offer a merge when adoption is disabled', async () => {
      const previous = process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION;
      process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION = 'false';
      try {
        const { prisma } = makePrisma({ orphanUserId: 'someone-else' });
        const service = makeService(prisma, {
          validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
        });

        const error = await service
          .createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' })
          .then(
            () => null,
            (err: unknown) => err,
          );

        expect(error).toMatchObject({
          response: { error: { code: 'CONNECTION_ALREADY_LINKED' } },
        });
        expect(JSON.stringify(error)).not.toContain('MERGE');
      } finally {
        if (previous === undefined) delete process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION;
        else process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION = previous;
      }
    });

    // The gate is decided before an upstream login that takes seconds. Inside
    // the transaction it has to hold again, or the two things it exists to
    // prevent happen anyway.
    it('aborts the merge if the connection changed owner under it', async () => {
      const { prisma, connectionUpdateMany, appUserUpdate } = makePrisma({
        orphanUserId: 'someone-else',
      });
      // Someone else re-parented it between the verdict and the commit.
      connectionUpdateMany.mockResolvedValue({ count: 0 });
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      });

      await expect(
        service.createLink('user-1', {
          semel: 999999,
          username: 'parent-b',
          password: 'pw',
          confirmMerge: true,
        }),
      ).rejects.toMatchObject({
        response: { error: { code: 'CONNECTION_ALREADY_LINKED' } },
      });
      expect(appUserUpdate).not.toHaveBeenCalled();
    });

    it('aborts the merge if the other household gained a school under it', async () => {
      const { prisma, connectionCount, appUserUpdate } = makePrisma({
        orphanUserId: 'someone-else',
      });
      // mergeable at verdict time, not mergeable by commit time.
      connectionCount.mockResolvedValueOnce(0).mockResolvedValue(1);
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      });

      await expect(
        service.createLink('user-1', {
          semel: 999999,
          username: 'parent-b',
          password: 'pw',
          confirmMerge: true,
        }),
      ).rejects.toMatchObject({
        response: { error: { code: 'CONNECTION_ALREADY_LINKED' } },
      });
      expect(appUserUpdate).not.toHaveBeenCalled();
    });

    it('ignores confirmMerge when there is no foreign owner to merge', async () => {
      const { prisma, transaction, appUserUpdate, upsert } = makePrisma({
        orphanUserId: null,
      });
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      });

      await expect(
        service.createLink('user-1', {
          semel: 999999,
          username: 'parent-b',
          password: 'pw',
          confirmMerge: true,
        }),
      ).resolves.toBeTruthy();
      expect(transaction).not.toHaveBeenCalled();
      expect(appUserUpdate).not.toHaveBeenCalled();
      expect(upsert).toHaveBeenCalled();
    });

    it('refuses to merge a household with more schools even when confirmed', async () => {
      const { prisma, transaction } = makePrisma({
        orphanUserId: 'someone-else',
        orphanOtherActive: 2,
      });
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      });

      await expect(
        service.createLink('user-1', {
          semel: 999999,
          username: 'parent-b',
          password: 'pw',
          confirmMerge: true,
        }),
      ).rejects.toMatchObject({
        response: { error: { code: 'CONNECTION_ALREADY_LINKED' } },
      });
      expect(transaction).not.toHaveBeenCalled();
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

    it('does not spend a rate-limit slot on a local refusal', async () => {
      // Five attempts at an already-linked school used to lock linking for
      // fifteen minutes without a single upstream call. The checks that read
      // only this household's own rows are free, so they run first.
      const { prisma } = makePrisma({
        existing: [{ id: 'conn-a', schoolCode: 999999, username: 'mother' }],
      });
      const incr = jest.fn().mockResolvedValue(1);
      const service = makeService(prisma, {
        redis: { incr, expire: jest.fn() },
        validator: { validate: jest.fn() },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'father', password: 'pw' }),
      ).rejects.toMatchObject({
        response: { error: { code: 'SCHOOL_ALREADY_LINKED' } },
      });
      expect(incr).not.toHaveBeenCalled();
    });

    it('does spend a rate-limit slot on a foreign-owner refusal', async () => {
      // The other half of the split, and the reason it is a split rather than
      // a reorder: the orphan lookup is an existence oracle on
      // (schoolCode, username) across every household on the deployment, so
      // an authenticated attacker must not be able to probe it unbounded to
      // enumerate parent usernames per school. That one check stays behind
      // the limit.
      //
      // B2 moved the *decision* after credential validation, so this case now
      // ends in MERGE_AVAILABLE rather than a flat refusal -- but R17's
      // invariant is about the lookup, not the verdict: the oracle stays
      // behind the limit either way.
      const { prisma } = makePrisma({ orphanUserId: 'someone-else' });
      const incr = jest.fn().mockResolvedValue(1);
      const service = makeService(prisma, {
        redis: { incr, expire: jest.fn() },
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
      });

      await expect(
        service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' }),
      ).rejects.toMatchObject({
        response: { error: { code: 'MERGE_AVAILABLE' } },
      });
      expect(incr).toHaveBeenCalledWith('ratelimit:school-link:user-1');
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
      ).rejects.toMatchObject({
        // 429, not 409: the frontend keys on the code, but a proxy retry
        // policy or any other client keys on the status, and a throttle is
        // not a conflict. `.claude/rules/api.md`.
        status: 429,
        response: { error: { code: 'RATE_LIMITED' } },
      });
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

  describe('school name fallback', () => {
    // T13 finding 1. School B's Mashov login omits
    // `schoolSettings.schoolName` entirely, and the writers passed it straight
    // through, so the column was NULL and every `?? String(schoolCode)`
    // fallback downstream made the chip and the contact card read `484121`.
    // The real name was in the public `/api/schools` list the sign-in form
    // already loads, and `SchoolYearService` already fetches that list on every
    // login — so the fix is one lookup at write time, with no new upstream call
    // on the cached path.
    it("stores the public list's name when the login omits it", async () => {
      const { prisma, upsert } = makePrisma();
      const validate = jest.fn().mockResolvedValue(loginPayload({ schoolSettings: { schoolYear: 2027 } }));
      const schoolNameFor = jest.fn().mockResolvedValue('חטיבת נעורים בראשית - צור יצחק (חטב)');
      const service = makeService(prisma, {
        validator: { validate },
        schoolYear: {
          resolveForSchool: jest.fn().mockResolvedValue({ year: 2027, source: 'calendar' }),
          reconcileFromLogin: jest.fn((candidate: number) => ({ year: candidate, changed: false })),
          invalidate: jest.fn(),
          schoolNameFor,
        },
      });

      await service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' });

      expect(schoolNameFor).toHaveBeenCalledWith(999999);
      const [args] = upsert.mock.calls[0] as [{ create: { schoolName?: string }; update: { schoolName?: string } }];
      expect(args.create.schoolName).toBe('חטיבת נעורים בראשית - צור יצחק (חטב)');
      expect(args.update.schoolName).toBe('חטיבת נעורים בראשית - צור יצחק (חטב)');
    });

    it('prefers the name the login does carry, and does not look it up', async () => {
      const { prisma, upsert } = makePrisma();
      const schoolNameFor = jest.fn().mockResolvedValue('something else');
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload()) },
        schoolYear: {
          resolveForSchool: jest.fn().mockResolvedValue({ year: 2027, source: 'calendar' }),
          reconcileFromLogin: jest.fn((candidate: number) => ({ year: candidate, changed: false })),
          invalidate: jest.fn(),
          schoolNameFor,
        },
      });

      await service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' });

      const [args] = upsert.mock.calls[0] as [{ create: { schoolName?: string } }];
      expect(args.create.schoolName).toBe('תיכון רמון');
      expect(schoolNameFor).not.toHaveBeenCalled();
    });

    it('writes undefined when neither source has a name, so an existing one survives', async () => {
      // Prisma leaves a field alone on `undefined`, so the fallback can never
      // DOWNGRADE a good name already stored. `?? String(schoolCode)` stays the
      // last resort at the read sites: a semel is a worse label than a name but
      // better than blank.
      const { prisma, upsert } = makePrisma();
      const service = makeService(prisma, {
        validator: { validate: jest.fn().mockResolvedValue(loginPayload({ schoolSettings: { schoolYear: 2027 } })) },
        schoolYear: {
          resolveForSchool: jest.fn().mockResolvedValue({ year: 2027, source: 'calendar' }),
          reconcileFromLogin: jest.fn((candidate: number) => ({ year: candidate, changed: false })),
          invalidate: jest.fn(),
          schoolNameFor: jest.fn().mockResolvedValue(null),
        },
      });

      await service.createLink('user-1', { semel: 999999, username: 'parent-b', password: 'pw' });

      const [args] = upsert.mock.calls[0] as [{ update: Record<string, unknown> }];
      expect(args.update.schoolName).toBeUndefined();
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
