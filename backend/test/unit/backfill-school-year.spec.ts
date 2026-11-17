import {
  parseSqlStatements,
  migrationRecordStatement,
} from '../../scripts/backfill-school-year';

describe('backfill-school-year SQL', () => {
  describe('parseSqlStatements', () => {
    it('strips comment lines before splitting, so prose semicolons cannot leak', () => {
      const sql = [
        '-- This header is non-destructive; the UPDATE below then stamps rows.',
        'UPDATE "homework_item" SET "schoolYear" = 2026 WHERE "schoolYear" = 0;',
      ].join('\n');

      expect(parseSqlStatements(sql)).toEqual([
        'UPDATE "homework_item" SET "schoolYear" = 2026 WHERE "schoolYear" = 0',
      ]);
    });
  });

  describe('migrationRecordStatement', () => {
    it('guards the insert with NOT EXISTS rather than ON CONFLICT', () => {
      // `_prisma_migrations` has no unique constraint on migration_name — its
      // primary key is `id` — so ON CONFLICT (migration_name) always raises
      // "no unique or exclusion constraint matching the ON CONFLICT
      // specification", and the migration is never recorded on any database.
      const sql = migrationRecordStatement('20261117000000_school_year_scoping');

      expect(sql).not.toMatch(/ON CONFLICT/i);
      expect(sql).toMatch(/WHERE NOT EXISTS/i);
    });

    it('names the migration it records', () => {
      expect(migrationRecordStatement('20261117000000_school_year_scoping')).toContain(
        '20261117000000_school_year_scoping',
      );
    });
  });
});
