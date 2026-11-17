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
import { parseSqlStatements } from '../../backend/scripts/backfill-school-year';
import { SchoolYearRolloverTask } from '../../backend/src/sync/tasks/school-year-rollover.task';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { SchoolYearService } from '../../backend/src/common/school-year/school-year.service';
import type { MashovSessionService } from '../../backend/src/session/mashov-session.service';
import type { StudentsTask } from '../../backend/src/sync/tasks/students.task';

const STUDENT_GUID = 'sy-student-1';
const SEMEL = 998877;

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

    const refreshRosterForConnection = jest
      .fn()
      .mockResolvedValue({ created: 0, updated: 1, deactivated: 0, year: 2027 });
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
      } as unknown as SchoolYearService,
      { refreshRosterForConnection } as unknown as MashovSessionService,
      { execute: studentsExecute } as unknown as StudentsTask,
    );

    await task.run();

    const after = await prisma.householdConnection.findUnique({
      where: { id: connection.id },
    });
    expect(after?.schoolYear).toBe(2027);
    expect(refreshRosterForConnection).toHaveBeenCalledWith(connection.id);
    expect(studentsExecute).toHaveBeenCalledWith({ connectionId: connection.id });
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

    const migrationPath = path.join(
      __dirname,
      '../../backend/prisma/migrations/20261117000000_school_year_scoping/migration.sql',
    );
    // Reuses the backfill script's own parser on purpose, so the two cannot
    // drift: naive `;`-splitting of this file both hides statements behind
    // their comments and cuts prose comments mid-sentence.
    const updates = parseSqlStatements(
      fs.readFileSync(migrationPath, 'utf-8'),
    ).filter((statement) => statement.toUpperCase().startsWith('UPDATE '));

    // One per year-scoped table.
    expect(updates).toHaveLength(5);
    for (const statement of updates) {
      await prisma.$executeRawUnsafe(statement);
    }

    const rows = await prisma.homeworkItem.findMany({ where: { studentGuid: STUDENT_GUID } });
    expect(rows).toHaveLength(before);
    expect(rows[0].schoolYear).toBe(2026);
    expect(rows[0].homeworkText).toBe('pre-column row');
  });
});
