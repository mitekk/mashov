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
import type { SyncOnReadService } from '../../backend/src/sync/sync-on-read.service';
import type { UserDetailsTask } from '../../backend/src/sync/tasks/user-details.task';
import { SettingsService } from '../../backend/src/settings/settings.service';
import { SyncRunRetentionService } from '../../backend/src/sync/sync-run-retention.service';
import { ROSTER_ABSENCE_GRACE_DAYS } from '../../backend/src/sync/roster-presence.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { SchoolYearService } from '../../backend/src/common/school-year/school-year.service';

const SEMEL_A = 662201;
const SEMEL_B = 662202;
/** The third school, for USER_A's second connection. */
const SEMEL_A2 = 662203;
const SEMELS = [SEMEL_A, SEMEL_B, SEMEL_A2];
const YEAR = 2027;

const USER_A = 'sh-user-a';
const USER_B = 'sh-user-b';
const ALL_USERS = [USER_A, USER_B];

const CONN_A = 'sh-conn-a';
const CONN_B = 'sh-conn-b';
/** USER_A's SECOND connection, at a third school — T13's own shape: one parent, two schools. */
const CONN_A2 = 'sh-conn-a2';

const GUID_A = 'sh-guid-a';
const GUID_B = 'sh-guid-b';
/**
 * USER_A's other child, at their other school.
 *
 * Deliberately NOT `sh-guid-a2`: the assertions below use `.includes(guid)`,
 * and a guid that is a prefix of another makes them match the wrong key.
 */
const GUID_A2 = 'sh-guid-second';
/**
 * A departed child at USER_A's first school: `isActive: false`, still linked.
 *
 * `RosterPresenceService` writes this state when a child stops appearing in
 * every roster. From that moment no per-student task touches her, so her last
 * run's verdict is frozen — and if it failed, `/more` printed it forever.
 */
const GUID_GONE = 'sh-guid-departed';
/**
 * The children a sync still touches. The departed one is deliberately absent:
 * `studentScopeForContext` filters `isActive: true`, so no recent run of hers
 * can exist, and seeding one would hide the orphan behind the grace window.
 */
const ACTIVE_GUIDS = [GUID_A, GUID_B, GUID_A2];
/** Everything this file writes, for cleanup. */
const ALL_GUIDS = [...ACTIVE_GUIDS, GUID_GONE];

/** Every run key this file writes, so cleanup keys on a list rather than a prefix match. */
const RUN_SOURCES = [
  'mail_inbox',
  `mail_inbox:${CONN_A}`,
  `homework:${GUID_A}`,
  `homework:${GUID_B}`,
  `behavior:${GUID_A}`,
  `behavior:${GUID_B}`,
  `groups:${GUID_A}`,
  `homework:${GUID_A2}`,
  `behavior:${GUID_A2}`,
  `groups:${GUID_A2}`,
  `homework:${GUID_GONE}`,
  `behavior:${GUID_GONE}`,
  `history:2025:homework:${GUID_GONE}`,
];

const MINUTE = 60 * 1000;
const DAY_MINUTES = 24 * 60;

/** Well past `ROSTER_ABSENCE_GRACE_DAYS`, so the orphan sweep considers it. */
const DEPARTED_FAILURE_MINUTES = (ROSTER_ABSENCE_GRACE_DAYS + 4) * DAY_MINUTES;
const DEPARTED_SUCCESS_MINUTES = DEPARTED_FAILURE_MINUTES + 120;
const LONG_AGO = new Date(Date.now() - DEPARTED_SUCCESS_MINUTES * MINUTE);

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
      // Same `userId` as CONN_A: a merged household with two schools, which is
      // exactly the configuration T13 observed finding 4 in.
      [CONN_A2, USER_A, SEMEL_A2],
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

    const child = (studentGuid: string, stamp: string, isActive = true) => ({
      studentGuid,
      privateName: 'ילד',
      familyName: 'כלשהו',
      fullName: `ילד ${studentGuid}`,
      classCode: 'ז',
      classNum: 1,
      gender: 'M',
      isActive,
      householdConnectionId: stamp,
    });

    await prisma.student.createMany({
      data: [
        child(GUID_A, CONN_A),
        child(GUID_B, CONN_B),
        child(GUID_A2, CONN_A2),
        child(GUID_GONE, CONN_A, false),
      ],
    });

    // One child each, by the visibility edge — the authority per ADR-0031.
    await prisma.studentConnection.createMany({
      data: [
        { studentGuid: GUID_A, householdConnectionId: CONN_A, lastSeenInRosterAt: new Date() },
        { studentGuid: GUID_B, householdConnectionId: CONN_B, lastSeenInRosterAt: new Date() },
        { studentGuid: GUID_A2, householdConnectionId: CONN_A2, lastSeenInRosterAt: new Date() },
        // Still linked. Her rows survive the visibility filter, so whatever
        // drops her has to be the activity filter.
        { studentGuid: GUID_GONE, householdConnectionId: CONN_A, lastSeenInRosterAt: LONG_AGO },
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
    for (const guid of ACTIVE_GUIDS) {
      await run(`homework:${guid}`, 'success', 30, null);
      await run(`behavior:${guid}`, 'success', 30, null);
    }

    // `groups` only ever runs inside a connection-scoped refresh, so it has no
    // NULL-stamped row at all. A's ran and succeeded; B's guid has nothing.
    await run(`groups:${GUID_A}`, 'success', 30, CONN_A);
    await run(`groups:${GUID_A2}`, 'success', 30, CONN_A2);

    // The departed child, in the shape the live account was in: a success,
    // then a LATER failure, then silence. `errorIsSpent` compares the two and
    // correctly says the error still explains itself — her last success
    // predates her last failure — so nothing suppresses it, and no future run
    // can ever change the comparison. The key is what must stop existing.
    await run(`homework:${GUID_GONE}`, 'success', DEPARTED_SUCCESS_MINUTES, null);
    await run(
      `homework:${GUID_GONE}`,
      'failed',
      DEPARTED_FAILURE_MINUTES,
      null,
      'every connection failed for sh-guid-departed (tried 1)',
    );
    await run(`behavior:${GUID_GONE}`, 'failed', DEPARTED_FAILURE_MINUTES, null, 'every connection failed');
    // A backfill key for the same orphan, under `context.sourcePrefix`.
    await run(`history:2025:homework:${GUID_GONE}`, 'success', DEPARTED_SUCCESS_MINUTES, null);
  }

  function makeSettings(): SettingsService {
    const freshness = new FreshnessService(
      new SyncRunService(prisma as unknown as PrismaService),
      prisma as unknown as PrismaService,
      {
        resolveForSchool: async () => ({ year: YEAR, source: 'calendar' as const }),
      } as unknown as SchoolYearService,
    );
    return new SettingsService(
      prisma as unknown as PrismaService,
      freshness,
      // Read-path freshening, inert under NODE_ENV=test.
      { ensureFresh: async () => undefined, deadlineFromNow: () => Date.now() + 4_000 } as unknown as SyncOnReadService,
      { execute: async () => undefined } as unknown as UserDetailsTask,
    );
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

  describe('finding 4 — a foreign guid must not decide a row’s status', () => {
    it('does not report groups never_synced for the connection whose groups run succeeded', async () => {
      const { sources } = await makeSettings().getSourceHealth(CONN_A, USER_A);
      const groups = sources.filter((s) => s.source.startsWith('groups'));

      expect(groups.length).toBeGreaterThan(0);
      // The defect: `groups` only ever runs inside a connection-scoped refresh,
      // so B's guid has no NULL-stamped row to find and yields `never_synced`.
      // `normalizeSources` then reduces the variants worst-wins and the row
      // goes red minutes after A's own `groups` succeeded.
      expect(groups.map((s) => s.status)).not.toContain('never_synced');
      expect(sources.find((s) => s.source === `groups:${GUID_A}`)?.status).toBe('fresh');
    });

    it('keeps the card per-connection in a merged two-school household', async () => {
      // T13's own shape, and the one the first version of this file missed: ONE
      // `appUser` with TWO connections, one child at each school. The unstamped
      // cron put both children's guids in both snapshots, which is finding 4.
      //
      // The card is per connection by design — source health is a property of
      // the connection that runs the syncs, and `SettingsController` picks one
      // by `lastLoginAt`. So conn-A's card speaks for conn-A's child only.
      // Dropping the parent's OTHER child here is the fix, not a regression:
      // conn-A never syncs that child, so `groups:<guidA2>` on conn-A's card
      // could only ever read `never_synced` — which is the red row the parent
      // saw minutes after `groups` had succeeded at both schools.
      const a = await makeSettings().getSourceHealth(CONN_A, USER_A);
      const a2 = await makeSettings().getSourceHealth(CONN_A2, USER_A);

      expect(a.sources.some((s) => s.source.includes(GUID_A2))).toBe(false);
      expect(a2.sources.some((s) => s.source.includes(GUID_A))).toBe(false);

      // And each card is accurate about its own connection's child, rather
      // than red about the other's.
      expect(a.sources.find((s) => s.source === `groups:${GUID_A}`)?.status).toBe('fresh');
      expect(a2.sources.find((s) => s.source === `groups:${GUID_A2}`)?.status).toBe('fresh');
      for (const { sources } of [a, a2]) {
        expect(
          sources.filter((s) => s.source.startsWith('groups')).map((s) => s.status),
        ).not.toContain('never_synced');
      }
    });

    it('never mentions the other household’s guid', async () => {
      const { sources } = await makeSettings().getSourceHealth(CONN_A, USER_A);

      expect(sources.some((s) => s.source.includes(GUID_B))).toBe(false);
    });

    it('still lists a child no connection lists at all', async () => {
      // Unlinked is readable. This is the half that must NOT narrow — the same
      // reading as `canSeeStudent`, and `household-isolation` is its guard.
      await prisma.studentConnection.deleteMany({ where: { studentGuid: GUID_A } });
      try {
        const { sources } = await makeSettings().getSourceHealth(CONN_A, USER_A);
        expect(sources.some((s) => s.source === `groups:${GUID_A}`)).toBe(true);
      } finally {
        await prisma.studentConnection.create({
          data: {
            studentGuid: GUID_A,
            householdConnectionId: CONN_A,
            lastSeenInRosterAt: new Date(),
          },
        });
      }
    });
  });

  // The red lines on `/more`: `every connection failed for 38aa0491… (tried 1)`
  // under five of eleven rows, three of them next to a green check. Nothing was
  // broken — the child had left, and the read path had no activity filter.
  describe('a departed child', () => {
    it('is absent from the card even though her runs and her link both exist', async () => {
      const { sources } = await makeSettings().getSourceHealth(CONN_A, USER_A);

      expect(sources.some((s) => s.source.includes(GUID_GONE))).toBe(false);
      // Her rows are still in the table at this point, and her
      // `student_connection` link is intact, so the visibility rule admits
      // her. Only `isActive: false` separates her from GUID_A.
      expect(
        await prisma.syncRun.count({ where: { source: `homework:${GUID_GONE}` } }),
      ).toBeGreaterThan(0);
      expect(sources.some((s) => s.source === `homework:${GUID_A}`)).toBe(true);
    });

    it('leaves no red error anywhere on the card', async () => {
      // The symptom, stated as the user saw it. Her error was unspent and
      // unsupersedable, so this is the whole bug in one assertion.
      const { sources } = await makeSettings().getSourceHealth(CONN_A, USER_A);

      expect(sources.filter((s) => s.lastErrorMessage !== null)).toEqual([]);
    });

    it('has her orphaned rows pruned, while the active child keeps hers', async () => {
      const retention = new SyncRunRetentionService(prisma as unknown as PrismaService);

      await retention.prune();

      for (const source of [
        `homework:${GUID_GONE}`,
        `behavior:${GUID_GONE}`,
        `history:2025:homework:${GUID_GONE}`,
      ]) {
        expect(await prisma.syncRun.count({ where: { source } })).toBe(0);
      }

      // Inside the grace window, so untouched regardless — and the key the
      // card actually reads.
      expect(
        await prisma.syncRun.count({ where: { source: `homework:${GUID_A}` } }),
      ).toBeGreaterThan(0);
      expect(
        await prisma.syncRun.count({ where: { source: `mail_inbox:${CONN_A}` } }),
      ).toBeGreaterThan(0);
    });
  });
});
