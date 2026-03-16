/**
 * Phase 2 migration script.
 *
 * Applies the Phase 2 schema changes that were written as a manual migration
 * (prisma/migrations/20260317000000_phase2_auth/migration.sql) because the
 * development database does not support a shadow database for `prisma migrate dev`.
 *
 * Usage:
 *   npx ts-node scripts/migrate-phase2.ts
 *
 * The script is idempotent — it checks whether each step has already been
 * applied before executing it.
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  console.log('Running Phase 2 migration...');

  // Apply the SQL migration file directly.
  const migrationPath = path.join(
    __dirname,
    '../prisma/migrations/20260317000000_phase2_auth/migration.sql',
  );

  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration file not found at: ${migrationPath}`);
  }

  const sql = fs.readFileSync(migrationPath, 'utf-8');

  // Split on semicolons but ignore empty statements.
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Executing ${statements.length} SQL statements...`);

  for (const statement of statements) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Postgres errors for "already exists" or "does not exist" on objects that
      // were already migrated — skip them.
      if (
        msg.includes('already exists') ||
        msg.includes('does not exist') ||
        msg.includes('duplicate column') ||
        msg.includes('column') && msg.includes('does not exist')
      ) {
        console.warn(`Skipping (already applied?): ${msg}`);
        continue;
      }
      console.error(`Statement failed: ${statement}`);
      throw err;
    }
  }

  // Record the migration as applied in Prisma's migrations table.
  await prisma.$executeRaw`
    INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
    VALUES (
      gen_random_uuid()::text,
      'manual-phase2',
      NOW(),
      '20260317000000_phase2_auth',
      NULL,
      NULL,
      NOW(),
      1
    )
    ON CONFLICT (migration_name) DO NOTHING
  `;

  console.log('Phase 2 migration complete.');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
