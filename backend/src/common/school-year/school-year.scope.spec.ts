import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  UNSCOPED_SCHOOL_YEAR,
  currentSchoolYearForStudent,
  currentYearScope,
  historyScope,
  historyScopeForStudents,
  schoolYearByConnection,
  schoolYearWindowFor,
  schoolYearWindowsFor,
  yearScopeForStudents,
} from './school-year.scope';

function makePrisma(storedYear: number | null) {
  return {
    householdConnection: {
      findFirst: jest
        .fn()
        .mockResolvedValue(storedYear === null ? null : { schoolYear: storedYear }),
    },
  } as unknown as PrismaService;
}

function makeConfig(value?: string | number) {
  return {
    get: jest.fn((key: string) => (key === 'MASHOV_YEAR' ? value : undefined)),
  } as unknown as ConfigService;
}

describe('school-year scope', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('schoolYearWindowFor', () => {
    it('starts at the current year when MASHOV_YEAR is unset', async () => {
      const window = await schoolYearWindowFor(makePrisma(2027), makeConfig());

      expect(window).toEqual({ start: 2027, current: 2027 });
      expect(warn).not.toHaveBeenCalled();
    });

    it('honours a configured year earlier than the current one', async () => {
      const window = await schoolYearWindowFor(makePrisma(2027), makeConfig('2026'));

      expect(window).toEqual({ start: 2026, current: 2027 });
    });

    it('clamps a start year more than two back to two years back', async () => {
      const window = await schoolYearWindowFor(makePrisma(2027), makeConfig('2019'));

      expect(window).toEqual({ start: 2025, current: 2027 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('2025'));
    });

    it('ignores a configured year above the current one and warns', async () => {
      // Honouring it would produce start > current: an empty window, which
      // would hide the current year — the one thing MASHOV_YEAR must never
      // be able to do under its new meaning.
      const window = await schoolYearWindowFor(makePrisma(2027), makeConfig('2031'));

      expect(window).toEqual({ start: 2027, current: 2027 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('2031'));
    });

    it('ignores a non-numeric value', async () => {
      const window = await schoolYearWindowFor(makePrisma(2027), makeConfig('next-year'));

      expect(window).toEqual({ start: 2027, current: 2027 });
    });

    it('ignores an empty value', async () => {
      const window = await schoolYearWindowFor(makePrisma(2027), makeConfig('   '));

      expect(window).toEqual({ start: 2027, current: 2027 });
    });
  });

  describe('historyScope', () => {
    it('includes the unscoped year so half-migrated rows stay visible', () => {
      expect(historyScope({ start: 2025, current: 2027 })).toEqual({
        OR: [
          { schoolYear: UNSCOPED_SCHOOL_YEAR },
          { schoolYear: { gte: 2025, lte: 2027 } },
        ],
      });
    });
  });

  describe('currentYearScope', () => {
    it('excludes a prior year', () => {
      expect(currentYearScope(2027)).toEqual({
        schoolYear: { in: [2027, UNSCOPED_SCHOOL_YEAR] },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Two schools on different years. This happens every September: one school
  // has opened the new year and the other has not, and a single household-wide
  // year then hides one school's children entirely.
  // -------------------------------------------------------------------------
  describe('across two schools', () => {
    const CONN_A = { id: 'conn-a', schoolYear: 2026 };
    const CONN_B = { id: 'conn-b', schoolYear: 2027 };

    function makeMultiPrisma(
      connections: Array<{ id: string; schoolYear: number }>,
      students: Array<{ studentGuid: string; householdConnectionId: string | null }>,
    ) {
      return {
        householdConnection: {
          findMany: jest.fn().mockResolvedValue(connections),
          findFirst: jest.fn().mockResolvedValue(connections[0] ?? null),
          findUnique: jest.fn(({ where }) =>
            Promise.resolve(connections.find((conn) => conn.id === where.id) ?? null),
          ),
        },
        student: {
          findMany: jest.fn(({ where }) => {
            const ids: string[] = where?.householdConnectionId?.in ?? [];
            return Promise.resolve(
              students.filter(
                (student) =>
                  student.householdConnectionId &&
                  ids.includes(student.householdConnectionId),
              ),
            );
          }),
          findUnique: jest.fn(({ where }) =>
            Promise.resolve(
              students.find((student) => student.studentGuid === where.studentGuid) ?? null,
            ),
          ),
        },
      } as unknown as PrismaService;
    }

    const TWO_SCHOOLS = [
      { studentGuid: 'a1', householdConnectionId: 'conn-a' },
      { studentGuid: 'a2', householdConnectionId: 'conn-a' },
      { studentGuid: 'b1', householdConnectionId: 'conn-b' },
    ];

    it('reports each connection on its own year', async () => {
      const byConnection = await schoolYearByConnection(
        makeMultiPrisma([CONN_A, CONN_B], TWO_SCHOOLS),
      );

      expect([...byConnection.entries()]).toEqual([
        ['conn-a', 2026],
        ['conn-b', 2027],
      ]);
    });

    it('pairs each school\'s children with that school\'s year', async () => {
      const scope = await yearScopeForStudents(makeMultiPrisma([CONN_A, CONN_B], TWO_SCHOOLS));

      expect(scope).toEqual({
        OR: [
          { schoolYear: UNSCOPED_SCHOOL_YEAR },
          { studentGuid: { in: ['a1', 'a2'] }, schoolYear: { in: [2026] } },
          { studentGuid: { in: ['b1'] }, schoolYear: { in: [2027] } },
        ],
      });
    });

    it('does not admit one school\'s children at the other school\'s year', async () => {
      // The failure this shape exists to prevent: a flat `schoolYear IN (2026,
      // 2027)` would show school A's 2027 rows, which do not exist, and would
      // have shown last year's rows as current the moment B rolled over.
      const scope = await yearScopeForStudents(makeMultiPrisma([CONN_A, CONN_B], TWO_SCHOOLS));

      const pairs = scope.OR.filter(
        (clause): clause is { studentGuid: { in: string[] }; schoolYear: { in: number[] } } =>
          'studentGuid' in clause,
      );
      for (const pair of pairs) {
        const years = pair.schoolYear.in;
        expect(years).toHaveLength(1);
        if (pair.studentGuid.in.includes('b1')) expect(years).toEqual([2027]);
        else expect(years).toEqual([2026]);
      }
    });

    it('still admits pre-migration rows with no student predicate', async () => {
      // schoolYear 0 rows belong to whichever child they name, and excluding
      // them would blank a half-migrated database.
      const scope = await yearScopeForStudents(makeMultiPrisma([CONN_A], TWO_SCHOOLS));

      expect(scope.OR[0]).toEqual({ schoolYear: UNSCOPED_SCHOOL_YEAR });
    });

    it('reduces to the single-school case with one connection', async () => {
      const scope = await yearScopeForStudents(
        makeMultiPrisma([CONN_A], [
          { studentGuid: 'a1', householdConnectionId: 'conn-a' },
        ]),
      );

      expect(scope).toEqual({
        OR: [
          { schoolYear: UNSCOPED_SCHOOL_YEAR },
          { studentGuid: { in: ['a1'] }, schoolYear: { in: [2026] } },
        ],
      });
    });

    it('skips a connection with no children rather than emitting an empty IN', async () => {
      // `studentGuid IN ()` matches nothing, which is harmless, but a school
      // that has just been linked and not yet synced would contribute a clause
      // that can never match -- noise in every query plan.
      const scope = await yearScopeForStudents(
        makeMultiPrisma([CONN_A, CONN_B], [
          { studentGuid: 'a1', householdConnectionId: 'conn-a' },
        ]),
      );

      expect(scope.OR).toHaveLength(2);
    });

    it('gives each school its own history window', async () => {
      const scope = await historyScopeForStudents(
        makeMultiPrisma([CONN_A, CONN_B], TWO_SCHOOLS),
        makeConfig(2025),
      );

      expect(scope).toEqual({
        OR: [
          { schoolYear: UNSCOPED_SCHOOL_YEAR },
          { studentGuid: { in: ['a1', 'a2'] }, schoolYear: { gte: 2025, lte: 2026 } },
          { studentGuid: { in: ['b1'] }, schoolYear: { gte: 2025, lte: 2027 } },
        ],
      });
    });

    it('clamps each window independently', async () => {
      const windows = await schoolYearWindowsFor(
        makeMultiPrisma([CONN_A, CONN_B], TWO_SCHOOLS),
        makeConfig(2000),
      );

      expect(windows.get('conn-a')).toEqual({ start: 2024, current: 2026 });
      expect(windows.get('conn-b')).toEqual({ start: 2025, current: 2027 });
    });

    describe('currentSchoolYearForStudent', () => {
      it("returns the year of that child's own school", async () => {
        const prisma = makeMultiPrisma([CONN_A, CONN_B], TWO_SCHOOLS);

        await expect(currentSchoolYearForStudent(prisma, 'a1')).resolves.toBe(2026);
        await expect(currentSchoolYearForStudent(prisma, 'b1')).resolves.toBe(2027);
      });

      it('falls back to the household year for an unstamped child', async () => {
        const prisma = makeMultiPrisma([CONN_A], [
          { studentGuid: 'orphan', householdConnectionId: null },
        ]);

        await expect(currentSchoolYearForStudent(prisma, 'orphan')).resolves.toBe(2026);
      });

      it('falls back when the stamped connection has gone away', async () => {
        const prisma = makeMultiPrisma([CONN_A], [
          { studentGuid: 'a1', householdConnectionId: 'conn-deleted' },
        ]);

        await expect(currentSchoolYearForStudent(prisma, 'a1')).resolves.toBe(2026);
      });
    });
  });
});
