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
 * Splitting on `;` leaves every statement carrying the comment lines that
 * preceded it, so a statement cannot be recognised — or discarded — by its
 * first character. Dropping anything that *starts* with `--` silently threw
 * away the whole `UPDATE "homework_item"` statement, which sits directly under
 * the "-- Backfill:" comment; an integration test caught it. Strip the leading
 * comment lines instead of filtering the statement out.
 */
export function stripLeadingComments(statement: string): string {
  const lines = statement.split('\n');
  while (lines.length > 0) {
    const first = (lines[0] ?? '').trim();
    if (first.length === 0 || first.startsWith('--')) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join('\n').trim();
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

  const statements = fs
    .readFileSync(migrationPath, 'utf-8')
    .split(';')
    .map(stripLeadingComments)
    .filter((statement) => statement.length > 0);

  console.log(`Executing ${statements.length} SQL statements...`);

  for (const statement of statements) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('already exists') ||
        msg.includes('does not exist') ||
        msg.includes('duplicate column')
      ) {
        console.warn(`Skipping (already applied?): ${msg.split('\n')[0]}`);
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

  console.log('School-year backfill complete.');
}

// Guarded so the file can be imported for its `stripLeadingComments` parser
// without running the migration as a side effect.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
