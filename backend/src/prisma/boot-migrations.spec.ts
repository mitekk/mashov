import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Guards the gap that made the roster-presence backfill a no-op in production.
 *
 * Production does not run `prisma migrate deploy` -- the Dockerfile boots with
 * `prisma db push`, which reconciles *schema* only. Every DDL statement in a
 * migration therefore applies for free (columns, indexes), and every DATA
 * statement is silently skipped. A backfill written as `UPDATE ... SET x =
 * updatedAt` looks applied, because the column it fills exists, while the
 * values never arrive.
 *
 * So each migration holding a data statement must either be executed
 * explicitly by the Dockerfile boot chain or be listed below with the reason
 * it is safe to skip.
 */
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const DOCKERFILE = join(__dirname, '..', '..', 'Dockerfile');

/** migration directory name -> why boot does not need to execute it */
const EXEMPT: Record<string, string> = {
  '20261119000000_sync_run_retention':
    'One-off catch-up only. SyncRunRetentionTask runs the identical DELETE ' +
    'nightly at 02:45, so the backlog clears itself within a day of deploy ' +
    'and the reads are bounded and indexed in the meantime.',
};

function dataStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => /^(UPDATE|DELETE|INSERT)\b/i.test(statement));
}

describe('migration boot chain', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it('finds migrations to check', () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it.each(migrations)('executes or exempts the data statements in %s', (name) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
    const statements = dataStatements(sql);

    if (statements.length === 0) {
      return;
    }

    const executedAtBoot = dockerfile.includes(`prisma/migrations/${name}/migration.sql`);
    const exemptReason = EXEMPT[name];

    expect(executedAtBoot || Boolean(exemptReason)).toBe(true);
  });

  it('has no exemption for a migration that no longer exists', () => {
    for (const name of Object.keys(EXEMPT)) {
      expect(migrations).toContain(name);
    }
  });

  it('gives a reason for every exemption', () => {
    for (const reason of Object.values(EXEMPT)) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
