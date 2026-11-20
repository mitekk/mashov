/**
 * The household merge, end to end on real Postgres and real Redis — B2.
 *
 * `AppUser.mergedIntoUserId` and `AuthService.resolveMergedOwner` shipped with
 * tests and nothing wrote the column, so a parent who signed into school B
 * first could never add B from school A's session: `POST /school-links`
 * answered a flat `409 CONNECTION_ALREADY_LINKED` and the app offered no way
 * forward.
 *
 * What only a real database and a real Redis can answer:
 *
 *  1. `AppSessionService.validateSession` returns `payload.userId` straight
 *     from `session:<token>` **without consulting the database**, and its
 *     payload carries no `revokedAt` while it rolls its own TTL. So a session
 *     revoked in Postgres stays live until the key is deleted. A mocked Redis
 *     cannot prove the key is gone; this can.
 *  2. `UserItemState` is copied with `skipDuplicates`, which is Postgres's
 *     `ON CONFLICT DO NOTHING` over `@@unique([userId, itemType, itemId])` —
 *     the surviving household's value has to win, and that is the database's
 *     behaviour, not a mock's.
 *  3. `DigestRecipient`'s unique key is `[studentGuid, channel, address]` and
 *     omits `userId`, so the same tuple cannot exist under both households and
 *     the re-point is collision-free. Proving that needs the real constraint.
 *
 * The suite drives `SchoolLinksService` directly rather than through HTTP: the
 * merge is a service-level transaction, and the credential validator is the
 * only thing that has to be stubbed for it (the DoD's authorisation is "the
 * caller proved they hold that school's password", which is exactly what the
 * validator answers).
 */

import { Test, TestingModule } from '../../backend/node_modules/@nestjs/testing';
import { ConfigModule } from '../../backend/node_modules/@nestjs/config';
import { ScheduleModule } from '../../backend/node_modules/@nestjs/schedule';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';

import { PrismaModule } from '../../backend/src/prisma/prisma.module';
import { RedisModule } from '../../backend/src/redis/redis.module';
import { AppSessionModule } from '../../backend/src/app-session/app-session.module';
import { SchoolLinksModule } from '../../backend/src/school-links/school-links.module';
import { SchoolLinksService } from '../../backend/src/school-links/school-links.service';
import { AppSessionService } from '../../backend/src/app-session/app-session.service';
import { RedisService } from '../../backend/src/redis/redis.service';
import { SyncService } from '../../backend/src/sync/sync.service';
import { MashovCredentialValidatorService } from '../../backend/src/common/mashov-login/mashov-credential-validator.service';

const SEMEL_A = 661101;
const SEMEL_B = 661102;
const USER_A = 'hm-user-a';
const USER_B = 'hm-user-b';
const ALL_USERS = [USER_A, USER_B];
const CONN_A = 'hm-conn-a';
const CONN_B = 'hm-conn-b';
const CHILD_B = 'hm-guid-b';
const USERNAME_B = 'hm-parent-b';

/** The login Mashov would return for school B, with one child. */
function loginPayloadB() {
  return {
    data: {
      credential: { userId: `upstream-${USER_B}`, displayName: 'Parent B' },
      accessToken: {
        schoolSettings: { schoolName: 'School B', schoolYear: 2026 },
        userSchoolYears: [2026],
        username: USERNAME_B,
        children: [
          {
            childGuid: CHILD_B,
            familyName: 'Family',
            privateName: 'Child B',
            classCode: 'ז',
            classNum: 1,
            gender: 'B',
            groups: [],
          },
        ],
      },
    },
    newUniqueId: 'uniq-b',
  };
}

describe('Household merge — adding a school another household already owns', () => {
  let prisma: PrismaClient;
  let moduleRef: TestingModule;
  let schoolLinks: SchoolLinksService;
  let appSession: AppSessionService;
  let redis: RedisService;
  const validate = jest.fn();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        PrismaModule,
        RedisModule,
        AppSessionModule,
        SchoolLinksModule,
      ],
    })
      // The only stub: the upstream login. Everything below it — the
      // transaction, the constraints, the Redis mirror — is real.
      .overrideProvider(MashovCredentialValidatorService)
      .useValue({ validate })
      // `createLink` fires a background refresh it does not await. Left real
      // it would try to reach Mashov after the test finished.
      .overrideProvider(SyncService)
      .useValue({ refreshAll: jest.fn().mockResolvedValue({ status: 'success' }) })
      .compile();

    // `compile()` alone does not run lifecycle hooks, and RedisService opens
    // its client in `onModuleInit`. Without this the service's own
    // `this.redis.incr` throws on an undefined client.
    await moduleRef.init();

    schoolLinks = moduleRef.get(SchoolLinksService);
    appSession = moduleRef.get(AppSessionService);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    await cleanup();
    await moduleRef?.close();
    await prisma.$disconnect();
  });

  /**
   * `appSession` must go BEFORE `appUser`: the relation has no `onDelete`, so
   * Postgres restricts the delete. `digestRecipient` and `schoolActivity` were
   * both missing from every other suite's cleanup, which is why this file has
   * its own.
   */
  async function cleanup(): Promise<void> {
    await prisma.appSession.deleteMany({ where: { userId: { in: ALL_USERS } } });
    await prisma.userItemState.deleteMany({ where: { userId: { in: ALL_USERS } } });
    await prisma.digestRecipient.deleteMany({ where: { userId: { in: ALL_USERS } } });
    await prisma.schoolActivity.deleteMany({ where: { userId: { in: ALL_USERS } } });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: CHILD_B } });
    await prisma.student.deleteMany({ where: { studentGuid: CHILD_B } });
    await prisma.parentProfile.deleteMany({
      where: { upstreamUserId: { in: [`upstream-${USER_A}`, `upstream-${USER_B}`] } },
    });
    await prisma.householdConnection.deleteMany({
      where: { schoolCode: { in: [SEMEL_A, SEMEL_B] } },
    });
    await prisma.appUser.deleteMany({ where: { id: { in: ALL_USERS } } });
  }

  /**
   * Household A with school A, household B with school B and one child.
   *
   * This is the state B2 describes: the parent signed into B first, so B has
   * its own `AppUser`, and ADR-0029 says that is correct — the application
   * cannot know two Mashov accounts are one parent.
   */
  async function seed(): Promise<void> {
    await cleanup();
    validate.mockReset();
    validate.mockResolvedValue(loginPayloadB());
    // Real Redis, real limit: five `createLink` attempts per user per fifteen
    // minutes, and every spec here calls it as the same USER_A. Cleared per
    // spec so the limit is exercised by its own test rather than by test
    // order.
    await redis.del(`ratelimit:school-link:${USER_A}`);

    for (const [id, semel, connId, username] of [
      [USER_A, SEMEL_A, CONN_A, 'hm-parent-a'],
      [USER_B, SEMEL_B, CONN_B, USERNAME_B],
    ] as Array<[string, number, string, string]>) {
      await prisma.appUser.create({
        data: {
          id,
          mashovUserId: `upstream-${id}`,
          semel,
          username,
          displayName: username,
        },
      });
      await prisma.householdConnection.create({
        data: {
          id: connId,
          schoolCode: semel,
          schoolYear: 2026,
          username,
          encryptedPassword: 'mock-encrypted',
          schoolName: `School ${semel}`,
          upstreamUserId: `upstream-${id}`,
          lastLoginAt: new Date(),
          active: true,
          userId: id,
        },
      });
    }

    await prisma.student.create({
      data: {
        studentGuid: CHILD_B,
        privateName: 'Child B',
        familyName: 'Family',
        fullName: 'Child B Family',
        classCode: 'ז',
        classNum: 1,
        gender: 'B',
        isActive: true,
        householdConnectionId: CONN_B,
      },
    });
    await prisma.studentConnection.create({
      data: { studentGuid: CHILD_B, householdConnectionId: CONN_B },
    });
  }

  function addSchoolB(confirmMerge?: boolean) {
    return schoolLinks.createLink(USER_A, {
      semel: SEMEL_B,
      username: USERNAME_B,
      password: 'pw',
      ...(confirmMerge === undefined ? {} : { confirmMerge }),
    });
  }

  it('offers a merge rather than dead-ending, and writes nothing yet', async () => {
    await seed();

    const error = await addSchoolB().then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      response: {
        error: {
          code: 'MERGE_AVAILABLE',
          merge: { schoolName: 'School B', childrenCount: 1 },
        },
      },
    });
    // No email, no phone, no other parent's name.
    expect(JSON.stringify(error)).not.toContain('Parent B');

    // Nothing moved on the offer: the parent has not said yes.
    const connection = await prisma.householdConnection.findUnique({
      where: { id: CONN_B },
    });
    expect(connection?.userId).toBe(USER_B);
    const orphan = await prisma.appUser.findUnique({ where: { id: USER_B } });
    expect(orphan?.mergedIntoUserId).toBeNull();
  });

  it('moves the household when the parent confirms', async () => {
    await seed();

    await prisma.digestRecipient.create({
      data: {
        userId: USER_B,
        studentGuid: CHILD_B,
        channel: 'telegram',
        address: 'hm-chat-1',
        enabled: true,
      },
    });
    await prisma.schoolActivity.create({
      data: {
        userId: USER_B,
        householdConnectionId: CONN_B,
        activityId: 1,
        schoolYear: 2026,
        title: 'Field trip',
        activityStartDate: new Date('2026-05-01T00:00:00Z'),
        activityEndDate: new Date('2026-05-02T00:00:00Z'),
        endAnswerDate: new Date('2026-04-20T00:00:00Z'),
      },
    });
    // One item both households hold an opinion about, and one only B does.
    await prisma.userItemState.createMany({
      data: [
        { userId: USER_A, itemType: 'homework', itemId: 'shared-item', isNew: false, isArchived: false },
        { userId: USER_B, itemType: 'homework', itemId: 'shared-item', isNew: true, isArchived: true },
        { userId: USER_B, itemType: 'homework', itemId: 'b-only-item', isNew: false, isArchived: true },
      ],
    });

    const link = await addSchoolB(true);
    expect(link.semel).toBe(SEMEL_B);

    // The connection is household A's now, with the audit fields ADR-0029
    // requires: who asserted "this account is mine", and when.
    const connection = await prisma.householdConnection.findUnique({
      where: { id: CONN_B },
    });
    expect(connection?.userId).toBe(USER_A);
    expect(connection?.linkedByUserId).toBe(USER_A);
    expect(connection?.linkedAt).not.toBeNull();

    const orphan = await prisma.appUser.findUnique({ where: { id: USER_B } });
    expect(orphan).not.toBeNull();
    expect(orphan?.mergedIntoUserId).toBe(USER_A);

    // Keyed on `[studentGuid, channel, address]`, which omits `userId` — the
    // same tuple cannot exist under both households, so this re-point can
    // never collide and a skip-on-conflict branch would be dead code.
    const recipients = await prisma.digestRecipient.findMany({
      where: { studentGuid: CHILD_B },
    });
    expect(recipients.map((row) => row.userId)).toEqual([USER_A]);

    // Not named in B2's DoD; found while reading. `SchoolActivity.userId` is
    // required with no AppUser relation, so these consent rows would
    // otherwise strand on an AppUser nobody can sign into.
    const activities = await prisma.schoolActivity.findMany({
      where: { householdConnectionId: CONN_B },
    });
    expect(activities.map((row) => row.userId)).toEqual([USER_A]);

    const states = await prisma.userItemState.findMany({
      where: { userId: USER_A },
      orderBy: { itemId: 'asc' },
    });
    expect(states.map((row) => [row.itemId, row.isArchived])).toEqual([
      // Copied: B's row for an item A had no opinion about.
      ['b-only-item', true],
      // Conflict skipped: A's own value survives. A merge that 500s halfway on
      // a unique violation is worse than one that keeps the surviving
      // household's preference.
      ['shared-item', false],
    ]);
  });

  // The DoD's live-session case, and the reason the Redis deletes bracket the
  // transaction. `validateSession` answers from the cache without consulting
  // the database, so revoking the row alone leaves the orphan browsing a
  // household whose every page has quietly emptied.
  it("ends the orphan's live session, cache key included", async () => {
    await seed();

    const token = await appSession.createSession(USER_B);
    expect(await appSession.validateSession(token)).toBe(USER_B);
    expect(await redis.get(`session:${token}`)).not.toBeNull();

    await addSchoolB(true);

    expect(await redis.get(`session:${token}`)).toBeNull();
    const row = await prisma.appSession.findUnique({ where: { sessionToken: token } });
    expect(row?.revokedAt).not.toBeNull();
    // The whole point: the token must not still resolve.
    expect(await appSession.validateSession(token)).toBeNull();
  });

  // A household actively using other schools is not an orphan.
  // `mergedIntoUserId` is documented as "this AppUser's ONLY connection was
  // absorbed", so pulling one school out of a live two-school household would
  // leave the pointer naming a household that still exists.
  it('refuses rather than splitting a household that has other schools', async () => {
    await seed();
    await prisma.householdConnection.create({
      data: {
        id: 'hm-conn-b2',
        schoolCode: SEMEL_B + 1,
        schoolYear: 2026,
        username: `${USERNAME_B}-2`,
        encryptedPassword: 'mock-encrypted',
        active: true,
        userId: USER_B,
      },
    });

    await expect(addSchoolB(true)).rejects.toMatchObject({
      response: { error: { code: 'CONNECTION_ALREADY_LINKED' } },
    });

    const connection = await prisma.householdConnection.findUnique({
      where: { id: CONN_B },
    });
    expect(connection?.userId).toBe(USER_B);

    await prisma.householdConnection.deleteMany({ where: { id: 'hm-conn-b2' } });
  });

  it('answers INVALID_CREDENTIALS with no hint that the account exists elsewhere', async () => {
    await seed();
    const { UnauthorizedException } = await import(
      '../../backend/node_modules/@nestjs/common'
    );
    validate.mockRejectedValue(
      new UnauthorizedException({
        error: { code: 'INVALID_CREDENTIALS', message: 'bad', details: [] },
      }),
    );

    const error = await addSchoolB().then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      response: { error: { code: 'INVALID_CREDENTIALS' } },
    });
    const payload = JSON.stringify(error);
    expect(payload).not.toContain('MERGE');
    expect(payload).not.toContain(USER_B);
  });
});
