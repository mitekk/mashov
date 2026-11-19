/**
 * Two parents, one school, the same children — integration tests.
 *
 * This is the fixture the branch never had, and its absence is why 1014 unit
 * tests passed while nine routes had no ownership guard: every test exercised
 * ONE `AppUser`.
 *
 * What is proved here cannot be proved with a mocked Prisma, because it is the
 * database that answers:
 *
 *  1. The visibility predicate is a relation filter (`links: { some }` /
 *     `links: { none: {} }`). Its semantics are Postgres's, not a mock's.
 *  2. Two parents with their own Mashov accounts at one school see the same
 *     children SIMULTANEOUSLY, with no dependence on which of them synced
 *     last. Under the old single-stamp rule the second to sync evicted the
 *     first (ADR-0031).
 *  3. Unlinking one parent's school revokes that parent's view and deletes
 *     nothing the other parent still needs — and every per-child table is
 *     keyed by `studentGuid` alone, so a wrong delete here has no second copy
 *     to recover from.
 *  4. The migration backfills a link for every already-stamped child.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import {
  canSeeStudent,
  visibleStudentWhere,
} from '../../backend/src/common/student-links';
import {
  UNSCOPED_SCHOOL_YEAR,
  currentSchoolYearForStudent,
  historyScopeForStudents,
  yearScopeForStudents,
} from '../../backend/src/common/school-year/school-year.scope';
import { ConnectionService } from '../../backend/src/connection/connection.service';
import { ConnectionScopeService } from '../../backend/src/common/connection-scope/connection-scope.service';
import { MailService } from '../../backend/src/mail/mail.service';
import { DashboardService } from '../../backend/src/dashboard/dashboard.service';
import { FeedService } from '../../backend/src/feed/feed.service';
import { ChildrenService } from '../../backend/src/children/children.service';
import { UserItemStateService } from '../../backend/src/common/user-item-state.service';
import { FreshnessService } from '../../backend/src/sync/freshness.service';
import type { SyncRunService } from '../../backend/src/sync/sync-run.service';
import type { MashovHttpClient } from '../../backend/src/session/mashov-http.client';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { EncryptionService } from '../../backend/src/session/encryption.service';
import type { SchoolYearService } from '../../backend/src/common/school-year/school-year.service';
import type { MashovSessionService } from '../../backend/src/session/mashov-session.service';
import type { ConfigService } from '../../backend/node_modules/@nestjs/config';

const SEMEL = 778899;
const YEAR = 2027;
const USER_A = 'hh-user-a';
const USER_B = 'hh-user-b';
/** Signed in, no connection: the only user who reaches R13's branch. */
const USER_C = 'hh-user-c';
const CONN_A = 'hh-conn-a';
const CONN_B = 'hh-conn-b';
const OWN_A = 'hh-guid-a';
const OWN_B = 'hh-guid-b';
const SHARED = 'hh-guid-shared';
const UNLINKED = 'hh-guid-unlinked';
const ALL_GUIDS = [OWN_A, OWN_B, SHARED, UNLINKED];
const ALL_USERS = [USER_A, USER_B, USER_C];
/** One conversation per connection, so a leak has a name either way. */
const HH_CONV_A = 'hh-conv-a';
const HH_CONV_B = 'hh-conv-b';
const HH_CONVERSATIONS = [HH_CONV_A, HH_CONV_B];
/** A's cached badge, B's, and the local count the fallback would read. */
const CACHED_A = 3;
const CACHED_B = 7;
/** The unlinked child's current-year row, and their pre-migration one. */
const UNLINKED_LESSON_ID = 9910;
const UNLINKED_LEGACY_LESSON_ID = 9911;

function migrationFile(): string {
  return path.join(
    __dirname,
    '../../backend/prisma/migrations/20261122000000_student_connection_links/migration.sql',
  );
}

describe('Two parents, one school, shared children', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.userItemState.deleteMany({ where: { userId: { in: ALL_USERS } } });
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    await prisma.mailConversation.deleteMany({
      where: { conversationId: { in: HH_CONVERSATIONS } },
    });
    await prisma.studentConnection.deleteMany({
      where: { studentGuid: { in: ALL_GUIDS } },
    });
    await prisma.student.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    await prisma.householdConnection.deleteMany({ where: { schoolCode: SEMEL } });
    await prisma.appUser.deleteMany({ where: { id: { in: ALL_USERS } } });
  }

  /**
   * Two users, two connections AT THE SAME SCHOOL, four children: one each,
   * one shared by both, one nobody lists.
   *
   * The shared child is stamped to B on purpose. That is the state B's sync
   * leaves behind, and under the old rule it was the state in which A's
   * `/children` was empty.
   */
  async function seed(): Promise<void> {
    await cleanup();

    for (const [id, username] of [
      [USER_A, 'parent-a'],
      [USER_B, 'parent-b'],
      // No connection of their own. Between unlinking and re-linking, which is
      // the only state in which the dashboard reaches its fallback badge.
      [USER_C, 'parent-c'],
    ]) {
      await prisma.appUser.create({
        data: {
          id,
          mashovUserId: `upstream-${id}`,
          username,
          displayName: username,
          semel: SEMEL,
        },
      });
    }

    for (const [id, userId, username, cachedNewCount] of [
      [CONN_A, USER_A, 'parent-a', CACHED_A],
      [CONN_B, USER_B, 'parent-b', CACHED_B],
    ] as Array<[string, string, string, number]>) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId,
          username,
          schoolCode: SEMEL,
          schoolYear: YEAR,
          // Distinct per connection: "no upstream call went out under the
          // other parent's credentials" is only assertable if the two
          // credentials are telling apart in the first place.
          encryptedPassword: `enc-${username}`,
          schoolName: 'בית ספר משותף',
          active: true,
          // Explicit, and different per connection, so a summed badge cannot
          // be right by accident.
          cachedNewCount,
        },
      });
    }

    const child = (studentGuid: string, stamp: string | null) => ({
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
      data: [
        child(OWN_A, CONN_A),
        child(OWN_B, CONN_B),
        child(SHARED, CONN_B),
        child(UNLINKED, null),
      ],
    });

    await prisma.studentConnection.createMany({
      data: [
        { studentGuid: OWN_A, householdConnectionId: CONN_A, lastSeenInRosterAt: new Date() },
        { studentGuid: OWN_B, householdConnectionId: CONN_B, lastSeenInRosterAt: new Date() },
        { studentGuid: SHARED, householdConnectionId: CONN_A, lastSeenInRosterAt: new Date() },
        { studentGuid: SHARED, householdConnectionId: CONN_B, lastSeenInRosterAt: new Date() },
      ],
    });

    // One unread conversation per connection. The feed readers render mail
    // alongside the children, so this is what R3's leak looks like on the
    // screen: another household's subject and sender-name preview as a feed
    // item, with `schoolId: null` so the school chip cannot hide it.
    await prisma.mailConversation.createMany({
      data: [
        [HH_CONV_A, CONN_A],
        [HH_CONV_B, CONN_B],
      ].map(([conversationId, stamp]) => ({
        conversationId,
        subject: `נושא ${conversationId}`,
        senderNamePreview: 'מורה',
        sendTime: new Date('2026-11-11T08:00:00Z'),
        isUnread: true,
        labels: [],
        lastFetchedAt: new Date('2026-11-11T08:05:00Z'),
        householdConnectionId: stamp,
      })),
    });

    await prisma.homeworkItem.createMany({
      data: [SHARED, OWN_B].map((studentGuid, index) => ({
        studentGuid,
        lessonId: 9900 + index,
        groupId: 500,
        lesson: 3,
        subjectName: 'מתמטיקה',
        homeworkText: 'תרגילים',
        lessonDate: new Date('2026-11-10T00:00:00Z'),
        schoolYear: YEAR,
      })),
    });

    // The child nobody lists gets rows at the household's current year, and
    // one at the pre-migration `schoolYear = 0`. Without them the fixture
    // could show the child present in the list but never show whether their
    // data is reachable -- the "card there, workspace empty" shape.
    await prisma.homeworkItem.createMany({
      data: [
        {
          studentGuid: UNLINKED,
          lessonId: UNLINKED_LESSON_ID,
          groupId: 500,
          lesson: 1,
          subjectName: 'היסטוריה',
          homeworkText: 'קריאה',
          lessonDate: new Date('2026-11-12T00:00:00Z'),
          schoolYear: YEAR,
        },
        {
          studentGuid: UNLINKED,
          lessonId: UNLINKED_LEGACY_LESSON_ID,
          groupId: 500,
          lesson: 2,
          subjectName: 'היסטוריה',
          homeworkText: 'קריאה מלפני המיגרציה',
          lessonDate: new Date('2026-09-02T00:00:00Z'),
          schoolYear: UNSCOPED_SCHOOL_YEAR,
        },
      ],
    });
  }

  async function visibleTo(userId: string): Promise<string[]> {
    const where = await visibleStudentWhere(prisma as unknown as PrismaService, userId);
    const students = await prisma.student.findMany({
      where: { ...where, studentGuid: { in: ALL_GUIDS } },
      select: { studentGuid: true },
      orderBy: { studentGuid: 'asc' },
    });
    return students.map((student) => student.studentGuid);
  }

  beforeEach(seed);

  it('shows the shared child to both parents at once', async () => {
    expect(await visibleTo(USER_A)).toEqual([OWN_A, SHARED, UNLINKED].sort());
    expect(await visibleTo(USER_B)).toEqual([OWN_B, SHARED, UNLINKED].sort());
  });

  it('does not change what one parent sees when the other one syncs', async () => {
    // A sync's only effect on ownership is the routing stamp. Moving it in
    // either direction must leave both parents' views identical -- that is the
    // oscillation B1 described, where the children flipped between the two
    // parents one cycle at a time.
    const before = { a: await visibleTo(USER_A), b: await visibleTo(USER_B) };

    for (const stamp of [CONN_A, CONN_B, CONN_A]) {
      await prisma.student.update({
        where: { studentGuid: SHARED },
        data: { householdConnectionId: stamp },
      });
      expect(await visibleTo(USER_A)).toEqual(before.a);
      expect(await visibleTo(USER_B)).toEqual(before.b);
    }
  });

  it('refuses the child only the other parent lists', async () => {
    const service = prisma as unknown as PrismaService;

    await expect(canSeeStudent(service, USER_A, SHARED)).resolves.toBe(true);
    await expect(canSeeStudent(service, USER_B, SHARED)).resolves.toBe(true);
    await expect(canSeeStudent(service, USER_A, OWN_B)).resolves.toBe(false);
    await expect(canSeeStudent(service, USER_B, OWN_A)).resolves.toBe(false);
    // Nobody lists this one, so ownership is unknown rather than foreign.
    await expect(canSeeStudent(service, USER_A, UNLINKED)).resolves.toBe(true);
  });

  it('keeps each parent read state independent of the other (ADR-0016)', async () => {
    // `UserItemState` is keyed per AppUser, so the flags were never shared --
    // but while one parent held the stamp the other could not reach the child
    // the flags belonged to, which made them unreachable in practice.
    const item = { itemType: 'homework', itemId: `${SHARED}:9900` };
    await prisma.userItemState.create({
      data: { userId: USER_A, ...item, isNew: false, isArchived: true },
    });

    const forA = await prisma.userItemState.findFirst({
      where: { userId: USER_A, ...item },
    });
    const forB = await prisma.userItemState.findFirst({
      where: { userId: USER_B, ...item },
    });

    expect(forA?.isArchived).toBe(true);
    expect(forB).toBeNull();
    await prisma.userItemState.deleteMany({ where: item });
  });

  describe('unlinking one parent', () => {
    function makeService(): ConnectionService {
      return new ConnectionService(
        prisma as unknown as PrismaService,
        { encrypt: (value: string) => value, decrypt: (value: string) => value } as unknown as EncryptionService,
        { get: () => undefined } as unknown as ConfigService,
        {} as unknown as SchoolYearService,
        { invalidateConnection: () => undefined } as unknown as MashovSessionService,
      );
    }

    it('revokes the view without deleting the child the other parent shares', async () => {
      // The blast radius. Every per-child table is keyed by studentGuid alone,
      // so deleting a shared child takes the other parent's whole history with
      // it and there is nowhere to recover it from.
      await makeService().deleteConnection(USER_A, CONN_A);

      await expect(
        prisma.student.findUnique({ where: { studentGuid: SHARED } }),
      ).resolves.not.toBeNull();
      await expect(
        prisma.homeworkItem.count({ where: { studentGuid: SHARED } }),
      ).resolves.toBe(1);
      // A's view is gone...
      await expect(
        prisma.studentConnection.count({ where: { householdConnectionId: CONN_A } }),
      ).resolves.toBe(0);
      // ...and B still sees the child.
      expect(await visibleTo(USER_B)).toContain(SHARED);
    });

    it('still deletes the children only the unlinked school listed', async () => {
      await makeService().deleteConnection(USER_A, CONN_A);

      await expect(
        prisma.student.findUnique({ where: { studentGuid: OWN_A } }),
      ).resolves.toBeNull();
      // And leaves the other parent's own child and its homework untouched.
      await expect(
        prisma.student.findUnique({ where: { studentGuid: OWN_B } }),
      ).resolves.not.toBeNull();
      await expect(
        prisma.homeworkItem.count({ where: { studentGuid: OWN_B } }),
      ).resolves.toBe(1);
    });

    it('leaves the child nobody lists alone', async () => {
      // "Unattributed within this household" does not exist, so an unlink must
      // never reach these rows -- on a two-household box that predicate was
      // every other family's children.
      await makeService().deleteConnection(USER_A, CONN_A);

      await expect(
        prisma.student.findUnique({ where: { studentGuid: UNLINKED } }),
      ).resolves.not.toBeNull();
    });
  });

  /**
   * The child nobody lists, with rows of their own.
   *
   * `visibleStudentWhere` and `canSeeStudent` both admit a child with no
   * links, because no link means "ownership unknown", not "nobody's" — so the
   * card is on `/children`. Whether anything is IN that card is a separate
   * question, answered by the year scope, and the two answers disagreeing is
   * the failure this covers: a scope built only from the connections' own
   * children contributes no branch for an unlinked one, so the parent opens a
   * card with zero homework, zero subjects and no behaviour.
   *
   * It is not a corner case. The ownership backfill refuses to guess on a
   * two-connection database, which is exactly the deployment this feature
   * creates, so every child on such a box starts out unlinked.
   */
  describe('the child nobody lists, with rows of their own', () => {
    /**
     * Keeps the year fallback deterministic. `currentSchoolYearFor` with no
     * caller reads the highest year across every active connection in the
     * table, so a neighbouring suite's leftovers would otherwise decide what
     * the unlinked child's year resolves to. Restored after each case.
     */
    let parked: string[] = [];

    beforeEach(async () => {
      const strays = await prisma.householdConnection.findMany({
        where: { active: true, NOT: { id: { in: [CONN_A, CONN_B] } } },
        select: { id: true },
      });
      parked = strays.map((row) => row.id);
      await prisma.householdConnection.updateMany({
        where: { id: { in: parked } },
        data: { active: false },
      });
    });

    afterEach(async () => {
      await prisma.householdConnection.updateMany({
        where: { id: { in: parked } },
        data: { active: true },
      });
      parked = [];
    });

    async function homeworkVisibleTo(userId: string): Promise<number[]> {
      const scope = await yearScopeForStudents(prisma as unknown as PrismaService, userId);
      const rows = await prisma.homeworkItem.findMany({
        where: { ...scope, studentGuid: { in: ALL_GUIDS } },
        select: { lessonId: true },
        orderBy: { lessonId: 'asc' },
      });
      return rows.map((row) => row.lessonId);
    }

    it('is in the list AND its rows are in the household year scope', async () => {
      // Both halves, in one case on purpose: either alone is satisfied by a
      // bug. A scope that admits nothing still passes "the child is visible",
      // and a scope that admits everything still passes "the rows are there".
      expect(await visibleTo(USER_A)).toContain(UNLINKED);
      expect(await homeworkVisibleTo(USER_A)).toEqual([
        9900, // SHARED, at A's own connection's year
        // 9901 is OWN_B's, and correctly absent: the scope's per-connection
        // branches are built from A's connections only.
        UNLINKED_LESSON_ID,
        UNLINKED_LEGACY_LESSON_ID,
      ]);
    });

    // "Every year the household is on" needs ONE user with two schools, which
    // this fixture is not -- CONN_A and CONN_B are two different parents, so
    // each one's scope spans their own connection's year alone. That case lives
    // in tests/integration/two-school-sync.test.ts.

    it('resolves a per-child year that its rows are actually at', async () => {
      // The per-child endpoints read ONE year, resolved from the child's
      // routing stamp -- which an unlinked child does not have, so it falls
      // back to the household's. The fallback has to land on a year the rows
      // were written at, or the workspace is empty while the list is not.
      const year = await currentSchoolYearForStudent(
        prisma as unknown as PrismaService,
        UNLINKED,
      );
      expect(year).toBe(YEAR);

      const atThatYear = await prisma.homeworkItem.count({
        where: { studentGuid: UNLINKED, schoolYear: { in: [year, UNSCOPED_SCHOOL_YEAR] } },
      });
      expect(atThatYear).toBe(2);
    });

    it('is in the history scope too, so the archive is not empty either', async () => {
      const scope = await historyScopeForStudents(
        prisma as unknown as PrismaService,
        { get: () => undefined } as unknown as ConfigService,
        USER_A,
      );
      const rows = await prisma.homeworkItem.findMany({
        where: { ...scope, studentGuid: UNLINKED },
        select: { lessonId: true },
        orderBy: { lessonId: 'asc' },
      });
      expect(rows.map((row) => row.lessonId)).toEqual([
        UNLINKED_LESSON_ID,
        UNLINKED_LEGACY_LESSON_ID,
      ]);
    });

    it('is admitted by the other parent on the same terms, deliberately', async () => {
      // The flip side of "visible to anyone": an unlinked child is admitted
      // because ownership is unknown, which is a deliberate choice and not an
      // accident of the scope. B sees them on the same terms A does.
      expect(await visibleTo(USER_B)).toContain(UNLINKED);
      expect(await homeworkVisibleTo(USER_B)).toContain(UNLINKED_LESSON_ID);
    });
  });

  it('backfills a link for every already-stamped child', async () => {
    // Production boots with `prisma db push`, which applies DDL and silently
    // skips data statements, so this file is executed explicitly by the
    // Dockerfile. Without the backfill every stamped child would read as
    // "nobody lists them" -- visible to everyone rather than to their own
    // parents.
    await prisma.studentConnection.deleteMany({
      where: { studentGuid: { in: ALL_GUIDS } },
    });

    const sql = fs.readFileSync(migrationFile(), 'utf8');
    for (const statement of splitSql(sql)) {
      await prisma.$executeRawUnsafe(statement);
    }

    const links = await prisma.studentConnection.findMany({
      where: { studentGuid: { in: ALL_GUIDS } },
      orderBy: [{ studentGuid: 'asc' }, { householdConnectionId: 'asc' }],
    });

    expect(
      links.map((link) => [link.studentGuid, link.householdConnectionId]),
    ).toEqual([
      [OWN_A, CONN_A],
      [OWN_B, CONN_B],
      [SHARED, CONN_B],
    ]);
    // The child nobody lists gains no link: unknown ownership is not a guess.
    expect(links.some((link) => link.studentGuid === UNLINKED)).toBe(false);
  });

  it('is idempotent, because boot replays it on every deploy', async () => {
    const sql = fs.readFileSync(migrationFile(), 'utf8');
    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of splitSql(sql)) {
        await prisma.$executeRawUnsafe(statement);
      }
    }

    // The seeded links plus the backfilled stamps, with no duplicates.
    const links = await prisma.studentConnection.count({
      where: { studentGuid: { in: ALL_GUIDS } },
    });
    expect(links).toBe(4);
  });

  /**
   * Batch 3 — the four readers that answered from the whole table.
   *
   * `MailService` was scoped in batch 1; the dashboard, the feed and
   * `/children` each kept their own path to the same questions, and each path
   * was missing the household predicate in a different place. Asserted
   * against a real database because what is being proved is a `where`:
   * the visibility edge is a relation filter, and `resolvedFor` chooses among
   * rows Postgres returns.
   */
  describe('the readers behind /home and /children', () => {
    function makeDashboard(): DashboardService {
      return new DashboardService(
        prisma as unknown as PrismaService,
        {
          computeFreshness: async () => ({
            state: 'fresh',
            lastSyncAt: null,
            staleSources: [],
          }),
        } as unknown as FreshnessService,
        // The roster refresh is an upstream call; the fixture is the roster.
        { ensureStudentsAvailable: async () => undefined } as unknown as MashovSessionService,
        new UserItemStateService(prisma as unknown as PrismaService),
        { get: () => undefined } as unknown as ConfigService,
      );
    }

    function makeFeed(): FeedService {
      return new FeedService(
        prisma as unknown as PrismaService,
        { get: () => undefined } as unknown as ConfigService,
      );
    }

    function makeChildren(): ChildrenService {
      return new ChildrenService(
        prisma as unknown as PrismaService,
        { ensureStudentsAvailable: async () => undefined } as unknown as MashovSessionService,
        {} as unknown as MashovHttpClient,
        new UserItemStateService(prisma as unknown as PrismaService),
        { get: () => undefined } as unknown as ConfigService,
        new ConnectionScopeService(
          prisma as unknown as PrismaService,
          { decrypt: (value: string) => value } as unknown as EncryptionService,
        ),
      );
    }

    /** Every feed item this fixture could produce, by source id. */
    async function feedSourceIds(userId: string): Promise<string[]> {
      const dashboard = await makeDashboard().getDashboard(userId);
      const feed = await makeFeed().getFeed(1, 100, userId);
      return [
        ...dashboard.feed.map((item) => item.sourceId),
        ...feed.data.map((item) => item.sourceId),
      ];
    }

    describe('R3 — the feed renders only the caller mailbox and children', () => {
      it("keeps the other household's mail off both feeds", async () => {
        expect(await feedSourceIds(USER_A)).toContain(HH_CONV_A);
        expect(await feedSourceIds(USER_A)).not.toContain(HH_CONV_B);

        expect(await feedSourceIds(USER_B)).toContain(HH_CONV_B);
        expect(await feedSourceIds(USER_B)).not.toContain(HH_CONV_A);
      });

      it("keeps the other household's children off both feeds", async () => {
        // A guard, not this fix's red: every feed ITEM is already year-scoped
        // by child, so the unscoped roster could not put a foreign child's
        // homework here. What the unscoped roster did reach was the school map
        // built from it -- which is R5 below, and is pinned at the `where`
        // level in `feed.service.spec.ts`.
        const forA = await makeFeed().getFeed(1, 100, USER_A);
        const guidsA = forA.data.map((item) => item.studentGuid).filter(Boolean);

        // The shared child is A's too, and the unlinked one is everybody's.
        expect(guidsA).toContain(SHARED);
        expect(guidsA).not.toContain(OWN_B);
      });

      it('leaves the unattributed conversation visible to both', async () => {
        // NULL means "ownership unknown, re-stamp on the next walk". The feed
        // follows the same rule as the inbox rather than inventing its own.
        await prisma.mailConversation.update({
          where: { conversationId: HH_CONV_B },
          data: { householdConnectionId: null },
        });

        expect(await feedSourceIds(USER_A)).toContain(HH_CONV_B);
        expect(await feedSourceIds(USER_B)).toContain(HH_CONV_B);
      });
    });

    describe("R5 — a child's school comes from the caller's own connections", () => {
      /** The shared child's `schoolId`, as each surface reports it. */
      async function sharedChildSchoolIds(userId: string): Promise<string[]> {
        const dashboard = await makeDashboard().getDashboard(userId);
        const feed = await makeFeed().getFeed(1, 100, userId);
        return [
          ...dashboard.children
            .filter((child) => child.studentGuid === SHARED)
            .map((child) => child.schoolId ?? 'null'),
          ...feed.data
            .filter((item) => item.studentGuid === SHARED)
            .map((item) => item.schoolId ?? 'null'),
        ];
      }

      it('reports each parent their own connection for the child they share', async () => {
        // The child is stamped to B, which is the state B's sync leaves
        // behind. A used to be handed CONN_B -- an id A does not own, which
        // the client cannot resolve against `me.schools`, so A's chip could
        // never match their own child.
        const forA = await sharedChildSchoolIds(USER_A);
        const forB = await sharedChildSchoolIds(USER_B);

        expect(forA.length).toBeGreaterThan(0);
        expect(new Set(forA)).toEqual(new Set([CONN_A]));
        expect(forB.length).toBeGreaterThan(0);
        expect(new Set(forB)).toEqual(new Set([CONN_B]));
      });

      it('does not depend on which parent synced last', async () => {
        // The same oscillation B1 described: moving the stamp must not move
        // either parent's badge.
        for (const stamp of [CONN_A, CONN_B, CONN_A]) {
          await prisma.student.update({
            where: { studentGuid: SHARED },
            data: { householdConnectionId: stamp },
          });

          expect(new Set(await sharedChildSchoolIds(USER_A))).toEqual(new Set([CONN_A]));
          expect(new Set(await sharedChildSchoolIds(USER_B))).toEqual(new Set([CONN_B]));
        }
      });
    });

    describe('R6 — /children agrees with /dashboard and /feed', () => {
      it('reports the same school for the shared child on all three', async () => {
        // `/children` derived these four fields from the routing stamp while
        // the other two went through the visibility edge, so the two endpoints
        // disagreed about the same child: `/children` emitted an id the caller
        // does not own with `schoolName`, `schoolShortLabel` and `semel` all
        // null, so the badge vanished there while `/home` showed one.
        const children = await makeChildren().getChildren(USER_A);
        const dashboard = await makeDashboard().getDashboard(USER_A);
        const feed = await makeFeed().getFeed(1, 100, USER_A);

        const child = children.data.find((row) => row.studentGuid === SHARED);
        const card = dashboard.children.find((row) => row.studentGuid === SHARED);
        const item = feed.data.find((row) => row.studentGuid === SHARED);

        expect(child?.schoolId).toBe(CONN_A);
        expect(card?.schoolId).toBe(CONN_A);
        expect(item?.schoolId).toBe(CONN_A);

        expect(child?.schoolShortLabel).toBe(card?.schoolShortLabel);
        expect(child?.schoolShortLabel).toBe(item?.schoolShortLabel);

        // And the two fields only `/children` carries are populated, where
        // they used to be null for exactly this child.
        expect(child?.schoolName).not.toBeNull();
        expect(child?.semel).toBe(SEMEL);
      });

      it('gives the other parent their own connection for the same child', async () => {
        const children = await makeChildren().getChildren(USER_B);

        expect(children.data.find((row) => row.studentGuid === SHARED)?.schoolId).toBe(CONN_B);
      });

      it('reports no school for the child nobody lists', async () => {
        // All four `null` is the contract's "no badge", and the right answer
        // while ownership is genuinely unknown.
        const children = await makeChildren().getChildren(USER_A);
        const child = children.data.find((row) => row.studentGuid === UNLINKED);

        expect(child).toMatchObject({
          schoolId: null,
          schoolName: null,
          schoolShortLabel: null,
          semel: null,
        });
      });
    });

    describe('R13 — the fallback badge belongs to the caller', () => {
      it('reports 0 for a user with no connection, not the other households', async () => {
        // The only state that reaches the fallback: `_count._all === 0`, which
        // is a user between unlinking and re-linking. Both conversations in
        // the fixture are unread and stamped, so the unscoped count was 2.
        const dashboard = await makeDashboard().getDashboard(USER_C);

        expect(dashboard.summary.newConversations).toBe(0);
      });

      it('still sums the cached counts for a user who has connections', async () => {
        // So the fix cannot be satisfied by always reporting zero. One
        // connection each, so each parent reads their own cached number
        // rather than the household total of both.
        const dashboard = await makeDashboard().getDashboard(USER_A);

        expect(dashboard.summary.newConversations).toBe(CACHED_A);
        await expect(
          makeDashboard()
            .getDashboard(USER_B)
            .then((result) => result.summary.newConversations),
        ).resolves.toBe(CACHED_B);
      });

      it('counts the unattributed conversation for the connectionless user', async () => {
        // NULL is admitted here on the same terms as everywhere else, so the
        // fallback is a real count over what they may see rather than zero by
        // construction.
        await prisma.mailConversation.update({
          where: { conversationId: HH_CONV_A },
          data: { householdConnectionId: null },
        });

        const dashboard = await makeDashboard().getDashboard(USER_C);

        expect(dashboard.summary.newConversations).toBe(1);
      });
    });

    describe('R16 — a release request goes out under the caller credentials', () => {
      /**
       * The shared child is stamped to B, and `requireStudent` admits them for
       * both parents -- correctly, because the visibility edge lists both.
       * What must not follow is A's early-release request being sent upstream
       * under B's decrypted Mashov password, into B's account. Mashov accepts
       * it (same school, same child, well-formed request), so a guard that
       * only works because upstream says no is no guard: the assertion is that
       * no call carries B's credentials at all.
       */
      function upstreamSpy() {
        return {
          getForTarget: jest.fn().mockResolvedValue([]),
          putForTarget: jest.fn().mockResolvedValue(undefined),
          deleteForTarget: jest.fn().mockResolvedValue(undefined),
        };
      }

      function childrenWith(upstream: ReturnType<typeof upstreamSpy>): ChildrenService {
        return new ChildrenService(
          prisma as unknown as PrismaService,
          { ensureStudentsAvailable: async () => undefined } as unknown as MashovSessionService,
          upstream as unknown as MashovHttpClient,
          new UserItemStateService(prisma as unknown as PrismaService),
          { get: () => undefined } as unknown as ConfigService,
          new ConnectionScopeService(prisma as unknown as PrismaService, {
            decrypt: (value: string) => value,
          } as unknown as EncryptionService),
        );
      }

      /** Every `ConnectionTarget` any of the three mutations spent. */
      function targetsSpent(upstream: ReturnType<typeof upstreamSpy>) {
        return [
          ...upstream.putForTarget.mock.calls.map((args) => args[2]),
          ...upstream.deleteForTarget.mock.calls.map((args) => args[1]),
        ];
      }

      it("sends A's release for the child stamped to B under A's own connection", async () => {
        const upstream = upstreamSpy();
        const children = childrenWith(upstream);

        await children.createStudentRelease(SHARED, { reason: 'רופא' }, USER_A);
        await children.updateStudentRelease(SHARED, 17, { reason: 'רופא' }, USER_A);
        await children.deleteStudentRelease(SHARED, 17, USER_A);

        const targets = targetsSpent(upstream);
        expect(targets).toHaveLength(3);
        for (const target of targets) {
          expect(target).toMatchObject({
            id: CONN_A,
            username: 'parent-a',
            password: 'enc-parent-a',
          });
        }
      });

      it("still routes B's own request through B", async () => {
        const upstream = upstreamSpy();

        await childrenWith(upstream).createStudentRelease(SHARED, { reason: 'רופא' }, USER_B);

        expect(targetsSpent(upstream)).toEqual([
          expect.objectContaining({ id: CONN_B, password: 'enc-parent-b' }),
        ]);
      });

      it('refuses the child only the other parent lists, before resolving anything', async () => {
        const upstream = upstreamSpy();

        await expect(
          childrenWith(upstream).createStudentRelease(OWN_B, { reason: 'רופא' }, USER_A),
        ).rejects.toThrow();

        expect(upstream.putForTarget).not.toHaveBeenCalled();
        expect(upstream.deleteForTarget).not.toHaveBeenCalled();
      });
    });

    describe('N1 — the school card belongs to the caller', () => {
      it("does not show the other household's school", async () => {
        // `findFirst({ where: { active: true } })` ordered by `lastLoginAt`
        // desc, so the most recently used household in the whole table won.
        // Renaming B's school and touching its row makes B that household.
        await prisma.householdConnection.update({
          where: { id: CONN_B },
          data: { schoolName: 'בית ספר אחר', lastLoginAt: new Date() },
        });

        const dashboard = await makeDashboard().getDashboard(USER_A);

        expect(dashboard.school.schoolName).toBe('בית ספר משותף');
      });
    });
  });
});

/**
 * Split the migration into executable statements.
 *
 * `$executeRawUnsafe` takes one statement at a time, and the file contains a
 * `DO $$ ... END $$` block whose body has its own semicolons, so a naive split
 * on `;` would tear it apart.
 */
function splitSql(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const statements: string[] = [];
  let buffer = '';
  let inDollarBlock = false;
  for (const segment of withoutComments.split(/(\$\$)/)) {
    if (segment === '$$') {
      inDollarBlock = !inDollarBlock;
      buffer += segment;
      continue;
    }
    if (inDollarBlock) {
      buffer += segment;
      continue;
    }
    const parts = segment.split(';');
    for (let index = 0; index < parts.length; index += 1) {
      buffer += parts[index];
      if (index < parts.length - 1) {
        if (buffer.trim()) statements.push(buffer.trim());
        buffer = '';
      }
    }
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

/**
 * Two mailboxes, two households — the mail read and mutate paths.
 *
 * `MailService` is built against real Postgres with the real
 * `ConnectionScopeService`, because the property under test is not "the
 * service filters a list": it is that a foreign `conversationId` never
 * resolves to the connection that owns it and so never reaches
 * `putForTarget` under that household's credentials. With a mocked scope the
 * grouping is whatever the mock says, and the grouping is the whole hazard.
 *
 * The http client is a spy that resolves. A guard that only works because the
 * upstream call fails is not a guard.
 */
describe('Two mailboxes, two households', () => {
  const MAIL_SEMEL = 778898;
  const MAIL_USER_A = 'hhm-user-a';
  const MAIL_USER_B = 'hhm-user-b';
  const MAIL_CONN_A = 'hhm-conn-a';
  const MAIL_CONN_B = 'hhm-conn-b';
  const CONV_A = 'hhm-conv-a';
  const CONV_B = 'hhm-conv-b';
  const CONV_NULL = 'hhm-conv-null';
  const MAIL_CONVERSATIONS = [CONV_A, CONV_B, CONV_NULL];
  const MSG_B = 'hhm-msg-b';
  const MSG_NULL = 'hhm-msg-null';
  const FILE_ID = 'hhm-file-1';

  let prisma: PrismaClient;
  let upstream: {
    getForTarget: jest.Mock;
    getResponseForTarget: jest.Mock;
    putForTarget: jest.Mock;
    deleteForTarget: jest.Mock;
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.mailMessage.deleteMany({
      where: { conversationId: { in: MAIL_CONVERSATIONS } },
    });
    await prisma.mailConversation.deleteMany({
      where: { conversationId: { in: MAIL_CONVERSATIONS } },
    });
    await prisma.householdConnection.deleteMany({ where: { schoolCode: MAIL_SEMEL } });
    await prisma.appUser.deleteMany({ where: { id: { in: [MAIL_USER_A, MAIL_USER_B] } } });
  }

  function makeMailService(): MailService {
    upstream = {
      getForTarget: jest.fn().mockResolvedValue({}),
      getResponseForTarget: jest
        .fn()
        .mockResolvedValue({ data: new ArrayBuffer(0), headers: {}, status: 200 }),
      putForTarget: jest.fn().mockResolvedValue(1),
      deleteForTarget: jest.fn().mockResolvedValue({}),
    };

    const scope = new ConnectionScopeService(
      prisma as unknown as PrismaService,
      { decrypt: (value: string) => value } as unknown as EncryptionService,
    );

    return new MailService(
      prisma as unknown as PrismaService,
      upstream as unknown as MashovHttpClient,
      scope,
    );
  }

  async function seedMail(): Promise<void> {
    await cleanup();

    for (const [id, username] of [
      [MAIL_USER_A, 'mailbox-parent-a'],
      [MAIL_USER_B, 'mailbox-parent-b'],
    ]) {
      await prisma.appUser.create({
        data: {
          id,
          mashovUserId: `upstream-${id}`,
          username,
          displayName: username,
          semel: MAIL_SEMEL,
        },
      });
    }

    for (const [id, userId, username, lastLoginAt] of [
      [MAIL_CONN_A, MAIL_USER_A, 'mailbox-parent-a', new Date('2026-11-01T00:00:00Z')],
      // The more recently used connection, so an unscoped fallback would pick
      // it for A's unstamped rows.
      [MAIL_CONN_B, MAIL_USER_B, 'mailbox-parent-b', new Date('2026-11-18T00:00:00Z')],
    ] as Array<[string, string, string, Date]>) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId,
          username,
          schoolCode: MAIL_SEMEL,
          schoolYear: YEAR,
          encryptedPassword: 'enc',
          schoolName: 'בית ספר דואר',
          active: true,
          lastLoginAt,
          cachedNewCount: 99,
        },
      });
    }

    const conversation = (conversationId: string, stamp: string | null) => ({
      conversationId,
      subject: `נושא ${conversationId}`,
      senderNamePreview: 'מורה',
      sendTime: new Date('2026-11-10T08:00:00Z'),
      isUnread: true,
      labels: [],
      lastFetchedAt: new Date('2026-11-10T08:05:00Z'),
      householdConnectionId: stamp,
    });

    await prisma.mailConversation.createMany({
      data: [
        conversation(CONV_A, MAIL_CONN_A),
        conversation(CONV_B, MAIL_CONN_B),
        // Ownership unknown, which this branch admits for everyone rather than
        // hiding from both parents.
        conversation(CONV_NULL, null),
      ],
    });

    // One message under each of the OTHER two conversations. The unlink's
    // message predicate is the one delete on this branch that was deliberately
    // WIDENED, so the fixture has to hold rows it must not reach: B's, and an
    // unattributed one that belongs to nobody. Without these, a predicate that
    // widened all the way to every conversation in the database would still
    // pass every case here.
    await prisma.mailMessage.createMany({
      data: [
        {
          messageId: MSG_B,
          conversationId: CONV_B,
          householdConnectionId: MAIL_CONN_B,
          senderId: 'sender-b',
          senderName: 'מורה',
          subject: `נושא ${CONV_B}`,
          bodyHtmlSanitized: '<p>גוף ההודעה</p>',
          sendTime: new Date('2026-11-10T08:00:00Z'),
          isNew: true,
          recipients: [],
          files: [],
        },
        {
          messageId: MSG_NULL,
          conversationId: CONV_NULL,
          householdConnectionId: null,
          // An attachment, so the download path reaches the credential
          // resolve instead of 404ing earlier on a missing file.
          files: [{ fileId: FILE_ID, fileName: 'file.pdf' }],
          senderId: 'sender-null',
          senderName: 'מורה',
          subject: `נושא ${CONV_NULL}`,
          bodyHtmlSanitized: '<p>גוף ההודעה</p>',
          sendTime: new Date('2026-11-10T08:00:00Z'),
          isNew: true,
          recipients: [],
        },
      ],
    });
  }

  /** B's row exactly as the database holds it, for a byte-for-byte compare. */
  async function rowB() {
    return prisma.mailConversation.findUnique({ where: { conversationId: CONV_B } });
  }

  function noUpstreamCall(): void {
    expect(upstream.getForTarget).not.toHaveBeenCalled();
    expect(upstream.putForTarget).not.toHaveBeenCalled();
    expect(upstream.deleteForTarget).not.toHaveBeenCalled();
    expect(upstream.getResponseForTarget).not.toHaveBeenCalled();
  }

  beforeEach(seedMail);

  it("lists only the caller's own mail, plus the unattributed row", async () => {
    const mail = makeMailService();

    const forA = await mail.getConversations(1, 100, 'all', undefined, MAIL_USER_A);
    const idsA = forA.data.map((item) => item.conversationId);

    expect(idsA).toContain(CONV_A);
    expect(idsA).toContain(CONV_NULL);
    expect(idsA).not.toContain(CONV_B);
  });

  it('shows the unattributed conversation to both households', async () => {
    // NULL means "ownership unknown, re-stamp on the next walk". Excluding it
    // would empty the inbox on a deployment that has not re-synced since the
    // ownership migration.
    const mail = makeMailService();

    for (const userId of [MAIL_USER_A, MAIL_USER_B]) {
      const list = await mail.getConversations(1, 100, 'all', undefined, userId);
      expect(list.data.map((item) => item.conversationId)).toContain(CONV_NULL);
    }
  });

  it("404s a schoolId that belongs to the other household", async () => {
    const mail = makeMailService();

    await expect(
      mail.getConversations(1, 100, 'all', MAIL_CONN_B, MAIL_USER_A),
    ).rejects.toMatchObject({ status: 404 });

    // ...and serves the caller's own, plus the unattributed row: the chip
    // narrows to one school's mail AND the mail whose ownership is not yet
    // known, rather than hiding the latter behind a chip it can never match.
    const own = await mail.getConversations(1, 100, 'all', MAIL_CONN_A, MAIL_USER_A);
    // Order-independent: all three fixture conversations share one `sendTime`,
    // so `orderBy: { sendTime: 'desc' }` leaves the order between them undefined.
    expect(own.data.map((item) => item.conversationId).sort()).toEqual(
      [CONV_A, CONV_NULL].sort(),
    );
  });

  it("404s the other household's conversation detail with no upstream call", async () => {
    const mail = makeMailService();

    await expect(mail.getConversationDetail(CONV_B, MAIL_USER_A)).rejects.toMatchObject({
      status: 404,
    });
    noUpstreamCall();
  });

  const MUTATIONS: Array<{
    name: string;
    call: (mail: MailService, ids: string[]) => Promise<{ updated: number }>;
  }> = [
    { name: 'archive', call: (mail, ids) => mail.archive(ids, MAIL_USER_A) },
    { name: 'unarchive', call: (mail, ids) => mail.unarchive(ids, MAIL_USER_A) },
    { name: 'markUnread', call: (mail, ids) => mail.markUnread(ids, MAIL_USER_A) },
    {
      name: 'markConversationsRead',
      call: (mail, ids) => mail.markConversationsRead(ids, MAIL_USER_A),
    },
  ];

  it.each(MUTATIONS)(
    "$name refuses the other household's conversation, locally and upstream",
    async ({ call }) => {
      const before = await rowB();
      const mail = makeMailService();

      await expect(call(mail, [CONV_B])).resolves.toEqual({ updated: 0 });

      expect(await rowB()).toEqual(before);
      noUpstreamCall();
    },
  );

  it.each(MUTATIONS)(
    "$name leaves the other household's cached badge count alone",
    async ({ call }) => {
      // `updateCachedNewCount()` with no argument rewrote the column on every
      // active connection in the database, so one parent acting on one
      // conversation wrote into every other household's row -- for a number
      // that could not have changed.
      const mail = makeMailService();

      await call(mail, [CONV_A]);

      const connB = await prisma.householdConnection.findUnique({
        where: { id: MAIL_CONN_B },
        select: { cachedNewCount: true },
      });
      expect(connB?.cachedNewCount).toBe(99);
    },
  );

  it.each(MUTATIONS)('$name acts on the own id in a mixed list', async ({ call }) => {
    const before = await rowB();
    const mail = makeMailService();

    await expect(call(mail, [CONV_A, CONV_B])).resolves.toEqual({ updated: 1 });

    expect(await rowB()).toEqual(before);
    for (const callArgs of upstream.putForTarget.mock.calls) {
      expect(callArgs[1]).toEqual([CONV_A]);
    }
  });

  /**
   * B3's stamped branch, on the one path where its stated bound does not hold.
   *
   * `ConnectionScopeService.resolveOrFallback` honours `userId` only on the
   * FALLBACK branch; a non-null stamp resolves to that connection's
   * credentials whoever is asking. ADR-0030 accepts that as the `I6` ruling,
   * bounded by "Mashov rejects it, so the symptom is an empty list rather than
   * a leak".
   *
   * `downloadMessageAttachment` escapes the bound. It checks ownership on the
   * CONVERSATION and resolves credentials from the MESSAGE, and an
   * unattributed conversation is visible to every household by the branch-wide
   * NULL rule. So household B could reach a message stamped to A under A's
   * decrypted password — and Mashov accepts it, because the credentials and
   * the message do belong together.
   */
  describe('an attachment on a message stamped to the other household', () => {
    /** The shape the ownership backfill leaves behind: NULL over a stamp. */
    async function stampTheMessageToA(): Promise<void> {
      await prisma.mailMessage.update({
        where: { messageId: MSG_NULL },
        data: { householdConnectionId: MAIL_CONN_A },
      });
    }

    it("refuses the other household's message, and spends no credentials on it", async () => {
      await stampTheMessageToA();
      const mail = makeMailService();

      await expect(
        mail.downloadMessageAttachment(CONV_NULL, MSG_NULL, FILE_ID, MAIL_USER_B),
      ).rejects.toMatchObject({ status: 404 });

      // The whole point: nothing went upstream. A guard that only works
      // because Mashov says no is not a guard, and here Mashov would say yes.
      noUpstreamCall();
    });

    it("still serves the owning household", async () => {
      // So the guard cannot be satisfied by refusing everyone.
      await stampTheMessageToA();
      const mail = makeMailService();

      await mail
        .downloadMessageAttachment(CONV_NULL, MSG_NULL, FILE_ID, MAIL_USER_A)
        .catch(() => undefined);

      expect(upstream.getResponseForTarget).toHaveBeenCalled();
    });

    it('still serves an unstamped message to either household', async () => {
      // NULL stays admitted. Tightening it here would empty the attachment
      // path on any deployment that has not re-synced, which is the same
      // reason canSee admits NULL everywhere else.
      const mail = makeMailService();

      await mail
        .downloadMessageAttachment(CONV_NULL, MSG_NULL, FILE_ID, MAIL_USER_B)
        .catch(() => undefined);

      expect(upstream.getResponseForTarget).toHaveBeenCalled();
    });
  });

  /**
   * R2 — the unlink that could not succeed.
   *
   * `deleteOneConnection` deleted `mailMessage` by `householdConnectionId` and
   * then `mailConversation` by the same key, relying on the two stamps being in
   * sync. The detail fetch wrote messages with no stamp at all, and
   * `MailMessage.conversation` has no `onDelete` (so `Restrict`), so one
   * NULL-stamped message under a stamped conversation made
   * `mailConversation.deleteMany` violate `mail_message_conversationId_fkey`
   * and aborted the whole `$transaction` — on every retry, recoverable only by
   * hand in the database.
   *
   * Asserted at service level: `deleteConnection` resolving `{ ok: true }` is
   * the whole of the 204, because `school-links.controller.ts` puts a static
   * `@HttpCode(HttpStatus.NO_CONTENT)` on a handler that does nothing but await
   * this service.
   */
  describe('unlinking a school whose conversations have been opened', () => {
    function makeConnectionService(): ConnectionService {
      return new ConnectionService(
        prisma as unknown as PrismaService,
        {
          encrypt: (value: string) => value,
          decrypt: (value: string) => value,
        } as unknown as EncryptionService,
        { get: () => undefined } as unknown as ConfigService,
        {} as unknown as SchoolYearService,
        { invalidateConnection: () => undefined } as unknown as MashovSessionService,
      );
    }

    const MSG_A = 'hhm-msg-a';

    /**
     * The blast radius. `conversationId IN (…)` is wider than the stamp
     * predicate it replaced, so what has to be asserted is not only that A's
     * rows go but that nothing else does: B's conversation and its message,
     * and the unattributed conversation and its message, which belong to no
     * connection and so cannot be deleted by either arm.
     */
    async function expectOthersUntouched(): Promise<void> {
      await expect(
        prisma.mailConversation.count({ where: { conversationId: CONV_B } }),
      ).resolves.toBe(1);
      await expect(
        prisma.mailMessage.count({ where: { messageId: MSG_B } }),
      ).resolves.toBe(1);
      await expect(
        prisma.mailConversation.count({ where: { conversationId: CONV_NULL } }),
      ).resolves.toBe(1);
      await expect(
        prisma.mailMessage.count({ where: { messageId: MSG_NULL } }),
      ).resolves.toBe(1);
    }

    it('unlinks after the detail fetch has written a message', async () => {
      const mail = makeMailService();
      upstream.getForTarget.mockResolvedValue({
        conversationId: CONV_A,
        subject: `נושא ${CONV_A}`,
        sendTime: '2026-11-10T08:00:00Z',
        isNew: true,
        messages: [
          {
            messageId: MSG_A,
            conversationId: CONV_A,
            senderId: 'sender-a',
            senderName: 'מורה',
            subject: `נושא ${CONV_A}`,
            body: '<p>גוף ההודעה</p>',
            sendTime: '2026-11-10T08:00:00Z',
            isNew: true,
            recipients: [],
            files: [],
          },
        ],
      });

      await mail.getConversationDetail(CONV_A, MAIL_USER_A);

      // The stamping half of the fix: the message the hydration wrote carries
      // the conversation's household.
      const written = await prisma.mailMessage.findUnique({
        where: { messageId: MSG_A },
        select: { householdConnectionId: true },
      });
      expect(written?.householdConnectionId).toBe(MAIL_CONN_A);

      await expect(
        makeConnectionService().deleteConnection(MAIL_USER_A, MAIL_CONN_A),
      ).resolves.toEqual({ ok: true });

      await expect(
        prisma.mailConversation.count({ where: { conversationId: CONV_A } }),
      ).resolves.toBe(0);
      await expect(
        prisma.mailMessage.count({ where: { conversationId: CONV_A } }),
      ).resolves.toBe(0);
      await expectOthersUntouched();
    });

    it('unlinks when a message under its conversation is NULL-stamped', async () => {
      // The exact shape of every row written before the stamping fix. No
      // stamping change reaches these, so the delete predicate is what has to
      // stop depending on the stamp.
      await prisma.mailMessage.create({
        data: {
          messageId: MSG_A,
          conversationId: CONV_A,
          householdConnectionId: null,
          senderId: 'sender-a',
          senderName: 'מורה',
          subject: `נושא ${CONV_A}`,
          bodyHtmlSanitized: '<p>גוף ההודעה</p>',
          sendTime: new Date('2026-11-10T08:00:00Z'),
          isNew: true,
          recipients: [],
          files: [],
        },
      });

      await expect(
        makeConnectionService().deleteConnection(MAIL_USER_A, MAIL_CONN_A),
      ).resolves.toEqual({ ok: true });

      await expect(
        prisma.mailConversation.count({ where: { conversationId: CONV_A } }),
      ).resolves.toBe(0);
      await expect(
        prisma.mailMessage.count({ where: { messageId: MSG_A } }),
      ).resolves.toBe(0);
      await expectOthersUntouched();
    });
  });
});

/**
 * The label-set minor — one connection set, one label resolution.
 *
 * `resolveSchoolLabels` is a whole-list decision: two schools in one cluster
 * routinely share everything up to a " - …" qualifier, and a collision reverts
 * BOTH sides to their full names, because two chips reading the same thing are
 * worse than two long ones -- the parent cannot tell which filter they
 * pressed. Only a view of every school can make that call.
 *
 * `ChildrenService` resolved it over the household's whole connection set and
 * `common/student-school-map.ts` only over the schools present in the list, so
 * one school showed its expanded full name on a page listing both and its
 * short colliding label on a page listing one. R6 put `/children` on the
 * shared helper, which makes the two agree -- on the narrower answer. This is
 * the other half.
 *
 * The fixture is the discriminating one: two schools whose short labels
 * collide and ONE child, so the list holds a single school and cannot see the
 * collision by itself.
 */
describe('Two schools whose short labels collide', () => {
  const LABEL_SEMEL_X = 778897;
  const LABEL_SEMEL_Y = 778896;
  const LABEL_USER = 'hhl-user';
  const LABEL_CONN_X = 'hhl-conn-x';
  const LABEL_CONN_Y = 'hhl-conn-y';
  const LABEL_CHILD = 'hhl-guid-x';
  const LABEL_CONV = 'hhl-conv-x';
  /** Identical up to the " - …" qualifier `shorten` drops. */
  const SCHOOL_X = 'תיכון הרצל - שלוחה א';
  const SCHOOL_Y = 'תיכון הרצל - שלוחה ב';

  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.mailConversation.deleteMany({ where: { conversationId: LABEL_CONV } });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: LABEL_CHILD } });
    await prisma.student.deleteMany({ where: { studentGuid: LABEL_CHILD } });
    await prisma.householdConnection.deleteMany({
      where: { schoolCode: { in: [LABEL_SEMEL_X, LABEL_SEMEL_Y] } },
    });
    await prisma.appUser.deleteMany({ where: { id: LABEL_USER } });
  }

  async function seed(): Promise<void> {
    await cleanup();

    await prisma.appUser.create({
      data: {
        id: LABEL_USER,
        mashovUserId: `upstream-${LABEL_USER}`,
        username: 'label-parent',
        displayName: 'label-parent',
        semel: LABEL_SEMEL_X,
      },
    });

    for (const [id, schoolCode, schoolName] of [
      [LABEL_CONN_X, LABEL_SEMEL_X, SCHOOL_X],
      [LABEL_CONN_Y, LABEL_SEMEL_Y, SCHOOL_Y],
    ] as Array<[string, number, string]>) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId: LABEL_USER,
          username: 'label-parent',
          schoolCode,
          schoolYear: YEAR,
          encryptedPassword: 'enc',
          schoolName,
          // No parent-chosen label, so the collision rule is what decides.
          displayLabel: null,
          active: true,
        },
      });
    }

    // ONE child, at X only. This is what makes the fixture discriminating: a
    // reader labelling only the schools in its own list sees no collision.
    await prisma.student.create({
      data: {
        studentGuid: LABEL_CHILD,
        privateName: 'ילד',
        familyName: 'כלשהו',
        fullName: 'ילד הרצל',
        classCode: 'ז',
        classNum: 1,
        gender: 'M',
        isActive: true,
        householdConnectionId: LABEL_CONN_X,
      },
    });
    await prisma.studentConnection.create({
      data: {
        studentGuid: LABEL_CHILD,
        householdConnectionId: LABEL_CONN_X,
        lastSeenInRosterAt: new Date(),
      },
    });

    // ...and one conversation, also at X only, so the inbox page is the same
    // single-school shape as the children list.
    await prisma.mailConversation.create({
      data: {
        conversationId: LABEL_CONV,
        subject: 'נושא',
        senderNamePreview: 'מורה',
        sendTime: new Date('2026-11-11T08:00:00Z'),
        isUnread: true,
        labels: [],
        lastFetchedAt: new Date('2026-11-11T08:05:00Z'),
        householdConnectionId: LABEL_CONN_X,
      },
    });
  }

  beforeEach(seed);

  function makeChildren(): ChildrenService {
    return new ChildrenService(
      prisma as unknown as PrismaService,
      { ensureStudentsAvailable: async () => undefined } as unknown as MashovSessionService,
      {} as unknown as MashovHttpClient,
      new UserItemStateService(prisma as unknown as PrismaService),
      { get: () => undefined } as unknown as ConfigService,
      new ConnectionScopeService(
        prisma as unknown as PrismaService,
        { decrypt: (value: string) => value } as unknown as EncryptionService,
      ),
    );
  }

  function makeDashboard(): DashboardService {
    return new DashboardService(
      prisma as unknown as PrismaService,
      {
        computeFreshness: async () => ({ state: 'fresh', lastSyncAt: null, staleSources: [] }),
      } as unknown as FreshnessService,
      { ensureStudentsAvailable: async () => undefined } as unknown as MashovSessionService,
      new UserItemStateService(prisma as unknown as PrismaService),
      { get: () => undefined } as unknown as ConfigService,
    );
  }

  it('shows the collision-expanded name even on a list holding one school', async () => {
    const children = await makeChildren().getChildren(LABEL_USER);
    const child = children.data.find((row) => row.studentGuid === LABEL_CHILD);

    // Not 'תיכון הרצל', which is what both schools shorten to and what a
    // list-local resolution produces here.
    expect(child?.schoolShortLabel).toBe(SCHOOL_X);
  });

  it('agrees with the dashboard, which holds the same one school', async () => {
    const children = await makeChildren().getChildren(LABEL_USER);
    const dashboard = await makeDashboard().getDashboard(LABEL_USER);

    const child = children.data.find((row) => row.studentGuid === LABEL_CHILD);
    const card = dashboard.children.find((row) => row.studentGuid === LABEL_CHILD);

    expect(card?.schoolShortLabel).toBe(SCHOOL_X);
    expect(card?.schoolShortLabel).toBe(child?.schoolShortLabel);
  });

  it('shows the same expanded name in the inbox', async () => {
    // The third reader with the same inconsistency: it resolved over the
    // connections present in the PAGE, so a page holding one of two colliding
    // schools disagreed with both the others.
    const mail = new MailService(
      prisma as unknown as PrismaService,
      {
        getForTarget: async () => ({}),
        getResponseForTarget: async () => ({ data: new ArrayBuffer(0), headers: {}, status: 200 }),
        putForTarget: async () => 1,
        deleteForTarget: async () => ({}),
      } as unknown as MashovHttpClient,
      new ConnectionScopeService(
        prisma as unknown as PrismaService,
        { decrypt: (value: string) => value } as unknown as EncryptionService,
      ),
    );

    const inbox = await mail.getConversations(1, 100, 'all', undefined, LABEL_USER);
    const row = inbox.data.find((item) => item.conversationId === LABEL_CONV);

    expect(row?.schoolShortLabel).toBe(SCHOOL_X);
  });

  it('still shortens when nothing collides', async () => {
    // So the fix is the set rule rather than "always use the full name": with
    // the second school unlinked there is no collision left to expand.
    await prisma.householdConnection.update({
      where: { id: LABEL_CONN_Y },
      data: { active: false },
    });

    const children = await makeChildren().getChildren(LABEL_USER);

    expect(children.data[0]?.schoolShortLabel).toBe('תיכון הרצל');
  });
});

/**
 * R4 — the freshness card belongs to one household, and reads the edge.
 *
 * `computeContentFreshness` had no caller at all: it listed every active
 * `householdConnection` in the table and reported `worstContentFreshness`
 * across all of them, and then picked each connection's children by the
 * **routing stamp**. Both halves are wrong for the same reason, and both are
 * asserted here:
 *
 *  1. The stamp is whichever connection synced last, by design (ADR-0031). It
 *     routes a fetch; it cannot answer who may see a child. For a child two
 *     parents share, the parent without the stamp resolved `studentGuids: []`,
 *     so their verdict was `no_content` — which `worstContentFreshness` ranks
 *     above `current` and which therefore degraded the whole card. The B1
 *     shape, in the last place it survived.
 *  2. Aggregating the whole table means an unrelated household linking a fresh
 *     school this morning drags *every* household's card to `no_content`.
 *
 * Against a real database because both halves are a `where`: the visibility
 * edge is a relation filter whose semantics are Postgres's, and "no value
 * equals NULL" is what made the stamp query come back empty rather than
 * matching.
 *
 * `SchoolYearService` is stubbed to a fixed year so the verdict does not drift
 * with the wall clock — `resolveForSchool` jumps on 1 September, and this
 * suite's fixtures would start reading `stale_year` on their own.
 */
describe('The freshness card, scoped to one household', () => {
  let prisma: PrismaClient;

  const FR_SEMEL_A = 661100;
  const FR_SEMEL_B = 661200;
  const FR_YEAR = 2027;
  const FR_USER_A = 'fr-user-a';
  const FR_USER_B = 'fr-user-b';
  const FR_USERS = [FR_USER_A, FR_USER_B];
  const FR_CONN_A = 'fr-conn-a';
  const FR_CONN_B = 'fr-conn-b';
  /** A's own child, linked to A alone. */
  const FR_CHILD_A = 'fr-guid-a';
  /** The child both parents list, stamped to B — the state B's sync leaves. */
  const FR_SHARED = 'fr-guid-shared';
  const FR_GUIDS = [FR_CHILD_A, FR_SHARED];
  /** Past the 45-day new-year grace, so the verdict is a real `current`. */
  const FR_LESSON_DATE = new Date('2026-11-14T00:00:00Z');

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: FR_GUIDS } } });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: { in: FR_GUIDS } } });
    await prisma.student.deleteMany({ where: { studentGuid: { in: FR_GUIDS } } });
    await prisma.householdConnection.deleteMany({
      where: { schoolCode: { in: [FR_SEMEL_A, FR_SEMEL_B] } },
    });
    await prisma.appUser.deleteMany({ where: { id: { in: FR_USERS } } });
  }

  /**
   * The service under test, with both of its collaborators stubbed.
   *
   * `SyncRunService` is irrelevant here — `computeContentFreshness` never
   * touches it — but the constructor wants one, and empty maps make that
   * explicit rather than relying on it.
   */
  function makeFreshness(): FreshnessService {
    return new FreshnessService(
      {
        getAllSourceHealth: async () => new Map(),
        getLatestSuccessfulRuns: async () => new Map(),
      } as unknown as SyncRunService,
      prisma as unknown as PrismaService,
      {
        resolveForSchool: async () => ({ year: FR_YEAR, source: 'calendar' }),
      } as unknown as SchoolYearService,
    );
  }

  async function user(id: string, semel: number): Promise<void> {
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

  async function connection(id: string, userId: string, semel: number): Promise<void> {
    await prisma.householdConnection.create({
      data: {
        id,
        userId,
        username: userId,
        schoolCode: semel,
        schoolYear: FR_YEAR,
        encryptedPassword: `enc-${userId}`,
        schoolName: `בית ספר ${semel}`,
        active: true,
      },
    });
  }

  async function child(
    studentGuid: string,
    stamp: string | null,
    linkedTo: string[],
  ): Promise<void> {
    await prisma.student.create({
      data: {
        studentGuid,
        privateName: 'ילד',
        familyName: 'כלשהו',
        fullName: `ילד ${studentGuid}`,
        classCode: 'ז',
        classNum: 1,
        gender: 'M',
        isActive: true,
        householdConnectionId: stamp,
      },
    });
    for (const householdConnectionId of linkedTo) {
      await prisma.studentConnection.create({
        data: { studentGuid, householdConnectionId, lastSeenInRosterAt: new Date() },
      });
    }
  }

  async function homework(studentGuid: string, lessonId: number): Promise<void> {
    await prisma.homeworkItem.create({
      data: {
        studentGuid,
        lessonId,
        groupId: 500,
        lesson: 1,
        subjectName: 'מתמטיקה',
        homeworkText: 'תרגילים',
        lessonDate: FR_LESSON_DATE,
        schoolYear: FR_YEAR,
      },
    });
  }

  /**
   * Parks every connection and active child this suite did not seed.
   *
   * Mandatory, not hygiene. An unscoped read is decided by whatever a
   * neighbouring suite left behind, so without this the red case could pass
   * for the wrong reason and the green one could fail for one. The children
   * matter as well as the connections, because `connectionStudentWhere`
   * admits an UNLINKED child — deliberately, as everywhere on this branch —
   * so a stray one with recent homework would be counted by every connection
   * here. Restored afterwards, so the suite deactivates nothing permanently.
   */
  let parkedConnections: string[] = [];
  let parkedStudents: string[] = [];

  async function parkStrays(): Promise<void> {
    const connections = await prisma.householdConnection.findMany({
      where: { active: true, NOT: { id: { in: [FR_CONN_A, FR_CONN_B] } } },
      select: { id: true },
    });
    parkedConnections = connections.map((row) => row.id);
    await prisma.householdConnection.updateMany({
      where: { id: { in: parkedConnections } },
      data: { active: false },
    });

    const students = await prisma.student.findMany({
      where: { isActive: true, NOT: { studentGuid: { in: FR_GUIDS } } },
      select: { studentGuid: true },
    });
    parkedStudents = students.map((row) => row.studentGuid);
    await prisma.student.updateMany({
      where: { studentGuid: { in: parkedStudents } },
      data: { isActive: false },
    });
  }

  afterEach(async () => {
    await prisma.householdConnection.updateMany({
      where: { id: { in: parkedConnections } },
      data: { active: true },
    });
    await prisma.student.updateMany({
      where: { studentGuid: { in: parkedStudents } },
      data: { isActive: true },
    });
    parkedConnections = [];
    parkedStudents = [];
  });

  describe('a household whose connection lists nothing', () => {
    /**
     * A at one school with a linked child and fresh homework; B at another
     * with no children at all. Two separate households, which is the point:
     * B's silence is B's business.
     */
    beforeEach(async () => {
      await cleanup();
      await user(FR_USER_A, FR_SEMEL_A);
      await user(FR_USER_B, FR_SEMEL_B);
      await connection(FR_CONN_A, FR_USER_A, FR_SEMEL_A);
      await connection(FR_CONN_B, FR_USER_B, FR_SEMEL_B);
      await child(FR_CHILD_A, FR_CONN_A, [FR_CONN_A]);
      await homework(FR_CHILD_A, 9960);
      await parkStrays();
    });

    it("does not report the other household's empty school on this one's card", async () => {
      const service = makeFreshness();

      // Both halves on purpose. "A is current" alone is satisfied by ignoring
      // every other row, and "B is no_content" alone is satisfied by a card
      // that reports nothing to anybody.
      await expect(service.computeContentFreshness(FR_USER_A)).resolves.toMatchObject({
        status: 'current',
        newestContentAt: FR_LESSON_DATE.toISOString(),
      });
      await expect(service.computeContentFreshness(FR_USER_B)).resolves.toMatchObject({
        status: 'no_content',
        newestContentAt: null,
      });
    });
  });

  describe('a child two parents share', () => {
    /**
     * One school, two parents, one child both of them list — stamped to B,
     * which is the state B's sync leaves behind and the state in which A's
     * stamp query came back empty.
     */
    beforeEach(async () => {
      await cleanup();
      await user(FR_USER_A, FR_SEMEL_A);
      await user(FR_USER_B, FR_SEMEL_A);
      await connection(FR_CONN_A, FR_USER_A, FR_SEMEL_A);
      await connection(FR_CONN_B, FR_USER_B, FR_SEMEL_A);
      await child(FR_SHARED, FR_CONN_B, [FR_CONN_A, FR_CONN_B]);
      await homework(FR_SHARED, 9961);
      await parkStrays();
    });

    it('reports the shared child as content to both parents at once', async () => {
      const service = makeFreshness();

      await expect(service.computeContentFreshness(FR_USER_A)).resolves.toMatchObject({
        status: 'current',
      });
      await expect(service.computeContentFreshness(FR_USER_B)).resolves.toMatchObject({
        status: 'current',
      });
    });

    it('does not change either verdict when the other parent syncs', async () => {
      // The oscillation B1 described. A sync's only effect on ownership is the
      // routing stamp, so moving it in either direction must leave both cards
      // exactly where they were.
      const service = makeFreshness();

      for (const stamp of [FR_CONN_A, FR_CONN_B, FR_CONN_A]) {
        await prisma.student.update({
          where: { studentGuid: FR_SHARED },
          data: { householdConnectionId: stamp },
        });

        await expect(service.computeContentFreshness(FR_USER_A)).resolves.toMatchObject({
          status: 'current',
        });
        await expect(service.computeContentFreshness(FR_USER_B)).resolves.toMatchObject({
          status: 'current',
        });
      }
    });
  });
});
