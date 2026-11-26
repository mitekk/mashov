/**
 * The history window — integration tests.
 *
 * These run against a real Postgres because every one of them is a
 * database-level guarantee a mocked Prisma cannot show:
 *
 *  1. The range predicate actually spans years, and the two-year cap actually
 *     excludes the third year back. A unit test can only assert the `where`
 *     object; only Postgres can say which rows come back.
 *  2. The timetable stays one row per slot when two years are present. That is
 *     the single read where a widened scope would be visibly wrong, and it is
 *     only wrong once there are two years in the table.
 *
 * A third case — the backfill's completion ledger surviving a second run —
 * was removed with `HistoryBackfillTask` itself (ADR-0046). Nothing fetches a
 * historical year any more; `MASHOV_YEAR` only widens the read window over
 * years already in the database, which is what 1 and 2 cover.
 */

import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { FeedService } from '../../backend/src/feed/feed.service';
import type { SyncOnReadService } from '../../backend/src/sync/sync-on-read.service';
import type { TimetableTask } from '../../backend/src/sync/tasks/timetable.task';
import type { BellsTask } from '../../backend/src/sync/tasks/bells.task';
import type { GroupsTask } from '../../backend/src/sync/tasks/groups.task';
import type { LessonsCountTask } from '../../backend/src/sync/tasks/lessons-count.task';
import type { MessageBoardTask } from '../../backend/src/sync/tasks/message-board.task';
import { ChildrenService } from '../../backend/src/children/children.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { MashovSessionService } from '../../backend/src/session/mashov-session.service';
import type { MashovHttpClient } from '../../backend/src/session/mashov-http.client';
import type { UserItemStateService } from '../../backend/src/common/user-item-state.service';
import type { ConnectionScopeService } from '../../backend/src/common/connection-scope/connection-scope.service';

const STUDENT_GUID = 'hist-student-1';
const SEMEL = 997755;
const CURRENT_YEAR = 2027;

/**
 * A minimal ConfigService stand-in. Typed locally rather than imported:
 * `@nestjs/config` lives in backend/node_modules, which the integration
 * tsconfig does not resolve.
 */
function config(startYear?: string) {
  return {
    get: (key: string) => (key === 'MASHOV_YEAR' ? startYear : undefined),
  } as never;
}

describe('School-year history window', () => {
  // REMOVED: two `HistoryBackfillTask` tests (idempotence across runs, and
  // resumption after a failed run). The task and its nightly cron are deleted
  // -- no historical year is fetched any more. Years already in the database
  // stay readable, and the read-window tests in this suite still cover that,
  // which is all `MASHOV_YEAR` now affects. See ADR-0046 and the amendment on
  // ADR-0025.

  let prisma: PrismaClient;
  /**
   * Every assertion here is scoped to this connection. The database is shared
   * with the other integration suites, whose connections are also
   * `active: true`, so an unscoped query measures the fixture rather than the
   * behaviour.
   */
  let connectionId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.syncRun.deleteMany({ where: { source: { startsWith: 'history:' } } });
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: STUDENT_GUID } });
    await prisma.timetableEntry.deleteMany({ where: { studentGuid: STUDENT_GUID } });
    await prisma.householdConnection.deleteMany({ where: { schoolCode: SEMEL } });
    await prisma.student.deleteMany({ where: { studentGuid: STUDENT_GUID } });

    await prisma.student.create({
      data: {
        studentGuid: STUDENT_GUID,
        familyName: 'Cohen',
        privateName: 'Avi',
        fullName: 'Avi Cohen',
        classCode: 'ח',
        classNum: 2,
        gender: 'M',
        isActive: true,
      },
    });
    const connection = await prisma.householdConnection.create({
      data: {
        schoolCode: SEMEL,
        schoolYear: CURRENT_YEAR,
        username: 'hist-parent',
        encryptedPassword: 'enc',
        active: true,
      },
    });
    connectionId = connection.id;
    // The per-child reads resolve their year from the child's own connection.
    // Unstamped, they fall back to the highest active year in a database that
    // other suites also write to -- so the stamp is what makes them stable.
    await prisma.student.update({
      where: { studentGuid: STUDENT_GUID },
      data: { householdConnectionId: connectionId },
    });
    await prisma.studentConnection.deleteMany({ where: { studentGuid: STUDENT_GUID } });
    await prisma.studentConnection.create({
      data: { studentGuid: STUDENT_GUID, householdConnectionId: connectionId },
    });
  });

  async function seedHomeworkYears(years: number[]): Promise<void> {
    for (const year of years) {
      await prisma.homeworkItem.create({
        data: {
          studentGuid: STUDENT_GUID,
          schoolYear: year,
          lessonId: 1000 + year,
          groupId: 1,
          // June of the year it belongs to: Mashov names a year by its end.
          lessonDate: new Date(`${year}-06-10T00:00:00Z`),
          lesson: 1,
          subjectName: 'History',
          homeworkText: `homework for ${year}`,
        },
      });
    }
  }

  function feedService(): FeedService {
    return new FeedService(prisma as unknown as PrismaService);
  }

  function childrenService(startYear?: string): ChildrenService {
    return new ChildrenService(
      prisma as unknown as PrismaService,
      { ensureStudentsAvailable: jest.fn() } as unknown as MashovSessionService,
      {} as unknown as MashovHttpClient,
      // No userId is passed to the reads below, so no state rows are read:
      // every row's state is the default, widened by the year derivation.
      {} as unknown as UserItemStateService,
      config(startYear),
      {} as unknown as ConnectionScopeService,
      // Read-path freshening. `SyncOnReadService.ensureFresh` returns early
      // under NODE_ENV=test, so these are inert here.
      { ensureFresh: async () => undefined, deadlineFromNow: () => Date.now() + 4_000 } as unknown as SyncOnReadService,
      { execute: async () => undefined } as unknown as TimetableTask,
      { execute: async () => undefined } as unknown as BellsTask,
      { execute: async () => undefined } as unknown as GroupsTask,
      { execute: async () => undefined } as unknown as LessonsCountTask,
      { execute: async () => undefined } as unknown as MessageBoardTask,
    );
  }

  async function archivedHomework(startYear?: string): Promise<string[]> {
    const result = await childrenService(startYear).getHomework(
      STUDENT_GUID,
      1,
      50,
      'archived',
    );
    return result.data.map((item) => item.homeworkText);
  }

  // ---------------------------------------------------------------------
  // The window reaches back exactly as far as it always did -- but behind
  // `ארכיון` now, not on the default view (ADR-0036). These three tests are
  // the ADR-0025 feed assertions, moved to the surface that still spans it.
  // ---------------------------------------------------------------------

  it('returns all three years of a three-year window in the archive, newest first', async () => {
    await seedHomeworkYears([2025, 2026, 2027]);

    expect(await archivedHomework('2025')).toEqual([
      'homework for 2026',
      'homework for 2025',
    ]);
  });

  it('excludes the third year back when MASHOV_YEAR reaches further than the cap', async () => {
    await seedHomeworkYears([2024, 2025, 2026, 2027]);

    const texts = await archivedHomework('2019');
    expect(texts).toEqual(['homework for 2026', 'homework for 2025']);
    expect(texts).not.toContain('homework for 2024');
  });

  it('leaves the archive empty when MASHOV_YEAR is unset and nothing was archived', async () => {
    await seedHomeworkYears([2025, 2026, 2027]);

    // One year wide, and the current year's rows are not past-year rows, so
    // nothing is archived by derivation.
    expect(await archivedHomework()).toEqual([]);
  });

  it('shows the current year alone on the unread tab, whatever the window spans', async () => {
    await seedHomeworkYears([2025, 2026, 2027]);

    const result = await childrenService('2025').getHomework(STUDENT_GUID, 1, 50, 'new');

    expect(result.data.map((item) => item.homeworkText)).toEqual(['homework for 2027']);
    expect(result.pagination.total).toBe(1);
  });

  it('keeps a prior year out of the feed entirely', async () => {
    await seedHomeworkYears([2026, 2027]);

    const result = await feedService().getFeed(1, 20);

    const mine = result.data.filter((item) => item.studentGuid === STUDENT_GUID);
    expect(mine.map((item) => item.summary)).toEqual(['homework for 2027']);
  });

  it('returns exactly one timetable entry per day and lesson with two years present', async () => {
    for (const year of [2026, 2027]) {
      await prisma.timetableEntry.create({
        data: {
          studentGuid: STUDENT_GUID,
          schoolYear: year,
          groupId: 10 + year,
          day: 1,
          lesson: 1,
          subjectName: `Subject ${year}`,
          groupName: `Group ${year}`,
        },
      });
    }

    const children = new ChildrenService(
      prisma as unknown as PrismaService,
      { ensureStudentsAvailable: jest.fn() } as unknown as MashovSessionService,
      {} as unknown as MashovHttpClient,
      {} as unknown as UserItemStateService,
      // Window wide open: the timetable must still not double up.
      config('2025'),
      // ConnectionScopeService: this read never leaves the database, so the
      // upstream target resolver is never reached.
      {} as unknown as ConnectionScopeService,
      // Read-path freshening. `SyncOnReadService.ensureFresh` returns early
      // under NODE_ENV=test, so these are inert here.
      { ensureFresh: async () => undefined, deadlineFromNow: () => Date.now() + 4_000 } as unknown as SyncOnReadService,
      { execute: async () => undefined } as unknown as TimetableTask,
      { execute: async () => undefined } as unknown as BellsTask,
      { execute: async () => undefined } as unknown as GroupsTask,
      { execute: async () => undefined } as unknown as LessonsCountTask,
      { execute: async () => undefined } as unknown as MessageBoardTask,
    );

    const result = await children.getTimetable(STUDENT_GUID);

    const slots = result.data.map((entry) => `${entry.day}:${entry.lesson}`);
    expect(slots).toEqual(['1:1']);
    expect(result.data[0].subjectName).toBe('Subject 2027');
  });

  /**
   * The coercion guard compares the newest row stamped with the historical
   * year against that year's span (Sep year-1 .. Aug year). Seeding one row
   * inside the span is what a real successful fetch would have left behind --
   * which is now the only way such rows arrive, since nothing backfills them.
   */
});
