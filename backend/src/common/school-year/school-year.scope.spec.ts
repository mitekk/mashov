import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  UNSCOPED_SCHOOL_YEAR,
  currentYearScope,
  historyScope,
  schoolYearWindowFor,
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
});
