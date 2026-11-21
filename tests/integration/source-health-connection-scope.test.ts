/**
 * **T13 findings 3 and 4** — the source-health card against real Postgres.
 *
 * Both findings are reachable only with two schools linked, which is why 1195
 * unit tests and 12 integration suites pass over them. Both come from the same
 * place: a row that mixes a connection-scoped fact with an unscoped one.
 *
 * The branch-wide NULL rule (`sync-run.service.ts:85-124`, `WHERE
 * ("householdConnectionId" = $1 OR "householdConnectionId" IS NULL)`) is
 * deliberate and load-bearing — every `@Cron` entrypoint opens its run with no
 * connection — so neither fix narrows it. What they fix is the mixing.
 *
 * Both reads under test are raw SQL (`DISTINCT ON (source)`), so a real
 * `PrismaClient` is what makes this an integration test rather than a unit one.
 * It asserts on `SettingsService.getSourceHealth(...)`'s return value, which
 * *is* the body of `GET /settings/source-health`; the controller only picks the
 * connection by `lastLoginAt`, which `settings.controller.spec.ts` covers.
 *
 * Its own seed and cleanup, deliberately not bolted onto `household-isolation`:
 * that file's `cleanup()` deletes connections by a single `schoolCode` and would
 * leave a second school's rows behind. `connection-scope-school-preference` is
 * the precedent followed here.
 */

import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { FreshnessService } from '../../backend/src/sync/freshness.service';
import { SyncRunService } from '../../backend/src/sync/sync-run.service';
import { SettingsService } from '../../backend/src/settings/settings.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { SchoolYearService } from '../../backend/src/common/school-year/school-year.service';

const SEMEL_A = 662201;
const SEMEL_B = 662202;
const SEMELS = [SEMEL_A, SEMEL_B];
const YEAR = 2027;

const USER_A = 'sh-user-a';
const USER_B = 'sh-user-b';
const ALL_USERS = [USER_A, USER_B];

const CONN_A = 'sh-conn-a';
const CONN_B = 'sh-conn-b';

const GUID_A = 'sh-guid-a';
const GUID_B = 'sh-guid-b';
const ALL_GUIDS = [GUID_A, GUID_B];

/** Every run key this file writes, so cleanup keys on a list rather than a prefix match. */
const RUN_SOURCES = [
  'mail_inbox',
  `mail_inbox:${CONN_A}`,
  `homework:${GUID_A}`,
  `homework:${GUID_B}`,
  `behavior:${GUID_A}`,
  `behavior:${GUID_B}`,
  `groups:${GUID_A}`,
];

const MINUTE = 60 * 1000;

describe('Source health for one connection, with two schools in the table', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.syncRun.deleteMany({ where: { source: { in: RUN_SOURCES } } });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    await prisma.householdConnection.deleteMany({ where: { schoolCode: { in: SEMELS } } });
    await prisma.appUser.deleteMany({ where: { id: { in: ALL_USERS } } });
  }

  async function run(
    source: string,
    status: 'success' | 'failed',
    minutesAgo: number,
    householdConnectionId: string | null,
    errorMessage?: string,
  ): Promise<void> {
    const endedAt = new Date(Date.now() - minutesAgo * MINUTE);
    await prisma.syncRun.create({
      data: {
        source,
        status,
        startedAt: new Date(endedAt.getTime() - 5000),
        endedAt,
        householdConnectionId,
        errorMessage: errorMessage ?? null,
      },
    });
  }

  async function seed(): Promise<void> {
    await cleanup();

    for (const [id, semel] of [
      [USER_A, SEMEL_A],
      [USER_B, SEMEL_B],
    ] as Array<[string, number]>) {
      await prisma.appUser.create({
        data: {
          id,
          mashovUserId: `upstream-${id}`,
          username: id,
          displayName: id,
          semel,
        },
      });
    }

    for (const [id, userId, schoolCode] of [
      [CONN_A, USER_A, SEMEL_A],
      [CONN_B, USER_B, SEMEL_B],
    ] as Array<[string, string, number]>) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId,
          username: id,
          schoolCode,
          schoolYear: YEAR,
          encryptedPassword: `enc-${id}`,
          schoolName: `בית ספר ${schoolCode}`,
          active: true,
          lastLoginAt: new Date(),
        },
      });
    }

    const child = (studentGuid: string, stamp: string) => ({
      studentGuid,
      privateName: 'ילד',
      familyName: 'כלשהו',
      fullName: `ילד ${studentGuid}`,
      classCode: 'ז',
      classNum: 1,
      gender: 'M',
      isActive: true,
      householdConnectionId: stamp,
    });

    await prisma.student.createMany({
      data: [child(GUID_A, CONN_A), child(GUID_B, CONN_B)],
    });

    // One child each, by the visibility edge — the authority per ADR-0031.
    await prisma.studentConnection.createMany({
      data: [
        { studentGuid: GUID_A, householdConnectionId: CONN_A, lastSeenInRosterAt: new Date() },
        { studentGuid: GUID_B, householdConnectionId: CONN_B, lastSeenInRosterAt: new Date() },
      ],
    });

    // Finding 3: a NULL-connection failure under the BARE source name, from a
    // cron tick that ran before any connection existed, plus a later
    // connection-scoped success under the variant key.
    await run('mail_inbox', 'failed', 60, null, 'Missing required Mashov credentials in environment variables');
    await run(`mail_inbox:${CONN_A}`, 'success', 2, CONN_A);

    // Finding 4: the unstamped cron tick. It wrote homework and behaviour for
    // BOTH children with no connection, so both schools' guids are in A's
    // snapshot — the NULL rule admitting them is correct, and stays.
    for (const guid of ALL_GUIDS) {
      await run(`homework:${guid}`, 'success', 30, null);
      await run(`behavior:${guid}`, 'success', 30, null);
    }

    // `groups` only ever runs inside a connection-scoped refresh, so it has no
    // NULL-stamped row at all. A's ran and succeeded; B's guid has nothing.
    await run(`groups:${GUID_A}`, 'success', 30, CONN_A);
  }

  function makeSettings(): SettingsService {
    const freshness = new FreshnessService(
      new SyncRunService(prisma as unknown as PrismaService),
      prisma as unknown as PrismaService,
      {
        resolveForSchool: async () => ({ year: YEAR, source: 'calendar' as const }),
      } as unknown as SchoolYearService,
    );
    return new SettingsService(prisma as unknown as PrismaService, freshness);
  }

  describe('finding 3 — a fresh row must not carry a spent error', () => {
    it('reports mail_inbox fresh with no error, though an unstamped failure sits under the bare key', async () => {
      const { sources } = await makeSettings().getSourceHealth(CONN_A, USER_A);
      const mail = sources.find((s) => s.source === 'mail_inbox');

      expect(mail).toBeDefined();
      expect(mail?.status).toBe('fresh');
      // The defect: `status` came from the success variants and
      // `lastErrorMessage` from `allRuns.get('mail_inbox')` — the orphan. On a
      // shared deployment that one NULL row showed its error to every household.
      expect(mail?.lastErrorMessage).toBeNull();
    });
  });

});
