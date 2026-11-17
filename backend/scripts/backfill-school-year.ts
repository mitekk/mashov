/**
 * One-shot school-year backfill.
 *
 * Production's schema comes from `npx prisma db push --accept-data-loss`
 * (backend/Dockerfile), not from `prisma migrate deploy` — `student` has no
 * CREATE TABLE in any migration for exactly that reason. So `db push` adds the
 * `schoolYear` columns (non-destructively, because they are declared with
 * `@default(0)`), and THIS script is what stamps the pre-existing rows and
 * swaps the unique indexes.
 *
 * Normally you never run this by hand: `backend/Dockerfile` executes the same
 * SQL with `prisma db execute` on every boot, between `db push` and the app, so
 * there is no window in which a cron can see `schoolYear = 0` rows. This script
 * is the ops path for a database that was migrated before that ordering
 * existed, and it adds row-count assertions the boot path does not.
 *
 * Usage:
 *   npx ts-node scripts/backfill-school-year.ts
 *
 * Idempotent: every statement is guarded, and "already exists" / "does not
 * exist" are skipped. Safe to run on a database that `db push` has already
 * reindexed.
 *
 * It never deletes a row. `homework_item` and `behavior_item` hold the only
 * copy of the family's history and past dates cannot be re-fetched upstream.
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const MIGRATION_NAME = '20261117000000_school_year_scoping';

const COUNTED_TABLES = [
  'homework_item',
  'behavior_item',
  'subject_enrollment',
  'timetable_entry',
  'message_board_item',
];

/**
 * Splits the migration file into executable statements.
 *
 * Comment lines are stripped from the whole file *before* the split, not after.
 * Two bugs made that necessary, both caught by the integration test:
 *   - splitting first leaves every statement carrying the comments that
 *     preceded it, so discarding anything *starting* with `--` silently threw
 *     away the whole `UPDATE "homework_item"` statement under its
 *     `-- Backfill:` comment;
 *   - prose comments contain semicolons, so a `;`-split cuts mid-sentence and
 *     hands fragments of English to the database as SQL.
 *
 * Valid for this file, which has no string literals containing `--` or `;`.
 */
export function parseSqlStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const result = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "${table}"`,
    );
    counts[table] = Number(result[0]?.count ?? 0);
  }
  return counts;
}

async function main() {
  const before = await rowCounts();
  console.log('Row counts before:', before);

  const migrationPath = path.join(
    __dirname,
    `../prisma/migrations/${MIGRATION_NAME}/migration.sql`,
  );
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration file not found at: ${migrationPath}`);
  }

  const statements = parseSqlStatements(fs.readFileSync(migrationPath, 'utf-8'));

  console.log(`Executing ${statements.length} SQL statements...`);

  for (const statement of statements) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate key value violates unique constraint')) {
        // Only reachable on a database where the app was allowed to sync while
        // rows were still at schoolYear = 0, so each item now exists twice:
        // once at 0 and once at the live year. Stamping the 0 row would collide
        // with its own duplicate. Say exactly that, and name the query that
        // shows the damage — do NOT silently skip, and do not delete anything
        // here: homework_item and behavior_item are the only copy of the
        // family's history.
        console.error(
          [
            '',
            'Duplicate rows block the backfill.',
            `Failed statement: ${statement.replace(/\s+/g, ' ').slice(0, 120)}`,
            '',
            'This database was synced while rows were still at schoolYear = 0,',
            'so items exist twice. Inspect before doing anything:',
            '',
            '  SELECT "studentGuid", "lessonId", count(*), array_agg("schoolYear")',
            '  FROM "homework_item" GROUP BY 1, 2 HAVING count(*) > 1;',
            '',
            'Each pair is the same upstream item fetched twice. Resolve it by',
            'hand, keeping the row with the live year, then re-run this script.',
            '',
          ].join('\n'),
        );
        throw err;
      }
      if (
        msg.includes('already exists') ||
        msg.includes('does not exist') ||
        msg.includes('duplicate column')
      ) {
        // Prisma's message is multi-line with a blank first line, so name the
        // statement as well — a bare "Skipping" line says nothing in a runbook.
        const summary = statement.replace(/\s+/g, ' ').slice(0, 70);
        const reason = msg.split('\n').map((line) => line.trim()).filter(Boolean).pop();
        console.warn(`Skipping (already applied): ${summary} — ${reason}`);
        continue;
      }
      console.error(`Statement failed: ${statement}`);
      throw err;
    }
  }

  const after = await rowCounts();
  console.log('Row counts after:', after);

  for (const table of COUNTED_TABLES) {
    if (after[table] !== before[table]) {
      throw new Error(
        `Row count changed for ${table}: ${before[table]} -> ${after[table]}. ` +
          'This script must never lose a row — investigate before continuing.',
      );
    }
  }

  // Bookkeeping only, and strictly best-effort: a `db push`-managed database
  // has no `_prisma_migrations` table at all, which is production's situation.
  // Letting this throw would exit(1) after the backfill had already succeeded.
  try {
    await prisma.$executeRaw`
      INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      VALUES (
        gen_random_uuid()::text,
        'manual-school-year-scoping',
        NOW(),
        '20261117000000_school_year_scoping',
        NULL,
        NULL,
        NOW(),
        1
      )
      ON CONFLICT (migration_name) DO NOTHING
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `Could not record the migration in _prisma_migrations (this is expected on a db push-managed database): ${msg.split('\n').filter(Boolean).slice(-1)[0]}`,
    );
  }

  console.log('School-year backfill complete.');
}

// Guarded so the file can be imported for its `parseSqlStatements` parser
// without running the migration as a side effect.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
