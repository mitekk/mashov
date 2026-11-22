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
 *  3. The backfill's completion ledger survives a second run. Idempotency here
 *     is a `syncRun` row being found by a real query, not a mock returning
 *     what the test told it to.
 */

import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { FeedService } from '../../backend/src/feed/feed.service';
import { ChildrenService } from '../../backend/src/children/children.service';
import { HistoryBackfillTask } from '../../backend/src/sync/tasks/history-backfill.task';
import { SyncRunService } from '../../backend/src/sync/sync-run.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { MashovSessionService } from '../../backend/src/session/mashov-session.service';
import type { MashovHttpClient } from '../../backend/src/session/mashov-http.client';
import type { UserItemStateService } from '../../backend/src/common/user-item-state.service';
import type { ConnectionScopeService } from '../../backend/src/common/connection-scope/connection-scope.service';
import type { SyncTaskRunResult } from '../../backend/src/sync/sync.types';

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

function okResult(): SyncTaskRunResult {
  // Non-zero: the backfill refuses to record a year complete when nothing
  // came back, because a refused historical login looks exactly like an
  // empty year.
  return {
    status: 'success',
    summary: { fetchedCount: 1, createdCount: 0, updatedCount: 1, failedCount: 0 },
    errorMessages: [],
  };
}

describe('School-year history window', () => {
  let prisma: PrismaClient;
  /**
   * Every assertion about the backfill is scoped to this connection. The
   * database is shared with the other integration suites, whose connections
   * are also `active: true` and are also backfilled by the same run — so a
   * bare call count measures the fixture, not the behaviour.
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
    );

    const result = await children.getTimetable(STUDENT_GUID);

    const slots = result.data.map((entry) => `${entry.day}:${entry.lesson}`);
    expect(slots).toEqual(['1:1']);
    expect(result.data[0].subjectName).toBe('Subject 2027');
  });

  /**
   * The coercion guard compares the newest row stamped with the backfilled
   * year against that year's span (Sep year-1 .. Aug year). Seeding one row
   * inside the span is what a real successful fetch would have left behind.
   */
  async function seedInSpanContent(year: number): Promise<void> {
    await seedHomeworkYears([year]);
  }

  it('is idempotent across two backfill runs', async () => {
    await seedInSpanContent(2026);
    const executed: Array<{ connectionId?: string; schoolYear: number }> = [];
    const task = {
      execute: jest
        .fn()
        .mockImplementation((context: { connectionId?: string; schoolYear: number }) => {
          executed.push({ connectionId: context.connectionId, schoolYear: context.schoolYear });
          return Promise.resolve(okResult());
        }),
    };

    const backfill = new HistoryBackfillTask(
      prisma as unknown as PrismaService,
      config('2026'),
      new SyncRunService(prisma as unknown as PrismaService),
      task as never,
      task as never,
      task as never,
      task as never,
      task as never,
      task as never,
      task as never,
      task as never,
    );

    const mine = () =>
      executed.filter((call) => call.connectionId === connectionId).map((c) => c.schoolYear);

    await backfill.run();
    const afterFirst = mine();

    await backfill.run();

    // Eight tasks for 2026 on the first run, nothing at all on the second:
    // the `history:2026:complete` syncRun row is the ledger, and it is read
    // back out of Postgres rather than from a mock.
    expect(afterFirst).toEqual(Array(8).fill(2026));
    expect(mine()).toEqual(afterFirst);

    const ledger = await prisma.syncRun.findMany({
      where: { source: 'history:2026:complete', householdConnectionId: connectionId },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('success');
  });

  it('retries a year whose ledger row failed', async () => {
    await seedInSpanContent(2026);
    const mineCalls: number[] = [];
    let run = 0;
    const task = {
      execute: jest.fn().mockImplementation((context: { connectionId?: string }) => {
        if (context.connectionId === connectionId) mineCalls.push(run);
        // Fail every task on the first run, succeed on the second.
        return Promise.resolve(
          run === 0
            ? {
                status: 'failed' as const,
                summary: { fetchedCount: 0, createdCount: 0, updatedCount: 0, failedCount: 1 },
                errorMessages: ['upstream said no'],
              }
            : okResult(),
        );
      }),
    };

    const backfill = new HistoryBackfillTask(
      prisma as unknown as PrismaService,
      config('2026'),
      new SyncRunService(prisma as unknown as PrismaService),
      task as never,
      task as never,
      task as never,
      task as never,
      task as never,
      task as never,
      task as never,
      task as never,
    );

    run = 0;
    await backfill.run();
    run = 1;
    await backfill.run();

    // Eight tasks attempted in each run: a failed ledger row does not count as
    // complete, so the year is retried rather than skipped.
    expect(mineCalls.filter((r) => r === 0)).toHaveLength(8);
    expect(mineCalls.filter((r) => r === 1)).toHaveLength(8);

    const ledger = await prisma.syncRun.findMany({
      where: { source: 'history:2026:complete', householdConnectionId: connectionId },
      orderBy: { startedAt: 'asc' },
    });
    expect(ledger.map((entry) => entry.status)).toEqual(['failed', 'success']);
  });
});
