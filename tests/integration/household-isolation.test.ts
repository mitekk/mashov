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
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { EncryptionService } from '../../backend/src/session/encryption.service';
import type { SchoolYearService } from '../../backend/src/common/school-year/school-year.service';
import type { MashovSessionService } from '../../backend/src/session/mashov-session.service';
import type { ConfigService } from '../../backend/node_modules/@nestjs/config';

const SEMEL = 778899;
const YEAR = 2027;
const USER_A = 'hh-user-a';
const USER_B = 'hh-user-b';
const CONN_A = 'hh-conn-a';
const CONN_B = 'hh-conn-b';
const OWN_A = 'hh-guid-a';
const OWN_B = 'hh-guid-b';
const SHARED = 'hh-guid-shared';
const UNLINKED = 'hh-guid-unlinked';
const ALL_GUIDS = [OWN_A, OWN_B, SHARED, UNLINKED];
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
    await prisma.userItemState.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    await prisma.studentConnection.deleteMany({
      where: { studentGuid: { in: ALL_GUIDS } },
    });
    await prisma.student.deleteMany({ where: { studentGuid: { in: ALL_GUIDS } } });
    await prisma.householdConnection.deleteMany({ where: { schoolCode: SEMEL } });
    await prisma.appUser.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
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

    for (const [id, userId, username] of [
      [CONN_A, USER_A, 'parent-a'],
      [CONN_B, USER_B, 'parent-b'],
    ]) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId,
          username,
          schoolCode: SEMEL,
          schoolYear: YEAR,
          encryptedPassword: 'enc',
          schoolName: 'בית ספר משותף',
          active: true,
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
