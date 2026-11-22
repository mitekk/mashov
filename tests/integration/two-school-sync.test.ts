/**
 * Two schools, one household, two full syncs — the cross-contamination test.
 *
 * This is the test the plan asked for and B1 was closed without: seed two
 * connections, two children and two mailboxes, then run `SyncService.refreshAll`
 * for each connection in turn and assert that neither run wrote into the
 * other's rows. B1's own fix was proved by moving the routing stamp directly —
 * the only thing a sync changes about ownership — but that is not the same as
 * running the two syncs, and everything below the stamp (the mail sweep, the
 * cached badge, the per-school unique keys, the year each row is labelled
 * with) is only exercised by actually running them.
 *
 * It is a real refresh: the wired `SyncModule`, all seventeen tasks, real
 * Postgres and real Redis. Only the two transports are fakes —
 * `MashovHttpClient`, and the private `httpClient` axios instance
 * `MashovSessionService` logs in with. Patching that field is deliberate: the
 * roster is persisted by the real `persistRoster`, which is the code that
 * stamps the child and writes the visibility link, and stubbing
 * `refreshRosterForConnection` would have skipped exactly the thing B1 was
 * about.
 *
 * The fake upstream behaves like Mashov: a connection asking for a child that
 * is not in its own account gets a 403, not an empty list. That is what makes
 * the owner-first fan-out worth having and what makes the failure counts below
 * meaningful.
 *
 * Two schools on DIFFERENT years (2027 and 2026), because a single year cannot
 * show that each child's rows are labelled with their own school's year —
 * reads are scoped by that year, so a wrong label is invisible data.
 *
 * What a mocked Prisma could not answer: the sweep's `UPDATE ... WHERE
 * householdConnectionId = $1 AND lastFetchedAt < $2`, the three per-school
 * unique keys that two schools would collide on
 * (`(householdConnectionId, upstreamNotificationId)`, `(schoolCode, code)`,
 * `parent_profile.upstreamUserId`), and `cachedNewCount` summing to the
 * household badge.
 */

import { Test, TestingModule } from '../../backend/node_modules/@nestjs/testing';
import { ConfigModule } from '../../backend/node_modules/@nestjs/config';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { SyncModule } from '../../backend/src/sync/sync.module';
import { SyncService } from '../../backend/src/sync/sync.service';
import { MashovHttpClient } from '../../backend/src/session/mashov-http.client';
import { MashovSessionService } from '../../backend/src/session/mashov-session.service';
import { EncryptionService } from '../../backend/src/session/encryption.service';
import {
  currentSchoolYearForStudent,
  yearScopeForStudents,
} from '../../backend/src/common/school-year/school-year.scope';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';

const USER = 'ts-user';
const CONN_A = 'ts-conn-a';
const CONN_B = 'ts-conn-b';
const SEMEL_A = 111222;
const SEMEL_B = 333444;
const YEAR_A = 2027;
const YEAR_B = 2026;
const CHILD_A = 'ts-guid-a';
const CHILD_B = 'ts-guid-b';

/** Upstream still returns these. */
const LIVE_A = 'ts-conv-a-live';
const LIVE_B = 'ts-conv-b-live';
/** Upstream has stopped returning these: each run must sweep its own, only. */
const ORPHAN_A = 'ts-conv-a-orphan';
const ORPHAN_B = 'ts-conv-b-orphan';

const ALL_CONVERSATIONS = [LIVE_A, LIVE_B, ORPHAN_A, ORPHAN_B];
const LONG_AGO = new Date('2026-11-01T00:00:00Z');

interface School {
  connectionId: string;
  semel: number;
  year: number;
  child: string;
  liveConversation: string;
  /** Per-school upstream ids, chosen to collide where the schema must not. */
  upstreamUserId: string;
  subject: string;
}

const SCHOOLS: Record<string, School> = {
  [CONN_A]: {
    connectionId: CONN_A,
    semel: SEMEL_A,
    year: YEAR_A,
    child: CHILD_A,
    liveConversation: LIVE_A,
    upstreamUserId: 'upstream-parent-at-a',
    subject: 'מתמטיקה',
  },
  [CONN_B]: {
    connectionId: CONN_B,
    semel: SEMEL_B,
    year: YEAR_B,
    child: CHILD_B,
    liveConversation: LIVE_B,
    upstreamUserId: 'upstream-parent-at-b',
    subject: 'אנגלית',
  },
};

const BY_SEMEL: Record<number, School> = {
  [SEMEL_A]: SCHOOLS[CONN_A],
  [SEMEL_B]: SCHOOLS[CONN_B],
};

/**
 * Both schools number their notification 1 and their behaviour code 1.
 *
 * Mashov's numeric ids are per-school counters. These two are the collisions
 * the migrations added composite keys for, and the only way to see the keys
 * work is to make both schools claim the same number.
 */
const SHARED_NOTIFICATION_ID = 1;
const SHARED_ACHVA_CODE = 1;

function loginPayload(school: School) {
  return {
    credential: { userId: school.upstreamUserId, year: school.year },
    accessToken: {
      schoolSettings: { schoolYear: school.year },
      userSchoolYears: [school.year],
      children: [
        {
          childGuid: school.child,
          privateName: 'ילד',
          familyName: `של-${school.semel}`,
          classCode: 'ז',
          classNum: 1,
          gender: 'M',
          groups: [],
        },
      ],
      inactiveChildren: [],
    },
  };
}

function upstreamConversation(conversationId: string) {
  return {
    conversationId,
    subject: `נושא ${conversationId}`,
    sendTime: '2026-11-17T08:00:00',
    isNew: true,
    hasDrafts: false,
    hasAttachments: false,
    preventReply: false,
    labels: [],
    messages: [
      {
        messageId: `${conversationId}:msg`,
        conversationId,
        senderId: 'teacher-1',
        senderName: 'מורה',
        subject: `נושא ${conversationId}`,
        lastUpdate: '2026-11-17T08:00:00',
        sendTime: '2026-11-17T08:00:00',
        folder: 1,
        isNew: true,
        isDeleted: false,
        sendOnBehalf: false,
        sendViaEmail: false,
        sendViaSms: false,
        preventReply: false,
        sentViaEmail: false,
        sentViaSms: false,
      },
    ],
  };
}

describe('Two schools in one household, synced one after the other', () => {
  let prisma: PrismaClient;
  let app: TestingModule;
  let sync: SyncService;
  /** Every per-student request the fake upstream received, as `guid@connId`. */
  let studentRequests: string[];

  /**
   * The fake upstream. A 403 for a child outside the asking account, which is
   * what Mashov answers and what the owner-first ordering exists to avoid
   * paying for.
   */
  function respond(url: string, connectionId: string): unknown {
    const school = SCHOOLS[connectionId];
    if (!school) throw new Error(`fixture knows no connection ${connectionId}`);

    if (url.startsWith('/api/mail/inbox/conversations')) {
      return url.includes('skip=0') ? [upstreamConversation(school.liveConversation)] : [];
    }
    if (url.startsWith('/api/mail/archive/conversations')) return [];
    if (url.startsWith('/api/mail/counts')) return { unreadConversations: 1 };
    if (url === '/api/achvas') {
      return [
        {
          code: SHARED_ACHVA_CODE,
          name: `התנהגות ${school.semel}`,
          displayOrder: 1,
          // The two schools disagree about what their code 1 means, which is
          // the wrong answer `BehaviorClassifierService` would give from the
          // other school's taxonomy.
          justifiable: school.connectionId === CONN_A,
          hidden: false,
          showInBehave: true,
          hideFromStudents: false,
        },
      ];
    }
    if (url === '/api/user/details') {
      return {
        userId: school.upstreamUserId,
        email: `parent@${school.semel}.example`,
        cellphone: '0500000000',
        detailsState: 1,
      };
    }
    if (url.startsWith('/api/user/notifications')) {
      return [
        {
          id: SHARED_NOTIFICATION_ID,
          userId: school.upstreamUserId,
          eventTime: '2026-11-17T09:00:00',
          eventType: 1,
          eventText: `התראה מבית ספר ${school.semel}`,
          eventUserId: school.child,
        },
      ];
    }
    if (url === '/api/schoolActivities/permitted') return [];
    if (url === '/api/bells') {
      // School-wide: the one task that asks per school rather than per child,
      // so each school's periods must land under its own semel and year.
      return [
        { lessonNumber: 1, startTime: '08:15:00', endTime: '09:00:00' },
        { lessonNumber: 2, startTime: '10:15:00', endTime: '11:00:00' },
      ];
    }

    const perStudent = /^\/api\/students\/([^/]+)\/(.+)$/.exec(url);
    if (perStudent) {
      const [, guid, endpoint] = perStudent;
      studentRequests.push(`${guid}@${connectionId}`);
      if (guid !== school.child) {
        // Mashov's own answer for a child in somebody else's account.
        throw new Error('Request failed with status code 403');
      }
      if (endpoint === 'homework') {
        return [
          {
            lessonId: 7001,
            lessonDate: '2026-11-16T00:00:00',
            lesson: 3,
            homework: `שיעורי בית ${school.semel}`,
            groupId: 600,
            remark: 'ללא הערות',
            studentGuid: guid,
            subjectName: school.subject,
          },
        ];
      }
      return [];
    }

    throw new Error(`fixture has no answer for ${url}`);
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();

    app = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), SyncModule],
    })
      .overrideProvider(MashovHttpClient)
      .useValue({
        getForConnection: jest.fn(async (url: string, connectionId: string) =>
          respond(url, connectionId),
        ),
        getForTarget: jest.fn(async (url: string, target: { id: string }) =>
          respond(url, target.id),
        ),
        // The env-credential session is fenced off: a connection-scoped
        // refresh that reaches for it is a bug, so the fake makes it loud
        // instead of answering.
        get: jest.fn(async (url: string) => {
          throw new Error(`the shared env session must not be used (${url})`);
        }),
        put: jest.fn(),
        delete: jest.fn(),
        getResponse: jest.fn(),
        getResponseForTarget: jest.fn(),
        putForTarget: jest.fn(),
        deleteForTarget: jest.fn(),
      })
      .compile();
    await app.init();

    sync = app.get(SyncService);

    // The login transport. `MashovSessionService` holds its own axios
    // instance, so this is the seam that keeps `persistRoster` — the stamping
    // and linking code — real.
    const session = app.get(MashovSessionService) as unknown as {
      httpClient: { post: jest.Mock; get: jest.Mock };
    };
    session.httpClient = {
      post: jest.fn(async (url: string, body: { semel: number }) => {
        if (url !== '/api/login') throw new Error(`fixture has no answer for POST ${url}`);
        const school = BY_SEMEL[body.semel];
        if (!school) throw new Error(`fixture knows no school ${body.semel}`);
        return {
          data: loginPayload(school),
          headers: {
            'set-cookie': [
              `Csrf-Token=csrf-${school.semel}; Path=/`,
              `MashovAuthToken=auth-${school.semel}; Path=/`,
              `uniquId=uniq-${school.semel}; Path=/`,
            ],
          },
        };
      }),
      get: jest.fn(async (url: string) => {
        throw new Error(`fixture has no answer for GET ${url}`);
      }),
    };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.syncRun.deleteMany({});
    await prisma.bellSchedule.deleteMany({
      where: { schoolCode: { in: [SEMEL_A, SEMEL_B] } },
    });
    await prisma.mailMessage.deleteMany({});
    await prisma.mailConversation.deleteMany({});
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: [CHILD_A, CHILD_B] } } });
    await prisma.notificationEvent.deleteMany({});
    await prisma.parentProfile.deleteMany({});
    await prisma.behaviorTypeReference.deleteMany({
      where: { schoolCode: { in: [SEMEL_A, SEMEL_B] } },
    });
    await prisma.studentConnection.deleteMany({
      where: { studentGuid: { in: [CHILD_A, CHILD_B] } },
    });
    await prisma.student.deleteMany({ where: { studentGuid: { in: [CHILD_A, CHILD_B] } } });
    await prisma.householdConnection.deleteMany({
      where: { schoolCode: { in: [SEMEL_A, SEMEL_B] } },
    });
    await prisma.appUser.deleteMany({ where: { id: USER } });
  }

  /**
   * The state a household is in after both schools have synced once: each
   * child stamped and linked to its own connection, each mailbox holding one
   * live conversation and one the school has since taken away.
   */
  async function seed(): Promise<void> {
    await cleanup();
    studentRequests = [];

    // Park the stray children this fixture did not create -- but only the
    // UNLINKED ones, which are exactly the hazard. A connection-scoped refresh
    // admits a child no connection lists (ADR-0031's deliberate edge, via
    // `connectionStudentWhere`), so one stray unlinked active student from an
    // earlier suite would be fetched for, collect a 403, and make
    // `status: 'success'` hostage to another suite's leftovers. A stray that IS
    // linked, to some other suite's connection, is already excluded by the
    // predicate and is left alone -- a fixture should not deactivate rows it
    // has no quarrel with. The suite runs last under `--runInBand`, and this is
    // consistent with what `cleanup()` already assumes: it deletes `syncRun`,
    // `mailMessage`, `mailConversation`, `notificationEvent` and
    // `parentProfile` globally.
    //
    // The edge itself is not swept under the carpet: the group below asserts
    // that an unlinked child IS still fetched for, and what it costs.
    await prisma.student.updateMany({
      where: {
        NOT: { studentGuid: { in: [CHILD_A, CHILD_B] } },
        links: { none: {} },
      },
      data: { isActive: false },
    });

    const encryption = app.get(EncryptionService);

    await prisma.appUser.create({
      data: {
        id: USER,
        mashovUserId: 'upstream-ts-user',
        username: 'two-school-parent',
        displayName: 'הורה',
        semel: SEMEL_A,
      },
    });

    for (const school of [SCHOOLS[CONN_A], SCHOOLS[CONN_B]]) {
      await prisma.householdConnection.create({
        data: {
          id: school.connectionId,
          userId: USER,
          username: `parent-${school.semel}`,
          schoolCode: school.semel,
          schoolYear: school.year,
          encryptedPassword: encryption.encrypt('secret'),
          schoolName: `בית ספר ${school.semel}`,
          active: true,
          // Non-zero, so "never written" is distinguishable from "written 0".
          cachedNewCount: 99,
        },
      });

      await prisma.student.create({
        data: {
          studentGuid: school.child,
          privateName: 'ילד',
          familyName: `של-${school.semel}`,
          fullName: `ילד של-${school.semel}`,
          classCode: 'ז',
          classNum: 1,
          gender: 'M',
          isActive: true,
          householdConnectionId: school.connectionId,
          // Older than ROSTER_ABSENCE_GRACE_DAYS, which is the realistic state
          // for a child whose school has not synced today -- and what makes
          // the presence sweep's "every connection must have refreshed"
          // guard assertable rather than vacuous.
          lastSeenInRosterAt: LONG_AGO,
        },
      });
      await prisma.studentConnection.create({
        data: {
          studentGuid: school.child,
          householdConnectionId: school.connectionId,
          lastSeenInRosterAt: LONG_AGO,
        },
      });

      for (const conversationId of [school.liveConversation, school.connectionId === CONN_A ? ORPHAN_A : ORPHAN_B]) {
        await prisma.mailConversation.create({
          data: {
            conversationId,
            subject: `נושא ${conversationId}`,
            senderNamePreview: 'מורה',
            sendTime: new Date('2026-11-10T08:00:00Z'),
            isUnread: true,
            labels: [],
            lastFetchedAt: LONG_AGO,
            householdConnectionId: school.connectionId,
          },
        });
      }
    }
  }

  async function unreadState(): Promise<Record<string, boolean>> {
    const rows = await prisma.mailConversation.findMany({
      where: { conversationId: { in: ALL_CONVERSATIONS } },
      select: { conversationId: true, isUnread: true },
    });
    return Object.fromEntries(rows.map((row) => [row.conversationId, row.isUnread]));
  }

  async function conversationStamps(): Promise<Record<string, string | null>> {
    const rows = await prisma.mailConversation.findMany({
      where: { conversationId: { in: ALL_CONVERSATIONS } },
      select: { conversationId: true, householdConnectionId: true },
    });
    return Object.fromEntries(rows.map((row) => [row.conversationId, row.householdConnectionId]));
  }

  async function childOwnership(): Promise<
    Array<{ studentGuid: string; stamp: string | null; links: string[]; isActive: boolean }>
  > {
    const students = await prisma.student.findMany({
      where: { studentGuid: { in: [CHILD_A, CHILD_B] } },
      select: { studentGuid: true, householdConnectionId: true, isActive: true },
      orderBy: { studentGuid: 'asc' },
    });
    const links = await prisma.studentConnection.findMany({
      where: { studentGuid: { in: [CHILD_A, CHILD_B] } },
      select: { studentGuid: true, householdConnectionId: true },
    });
    return students.map((student) => ({
      studentGuid: student.studentGuid,
      stamp: student.householdConnectionId,
      links: links
        .filter((link) => link.studentGuid === student.studentGuid)
        .map((link) => link.householdConnectionId)
        .sort(),
      isActive: student.isActive,
    }));
  }

  async function cachedCounts(): Promise<Record<string, number>> {
    const rows = await prisma.householdConnection.findMany({
      where: { id: { in: [CONN_A, CONN_B] } },
      select: { id: true, cachedNewCount: true },
    });
    return Object.fromEntries(rows.map((row) => [row.id, row.cachedNewCount]));
  }

  beforeEach(seed);

  describe('after school A alone has refreshed', () => {
    let refreshResult: Awaited<ReturnType<SyncService['refreshAll']>>;

    beforeEach(async () => {
      refreshResult = await sync.refreshAll({ connectionId: CONN_A });
    });

    it("leaves school B's child owned, linked and active", async () => {
      // The B1 eviction, in the only shape that can still produce it: a real
      // roster persist. A's roster lists A's child only, so a stamp or link
      // that followed the walk rather than the account would take B's child
      // away until B's next sync flipped it back.
      expect(await childOwnership()).toEqual([
        { studentGuid: CHILD_A, stamp: CONN_A, links: [CONN_A], isActive: true },
        { studentGuid: CHILD_B, stamp: CONN_B, links: [CONN_B], isActive: true },
      ]);
    });

    it("sweeps its own stale conversation and not school B's", async () => {
      expect(await unreadState()).toEqual({
        [LIVE_A]: true,
        [ORPHAN_A]: false,
        // Stale by the same clock, and untouched: the sweep is scoped to the
        // connection, which is the whole reason it may run at all.
        [LIVE_B]: true,
        [ORPHAN_B]: true,
      });
    });

    it("stores its own school's bell schedule and not school B's", async () => {
      // The periods are school-wide, so they are keyed by semel and year
      // rather than by child -- a run for A must leave B with no schedule at
      // all, which is what makes B read as `source: 'default'` until it syncs.
      const rows = await prisma.bellSchedule.findMany({
        where: { schoolCode: { in: [SEMEL_A, SEMEL_B] } },
        orderBy: [{ schoolCode: 'asc' }, { lesson: 'asc' }],
      });

      expect(
        rows.map((row) => [row.schoolCode, row.schoolYear, row.lesson, row.startTime, row.endTime]),
      ).toEqual([
        [SEMEL_A, YEAR_A, 1, '08:15', '09:00'],
        [SEMEL_A, YEAR_A, 2, '10:15', '11:00'],
      ]);
    });

    it("writes its own cachedNewCount and not school B's", async () => {
      const counts = await cachedCounts();
      // The point of the case: B's row is untouched by A's refresh. Written
      // unscoped, each run wrote the union of both mailboxes into its own row,
      // and the badge -- which sums the rows -- reported it once per school.
      expect(counts[CONN_B]).toBe(99);
      // A's own mailbox holds one unread conversation after the sweep and two
      // before it, and `mail_counts` and `mail_inbox` run in the same
      // `Promise.all`, so either is a correct answer about A's mailbox alone.
      // The union is 3; that is what this excludes. The deterministic form of
      // this assertion is in the two-pass group below.
      expect(counts[CONN_A]).toBeGreaterThanOrEqual(1);
      expect(counts[CONN_A]).toBeLessThanOrEqual(2);
    });

    it("never asks about school B's child, and so reports a clean sync", async () => {
      // Each per-student task now reads `studentScopeForContext(context)`, so a
      // connection-scoped refresh iterates the children THIS connection lists
      // rather than the whole `student` table. A's run never mentions B's
      // child, and nothing in A's household failed.
      expect(studentRequests.some((entry) => entry === `${CHILD_B}@${CONN_A}`)).toBe(false);
      expect(studentRequests.every((entry) => !entry.endsWith(`@${CONN_B}`))).toBe(true);

      // What the parent is shown for it. This used to be `partial` for a school
      // that had synced perfectly, which is what `/auth/syncing` reads.
      expect(refreshResult.status).toBe('success');
      expect(refreshResult.tasks.filter((task) => task.status === 'failed')).toEqual([]);

      // And no trace of the attempt: the failed `sync_run` per foreign child is
      // gone too, so `FreshnessService` stops reading it as source ill-health.
      await expect(
        prisma.homeworkItem.count({ where: { studentGuid: CHILD_B } }),
      ).resolves.toBe(0);
      const failedForB = await prisma.syncRun.count({
        where: { status: 'failed', source: { endsWith: `:${CHILD_B}` } },
      });
      expect(failedForB).toBe(0);
    });
  });

  /**
   * What the per-student scoping does NOT fix, asserted rather than assumed.
   *
   * `studentScopeForContext` scopes a connection-scoped refresh by the
   * ADR-0031 visibility edge, and that edge admits a child with no
   * `student_connection` rows -- "ownership unknown, link on the next roster
   * refresh", not "nobody's". Excluding them would stop fetching for every
   * child on a deployment whose ownership backfill has not run, which is a far
   * worse failure than a wasted call.
   *
   * So the wasted-403 symptom is gone for LINKED children only. An unlinked
   * one still costs one call per per-student task and still drags the school's
   * refresh to `partial`, until the next roster sync links them. This group
   * pins that, so the residue is a known quantity rather than a surprise.
   */
  describe('an unlinked child is still fetched for, at the cost of a partial', () => {
    const UNLINKED = 'ts-guid-no-links';
    let refreshResult: Awaited<ReturnType<SyncService['refreshAll']>>;

    beforeEach(async () => {
      await prisma.student.create({
        data: {
          studentGuid: UNLINKED,
          privateName: 'ילד',
          familyName: 'ללא קישור',
          fullName: 'ילד ללא קישור',
          classCode: 'ח',
          classNum: 3,
          gender: 'F',
          isActive: true,
          householdConnectionId: null,
        },
      });
      refreshResult = await sync.refreshAll({ connectionId: CONN_A });
    });

    afterEach(async () => {
      await prisma.homeworkItem.deleteMany({ where: { studentGuid: UNLINKED } });
      await prisma.student.deleteMany({ where: { studentGuid: UNLINKED } });
    });

    it('asks school A about them, because ownership unknown is not somebody else\'s', async () => {
      expect(studentRequests).toContain(`${UNLINKED}@${CONN_A}`);
    });

    it("still never asks about school B's child, who IS linked elsewhere", async () => {
      // The scoping still does its job: a linked foreign child is excluded by
      // the predicate, which is the case the minor was actually about.
      expect(studentRequests).not.toContain(`${CHILD_B}@${CONN_A}`);
    });

    it('drags the school to partial, which is the residue the fix leaves', async () => {
      // One 403 per per-student task for this child. Not wrong data -- A's own
      // child synced -- but the parent is told `partial` for a school that
      // worked, until the next roster sync links the child.
      expect(refreshResult.status).toBe('partial');
      expect(
        refreshResult.tasks.filter((task) => task.status === 'failed').map((task) => task.task).sort(),
      ).toEqual([
        'behavior',
        'groups',
        'homework',
        'lessonsCount',
        'messageBoard',
        'releases',
        'timetable',
      ]);
    });

    it('writes nothing for them', async () => {
      await expect(
        prisma.homeworkItem.count({ where: { studentGuid: UNLINKED } }),
      ).resolves.toBe(0);
    });
  });

  /**
   * A child no connection lists, in a household that spans two years.
   *
   * This is the other half of G1's unlinked-child item, and it needs a
   * household with two schools on different years, which only this fixture
   * has. The cross-child reads give such a child EVERY year the household is
   * on, because nothing recorded which school wrote their rows and admitting
   * one year would hide them whenever the guess was wrong. The per-child read
   * cannot do that -- it resolves a single year -- and the two answers
   * disagreeing is what the last case records.
   *
   * No refresh runs here: the child is created inside the cases so the sync
   * assertions above are not fetching for them.
   */
  describe('a child no connection lists, across two school years', () => {
    const ORPHAN_CHILD = 'ts-guid-unlinked';
    const ROW_AT_A = 8801;
    const ROW_AT_B = 8802;
    let parked: string[] = [];

    beforeEach(async () => {
      // `currentSchoolYearFor` with no caller reads the highest year across
      // every active connection in the table, so a neighbouring suite's
      // leftovers would otherwise decide the fallback. Restored after.
      const strays = await prisma.householdConnection.findMany({
        where: { active: true, NOT: { id: { in: [CONN_A, CONN_B] } } },
        select: { id: true },
      });
      parked = strays.map((row) => row.id);
      await prisma.householdConnection.updateMany({
        where: { id: { in: parked } },
        data: { active: false },
      });

      await prisma.student.create({
        data: {
          studentGuid: ORPHAN_CHILD,
          privateName: 'ילד',
          familyName: 'ללא שיוך',
          fullName: 'ילד ללא שיוך',
          classCode: 'ח',
          classNum: 2,
          gender: 'F',
          isActive: true,
          householdConnectionId: null,
        },
      });
      await prisma.homeworkItem.createMany({
        data: [YEAR_A, YEAR_B].map((schoolYear, index) => ({
          studentGuid: ORPHAN_CHILD,
          lessonId: [ROW_AT_A, ROW_AT_B][index],
          groupId: 700,
          lesson: 1,
          subjectName: 'ללא שיוך',
          homeworkText: `שנה ${schoolYear}`,
          lessonDate: new Date('2026-11-14T00:00:00Z'),
          schoolYear,
        })),
      });
    });

    afterEach(async () => {
      await prisma.homeworkItem.deleteMany({ where: { studentGuid: ORPHAN_CHILD } });
      await prisma.student.deleteMany({ where: { studentGuid: ORPHAN_CHILD } });
      await prisma.householdConnection.updateMany({
        where: { id: { in: parked } },
        data: { active: true },
      });
      parked = [];
    });

    it('reaches the cross-child reads at BOTH schools\' years', async () => {
      const scope = await yearScopeForStudents(prisma as unknown as PrismaService, USER);
      const rows = await prisma.homeworkItem.findMany({
        where: { ...scope, studentGuid: ORPHAN_CHILD },
        select: { lessonId: true },
        orderBy: { lessonId: 'asc' },
      });
      // Hiding a child's data is a worse failure than showing a row that is
      // one year stale, so an unlinked child is admitted at every year the
      // household is on.
      expect(rows.map((row) => row.lessonId)).toEqual([ROW_AT_A, ROW_AT_B]);
    });

    it('resolves ONE year for the per-child read, so half of those rows are unreachable there', async () => {
      // Characterising, not endorsing. `currentSchoolYearForStudent` falls
      // back to the household's highest year for a child with no routing
      // stamp, so rows written at the other school's year are in the list and
      // absent from the workspace -- the same "card there, workspace empty"
      // shape the cross-child scope was fixed for. Recorded as a Minor in
      // docs/plans/merged-household-access-followups.md.
      const year = await currentSchoolYearForStudent(
        prisma as unknown as PrismaService,
        ORPHAN_CHILD,
      );
      expect(year).toBe(YEAR_A);

      const reachable = await prisma.homeworkItem.findMany({
        where: { studentGuid: ORPHAN_CHILD, schoolYear: year },
        select: { lessonId: true },
      });
      expect(reachable.map((row) => row.lessonId)).toEqual([ROW_AT_A]);
    });
  });

  describe('after both schools have refreshed', () => {
    beforeEach(async () => {
      // Twice each, which is what makes the counts below exact rather than a
      // range. `mail_counts` and `mail_inbox` run in the same `Promise.all`,
      // so on a first pass the count can be taken either side of that
      // mailbox's sweep; after it, each mailbox holds exactly one unread
      // conversation at every instant and the race has nothing to disagree
      // about. A steady-state household is the state a cron run finds, too.
      for (let pass = 0; pass < 2; pass += 1) {
        await sync.refreshAll({ connectionId: CONN_A });
        await sync.refreshAll({ connectionId: CONN_B });
      }
    });

    it('leaves each child owned by, and visible to, its own school only', async () => {
      expect(await childOwnership()).toEqual([
        { studentGuid: CHILD_A, stamp: CONN_A, links: [CONN_A], isActive: true },
        { studentGuid: CHILD_B, stamp: CONN_B, links: [CONN_B], isActive: true },
      ]);
    });

    it('attributes every mail row to the mailbox it came from', async () => {
      expect(await conversationStamps()).toEqual({
        [LIVE_A]: CONN_A,
        [ORPHAN_A]: CONN_A,
        [LIVE_B]: CONN_B,
        [ORPHAN_B]: CONN_B,
      });
      const messages = await prisma.mailMessage.findMany({
        where: { messageId: { in: [`${LIVE_A}:msg`, `${LIVE_B}:msg`] } },
        select: { messageId: true, householdConnectionId: true },
        orderBy: { messageId: 'asc' },
      });
      expect(messages).toEqual([
        { messageId: `${LIVE_A}:msg`, householdConnectionId: CONN_A },
        { messageId: `${LIVE_B}:msg`, householdConnectionId: CONN_B },
      ]);
    });

    it('sweeps each mailbox against its own run and nothing else', async () => {
      expect(await unreadState()).toEqual({
        [LIVE_A]: true,
        [LIVE_B]: true,
        [ORPHAN_A]: false,
        [ORPHAN_B]: false,
      });
    });

    it('gives the household a badge that is the sum of its mailboxes', async () => {
      const counts = await cachedCounts();
      expect(counts).toEqual({ [CONN_A]: 1, [CONN_B]: 1 });

      // The read the dashboard and the inbox badge both make.
      const summed = await prisma.householdConnection.aggregate({
        where: { userId: USER, active: true },
        _sum: { cachedNewCount: true },
      });
      expect(summed._sum.cachedNewCount).toBe(2);
    });

    it("records each mailbox's own count in its drift run, not the union", async () => {
      // `mail_counts` writes `localCount` beside the upstream number so their
      // drift is queryable without container logs, and it is the one place the
      // task's own scoping is visible: `cachedNewCount` is also written by
      // MailInboxTask in the same refresh, so the column alone cannot say
      // which of them was right. Unscoped, each run counted both schools'
      // unread -- the union, once per school, which is what doubled the badge.
      const latest = await Promise.all(
        [CONN_A, CONN_B].map((connectionId) =>
          prisma.syncRun.findFirst({
            where: { source: `mail_counts:${connectionId}` },
            orderBy: { startedAt: 'desc' },
            select: { source: true, upstreamCount: true, localCount: true },
          }),
        ),
      );
      expect(latest).toEqual([
        { source: `mail_counts:${CONN_A}`, upstreamCount: 1, localCount: 1 },
        { source: `mail_counts:${CONN_B}`, upstreamCount: 1, localCount: 1 },
      ]);
    });

    it("labels each child's homework with its own school's year", async () => {
      // Two schools mid-rollover are on different years, and every read is
      // year-scoped: a row labelled with the other school's year is data the
      // parent cannot see.
      const homework = await prisma.homeworkItem.findMany({
        where: { studentGuid: { in: [CHILD_A, CHILD_B] } },
        select: { studentGuid: true, schoolYear: true, subjectName: true },
        orderBy: { studentGuid: 'asc' },
      });
      expect(homework).toEqual([
        { studentGuid: CHILD_A, schoolYear: YEAR_A, subjectName: SCHOOLS[CONN_A].subject },
        { studentGuid: CHILD_B, schoolYear: YEAR_B, subjectName: SCHOOLS[CONN_B].subject },
      ]);
    });

    it('asks each school only about its own child, once per task', async () => {
      // Owner-first ordering. Without it each run pays a guaranteed 403 for
      // the other school's child before reaching the right account, across ten
      // per-student tasks.
      const ownChildRequests = studentRequests.filter(
        (entry) => entry === `${CHILD_A}@${CONN_A}` || entry === `${CHILD_B}@${CONN_B}`,
      );
      const foreignChildRequests = studentRequests.filter(
        (entry) => entry === `${CHILD_A}@${CONN_B}` || entry === `${CHILD_B}@${CONN_A}`,
      );
      // Seven per-student endpoints are reached here -- homework, behave,
      // groups, lessonsCount, messageBoard, timetable and studentReleases;
      // dailyBehave and outBehave sit behind feature flags that are off -- one
      // own child per run, two runs per pass, two passes.
      expect(ownChildRequests.length).toBe(7 * 1 * 2 * 2);
      // There are none. The owner-first ordering made each foreign call cost
      // one 403 instead of two; scoping the student list to the refreshing
      // connection's children removes them entirely.
      expect(foreignChildRequests.length).toBe(0);
    });

    it('keeps both schools\' notifications, which share an upstream id', async () => {
      // `upstreamNotificationId` is a per-school counter. Before the composite
      // key one school's notification silently replaced the other's.
      const events = await prisma.notificationEvent.findMany({
        where: { upstreamNotificationId: SHARED_NOTIFICATION_ID },
        select: { householdConnectionId: true, eventText: true },
        orderBy: { householdConnectionId: 'asc' },
      });
      expect(events).toEqual([
        { householdConnectionId: CONN_A, eventText: `התראה מבית ספר ${SEMEL_A}` },
        { householdConnectionId: CONN_B, eventText: `התראה מבית ספר ${SEMEL_B}` },
      ]);
    });

    it('keeps both schools\' behaviour taxonomies, which share a code', async () => {
      // The one that answers "is this absence justifiable?". Keyed by school,
      // because the two schools disagree and the wrong answer is a wrong
      // statement about a child.
      const references = await prisma.behaviorTypeReference.findMany({
        where: { code: SHARED_ACHVA_CODE, schoolCode: { in: [SEMEL_A, SEMEL_B] } },
        select: { schoolCode: true, justifiable: true },
        orderBy: { schoolCode: 'asc' },
      });
      expect(references).toEqual([
        { schoolCode: SEMEL_A, justifiable: true },
        { schoolCode: SEMEL_B, justifiable: false },
      ]);
    });

    it('keeps one parent profile per school, each stamped', async () => {
      // Two rows is the correct steady state: the upstream user id is
      // per-school, and `SettingsService` picks by connection rather than
      // `findFirst` between them.
      const profiles = await prisma.parentProfile.findMany({
        select: { upstreamUserId: true, householdConnectionId: true },
        orderBy: { upstreamUserId: 'asc' },
      });
      expect(profiles).toEqual([
        { upstreamUserId: SCHOOLS[CONN_A].upstreamUserId, householdConnectionId: CONN_A },
        { upstreamUserId: SCHOOLS[CONN_B].upstreamUserId, householdConnectionId: CONN_B },
      ]);
    });
  });
});
