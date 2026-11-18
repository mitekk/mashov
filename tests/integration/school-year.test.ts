/**
 * School-year scoping & rollover — integration tests.
 *
 * These run against a real Postgres, which is the point: the three things
 * being proved here are all database-level guarantees that a unit test with a
 * mocked Prisma cannot show.
 *
 *  1. Last year's rows and this year's coexist. Before the `schoolYear` column
 *     the unique keys made that impossible — next year's timetable row
 *     overwrote last year's, day by day and lesson by lesson.
 *  2. A connection's `schoolYear` advances with no environment change, which
 *     is what unfreezes the 13 sync crons (they read `conn.schoolYear`, never
 *     the env var).
 *  3. The backfill stamps pre-column rows with 2026 and loses nothing. The
 *     family's homework and behaviour history exists nowhere else.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import {
  parseSqlStatements,
  migrationRecordStatement,
} from '../../backend/scripts/backfill-school-year';
import { SchoolYearRolloverTask } from '../../backend/src/sync/tasks/school-year-rollover.task';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { SchoolYearService } from '../../backend/src/common/school-year/school-year.service';
import type { MashovSessionService } from '../../backend/src/session/mashov-session.service';
import type { StudentsTask } from '../../backend/src/sync/tasks/students.task';

const STUDENT_GUID = 'sy-student-1';
const SEMEL = 998877;

function migrationFile(): string {
  return path.join(
    __dirname,
    '../../backend/prisma/migrations/20261117000000_school_year_scoping/migration.sql',
  );
}

describe('School-year scoping & rollover', () => {
  let prisma: PrismaClient;

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
    await prisma.homeworkItem.deleteMany({ where: { studentGuid: STUDENT_GUID } });
    await prisma.timetableEntry.deleteMany({ where: { studentGuid: STUDENT_GUID } });
    await prisma.householdConnection.deleteMany({ where: { schoolCode: SEMEL } });
    await prisma.student.deleteMany({ where: { studentGuid: STUDENT_GUID } });
  });

  it("keeps last year's and this year's homework side by side after the year advances", async () => {
    await prisma.homeworkItem.create({
      data: {
        studentGuid: STUDENT_GUID,
        schoolYear: 2026,
        lessonId: 4242,
        groupId: 1,
        lessonDate: new Date('2026-06-28T00:00:00Z'),
        lesson: 3,
        subjectName: 'Math',
        homeworkText: "last year's homework",
      },
    });

    // Same student, same lessonId — only the year differs. Before the column
    // absorbed the year this was an upsert collision, not a second row.
    await prisma.homeworkItem.create({
      data: {
        studentGuid: STUDENT_GUID,
        schoolYear: 2027,
        lessonId: 4242,
        groupId: 1,
        lessonDate: new Date('2026-11-10T00:00:00Z'),
        lesson: 3,
        subjectName: 'Math',
        homeworkText: "this year's homework",
      },
    });

    const all = await prisma.homeworkItem.findMany({
      where: { studentGuid: STUDENT_GUID },
      orderBy: { schoolYear: 'asc' },
    });

    expect(all).toHaveLength(2);
    expect(all.map((row) => row.schoolYear)).toEqual([2026, 2027]);
    expect(all[0].homeworkText).toBe("last year's homework");

    const currentYearOnly = await prisma.homeworkItem.findMany({
      where: { studentGuid: STUDENT_GUID, schoolYear: { in: [2027, 0] } },
    });
    expect(currentYearOnly).toHaveLength(1);
    expect(currentYearOnly[0].homeworkText).toBe("this year's homework");
  });

  it("keeps last year's timetable row for the same day and lesson", async () => {
    for (const schoolYear of [2026, 2027]) {
      await prisma.timetableEntry.create({
        data: {
          studentGuid: STUDENT_GUID,
          schoolYear,
          groupId: 1,
          day: 1,
          lesson: 1,
          groupName: `Group ${schoolYear}`,
          subjectName: 'Math',
        },
      });
    }

    const rows = await prisma.timetableEntry.findMany({
      where: { studentGuid: STUDENT_GUID },
    });
    expect(rows).toHaveLength(2);
  });

  it("advances the connection's schoolYear with no environment change", async () => {
    const connection = await prisma.householdConnection.create({
      data: {
        schoolCode: SEMEL,
        schoolYear: 2026,
        username: 'sy-parent',
        encryptedPassword: 'enc',
        active: true,
      },
    });

    // Stands in for the real method, which logs in at the year it is handed,
    // reconciles against Mashov's answer and writes the confirmed year down.
    const refreshRosterForConnection = jest
      .fn()
      .mockImplementation(async (id: string, yearOverride?: number) => {
        const year = yearOverride ?? 2026;
        await prisma.householdConnection.update({
          where: { id },
          data: { schoolYear: year },
        });
        return { created: 0, updated: 1, deactivated: 0, year };
      });
    const studentsExecute = jest.fn().mockResolvedValue({
      status: 'success',
      summary: { fetchedCount: 1, createdCount: 0, updatedCount: 1, failedCount: 0 },
      errorMessages: [],
    });

    const task = new SchoolYearRolloverTask(
      prisma as unknown as PrismaService,
      {
        resolveForSchool: jest
          .fn()
          .mockResolvedValue({ year: 2027, source: 'schools-api' }),
        invalidate: jest.fn(),
      } as unknown as SchoolYearService,
      { refreshRosterForConnection } as unknown as MashovSessionService,
      { execute: studentsExecute } as unknown as StudentsTask,
    );

    await task.run();

    const after = await prisma.householdConnection.findUnique({
      where: { id: connection.id },
    });
    expect(after?.schoolYear).toBe(2027);
    // The candidate year is handed to the refresh so Mashov can veto it,
    // rather than being written to the DB first and asked about afterwards.
    expect(refreshRosterForConnection).toHaveBeenCalledWith(connection.id, 2027);
    expect(studentsExecute).toHaveBeenCalledWith({ connectionId: connection.id });
    // One roster refresh per connection, not two.
    expect(refreshRosterForConnection).toHaveBeenCalledTimes(1);
  });

  it('does not advance the connection when Mashov vetoes the candidate year', async () => {
    // 1 Sep: the calendar says 2027 but Mashov has not opened that year yet.
    // Writing 2027 anyway empties the family's lists, and the daily cron would
    // re-apply it every morning after any sign-in corrected it.
    const connection = await prisma.householdConnection.create({
      data: {
        schoolCode: SEMEL,
        schoolYear: 2026,
        username: 'sy-parent',
        encryptedPassword: 'enc',
        active: true,
      },
    });

    const task = new SchoolYearRolloverTask(
      prisma as unknown as PrismaService,
      {
        resolveForSchool: jest.fn().mockResolvedValue({ year: 2027, source: 'calendar' }),
        invalidate: jest.fn(),
      } as unknown as SchoolYearService,
      {
        // Mashov answers 2026 and the real method persists that.
        refreshRosterForConnection: jest.fn().mockImplementation(async (id: string) => {
          await prisma.householdConnection.update({
            where: { id },
            data: { schoolYear: 2026 },
          });
          return { created: 0, updated: 1, deactivated: 0, year: 2026 };
        }),
      } as unknown as MashovSessionService,
      { execute: jest.fn() } as unknown as StudentsTask,
    );

    await task.run();

    const after = await prisma.householdConnection.findUnique({
      where: { id: connection.id },
    });
    expect(after?.schoolYear).toBe(2026);
  });

  it('leaves a connection already on the resolved year untouched', async () => {
    const connection = await prisma.householdConnection.create({
      data: {
        schoolCode: SEMEL,
        schoolYear: 2027,
        username: 'sy-parent',
        encryptedPassword: 'enc',
        active: true,
      },
    });

    const refreshRosterForConnection = jest.fn();
    const task = new SchoolYearRolloverTask(
      prisma as unknown as PrismaService,
      {
        resolveForSchool: jest.fn().mockResolvedValue({ year: 2027, source: 'calendar' }),
        invalidate: jest.fn(),
      } as unknown as SchoolYearService,
      { refreshRosterForConnection } as unknown as MashovSessionService,
      { execute: jest.fn() } as unknown as StudentsTask,
    );

    await task.run();

    const after = await prisma.householdConnection.findUnique({
      where: { id: connection.id },
    });
    expect(after?.schoolYear).toBe(2027);
    expect(refreshRosterForConnection).not.toHaveBeenCalled();
  });

  it('runs every statement of the migration twice without error', async () => {
    // The file is executed on every container boot (backend/Dockerfile), so a
    // non-idempotent statement would stop the app from ever starting again.
    const statements = parseSqlStatements(
      fs.readFileSync(migrationFile(), 'utf-8'),
    );
    expect(statements).toHaveLength(21);

    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement);
      }
    }
  });

  it('backfills schoolYear 2026 on pre-column rows without losing any', async () => {
    // schoolYear 0 is what `prisma db push` leaves behind on rows that existed
    // before the column did.
    await prisma.homeworkItem.create({
      data: {
        studentGuid: STUDENT_GUID,
        schoolYear: 0,
        lessonId: 7,
        groupId: 1,
        lessonDate: new Date('2026-05-01T00:00:00Z'),
        lesson: 1,
        subjectName: 'History',
        homeworkText: 'pre-column row',
      },
    });

    const before = await prisma.homeworkItem.count({ where: { studentGuid: STUDENT_GUID } });

    // Reuses the backfill script's own parser on purpose, so the two cannot
    // drift: naive `;`-splitting of this file both hides statements behind
    // their comments and cuts prose comments mid-sentence.
    const updates = parseSqlStatements(
      fs.readFileSync(migrationFile(), 'utf-8'),
    ).filter((statement) => /^UPDATE "\w+" SET "schoolYear"/.test(statement));

    // One per year-scoped table. Deliberately matched on the year-stamping
    // shape rather than on "UPDATE", so the connection-dedupe statement in the
    // same file does not silently become part of this assertion.
    expect(updates).toHaveLength(5);
    for (const statement of updates) {
      await prisma.$executeRawUnsafe(statement);
    }

    const rows = await prisma.homeworkItem.findMany({ where: { studentGuid: STUDENT_GUID } });
    expect(rows).toHaveLength(before);
    expect(rows[0].schoolYear).toBe(2026);
    expect(rows[0].homeworkText).toBe('pre-column row');
  });

  it('deactivates all but the most recently used duplicate household connection', async () => {
    // The identity key moved from (schoolCode, schoolYear) to
    // (schoolCode, username), and the OLD per-year keying is what produced
    // more than one row per pair. With several active, reads and writes can
    // settle on different years.
    const dedupe = parseSqlStatements(fs.readFileSync(migrationFile(), 'utf-8')).filter(
      (statement) => statement.includes('AS stale'),
    );
    expect(dedupe).toHaveLength(1);

    const base = {
      schoolCode: 999001,
      username: 'dedupe-parent',
      encryptedPassword: 'enc',
      active: true,
    };

    // The duplicates this statement exists for can no longer be INSERTED:
    // `@@unique([schoolCode, username])` now forbids them. They can still
    // EXIST, which is the whole point -- they were written before the index,
    // and 20261120000000_connection_duplicate_collapse runs ahead of
    // `prisma db push` precisely so the index can be created over them. So the
    // fixture reproduces the pre-index world by dropping the constraint for
    // the duration of the test.
    // Prisma's `@@unique` is a unique INDEX, not a table constraint, so it is
    // dropped and recreated as one.
    await prisma.$executeRawUnsafe(
      'DROP INDEX IF EXISTS "household_connection_schoolCode_username_key"',
    );

    try {
      const older = await prisma.householdConnection.create({
        data: { ...base, schoolYear: 2026, lastLoginAt: new Date('2026-01-01T00:00:00Z') },
      });
      const newer = await prisma.householdConnection.create({
        data: { ...base, schoolYear: 2027, lastLoginAt: new Date('2026-11-01T00:00:00Z') },
      });
      // A different household must not be touched.
      const other = await prisma.householdConnection.create({
        data: { ...base, username: 'other-parent', schoolYear: 2026 },
      });

      // Run it twice: it executes on every container boot.
      await prisma.$executeRawUnsafe(dedupe[0]);
      await prisma.$executeRawUnsafe(dedupe[0]);

      const rows = await prisma.householdConnection.findMany({
        where: { id: { in: [older.id, newer.id, other.id] } },
        select: { id: true, active: true },
      });
      const activeById = new Map(rows.map((row) => [row.id, row.active]));

      expect(activeById.get(newer.id)).toBe(true);
      expect(activeById.get(older.id)).toBe(false);
      expect(activeById.get(other.id)).toBe(true);
    } finally {
      await prisma.householdConnection.deleteMany({ where: { schoolCode: 999001 } });
      await prisma.$executeRawUnsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS "household_connection_schoolCode_username_key" ON "household_connection" ("schoolCode", "username")',
      );
    }
  });

  it('records the migration in _prisma_migrations without an ON CONFLICT clause', async () => {
    // `_prisma_migrations` has no unique constraint on migration_name, so
    // ON CONFLICT (migration_name) raises rather than deduplicating. Running
    // the guarded statement twice must leave exactly one row.
    await prisma.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "_prisma_migrations" (' +
        'id text PRIMARY KEY, checksum text NOT NULL, finished_at timestamptz, ' +
        'migration_name text NOT NULL, logs text, rolled_back_at timestamptz, ' +
        'started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)',
    );
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    const statement = migrationRecordStatement('20261117000000_school_year_scoping');
    await prisma.$executeRawUnsafe(statement);
    await prisma.$executeRawUnsafe(statement);

    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM "_prisma_migrations" WHERE migration_name = '20261117000000_school_year_scoping'`,
    );
    expect(Number(rows[0].count)).toBe(1);
  });
});
