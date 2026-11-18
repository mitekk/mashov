import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The ownership migrations, asserted as text.
 *
 * Production's schema comes from `prisma db push`, not from `migrate deploy`,
 * so these files' DDL is mostly parity for CI — but their DATA statements are
 * the only thing that stamps ownership onto rows that already exist, and
 * `boot-migrations.spec.ts` only checks that they are wired into the boot
 * chain, not that they are safe to run there. These cases check the three
 * properties that make them safe: idempotence, a guard that refuses to guess
 * when it cannot know the owner, and the collapse-before-index ordering that
 * keeps `@@unique([schoolCode, username])` from failing on the duplicates
 * `20261117000000` left behind.
 */
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const DOCKERFILE = join(__dirname, '..', '..', 'Dockerfile');

const COLLAPSE = '20261120000000_connection_duplicate_collapse';
const SCOPING = '20261120010000_connection_scoping';
const UNIQUE_KEYS = '20261120020000_connection_unique_keys';

function sqlOf(migration: string): string {
  return readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8');
}

/** The file with its SQL comments removed — comments mention everything. */
function code(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

const OWNED_TABLES = [
  'student',
  'mail_conversation',
  'mail_message',
  'notification_event',
  'school_activity',
  'parent_profile',
];

describe('connection scoping migrations', () => {
  describe(SCOPING, () => {
    const sql = sqlOf(SCOPING);
    const body = code(sql);

    it.each(OWNED_TABLES)('adds householdConnectionId to %s idempotently', (table) => {
      const pattern = new RegExp(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "householdConnectionId"`,
        'i',
      );
      expect(body).toMatch(pattern);
    });

    it('adds behavior_type_reference.schoolCode with a default', () => {
      // Without DEFAULT 0 an added NOT NULL Int under `db push
      // --accept-data-loss` can drop and recreate the populated table.
      expect(body).toMatch(
        /ALTER TABLE "behavior_type_reference" ADD COLUMN IF NOT EXISTS "schoolCode" INTEGER NOT NULL DEFAULT 0/i,
      );
    });

    it('creates every index idempotently', () => {
      const creates = body.match(/CREATE (UNIQUE )?INDEX[^;]*/gi) ?? [];
      expect(creates.length).toBeGreaterThan(0);
      for (const statement of creates) {
        expect(statement).toMatch(/IF NOT EXISTS/i);
      }
    });

    it('refuses to backfill unless exactly one connection is active', () => {
      // The whole point of the guard: with two connections there is no way to
      // know which owns a given row, and guessing would attribute one
      // school's mail to the other permanently.
      expect(body).toMatch(/active_count\s*<>\s*1/);
      expect(body).toMatch(/RETURN;/);
    });

    it('stamps every owned table and the behaviour taxonomy in the backfill', () => {
      for (const table of OWNED_TABLES) {
        expect(body).toMatch(
          new RegExp(`UPDATE "${table}"\\s+SET "householdConnectionId" = keeper_id`, 'i'),
        );
      }
      expect(body).toMatch(/UPDATE "behavior_type_reference"\s+SET "schoolCode" = keeper_semel/i);
    });

    it('only ever fills a NULL, so re-running changes nothing', () => {
      const updates = body.match(/UPDATE "[a-z_]+"\s+SET "householdConnectionId"[^;]*/gi) ?? [];
      expect(updates).toHaveLength(OWNED_TABLES.length);
      for (const statement of updates) {
        expect(statement).toMatch(/WHERE "householdConnectionId" IS NULL/i);
      }
    });
  });

  describe(COLLAPSE, () => {
    const body = code(sqlOf(COLLAPSE));

    it('re-points sync_run before deleting the rows it points at', () => {
      const repoint = body.search(/UPDATE "sync_run"/i);
      const del = body.search(/DELETE FROM "household_connection"/i);
      expect(repoint).toBeGreaterThanOrEqual(0);
      expect(del).toBeGreaterThanOrEqual(0);
      // sync_run.householdConnectionId has no FK, so these rows would survive
      // as danglers rather than erroring — re-pointing is what keeps the sync
      // history readable instead of silently orphaned.
      expect(repoint).toBeLessThan(del);
    });

    it('is a no-op on a database that has no household_connection table yet', () => {
      // It runs before `db push`, so on a first-ever deploy the table does not
      // exist and an unguarded statement would block boot.
      expect(body).toMatch(/to_regclass\(\s*'[^']*household_connection'\s*\)/i);
    });

    it('keeps the active row when exactly one of a duplicate group is active', () => {
      expect(body).toMatch(/"active"/);
    });
  });

  describe(UNIQUE_KEYS, () => {
    const body = code(sqlOf(UNIQUE_KEYS));

    it('creates the household_connection identity key', () => {
      expect(body).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS "household_connection_schoolCode_username_key"/i,
      );
    });

    it('leaves the three per-school collision keys to the task that adapts their upserts', () => {
      // Swapping notification_event, behavior_type_reference or
      // school_activity's key is not inert: it breaks four upsert `where`
      // clauses at compile time, and those four call sites belong to the
      // per-household task work. Doing it here would mean half-adapting them
      // now and rewriting them there.
      expect(body).not.toMatch(/notification_event/i);
      expect(body).not.toMatch(/behavior_type_reference/i);
      expect(body).not.toMatch(/school_activity/i);
    });

    it('creates no partial unique index', () => {
      // Prisma cannot express `WHERE active`, so `db push` would drop a partial
      // index on the next boot and the constraint would silently disappear.
      const creates = body.match(/CREATE UNIQUE INDEX[^;]*/gi) ?? [];
      expect(creates.length).toBeGreaterThan(0);
      for (const statement of creates) {
        expect(statement).not.toMatch(/\bWHERE\b/i);
      }
    });
  });

  describe('boot chain', () => {
    const dockerfile = readFileSync(DOCKERFILE, 'utf8');

    it('collapses duplicates before prisma db push creates the unique index', () => {
      const collapse = dockerfile.indexOf(`${COLLAPSE}/migration.sql`);
      const push = dockerfile.indexOf('prisma db push');
      expect(collapse).toBeGreaterThanOrEqual(0);
      expect(push).toBeGreaterThanOrEqual(0);
      expect(collapse).toBeLessThan(push);
    });

    it.each([SCOPING, UNIQUE_KEYS])('executes %s after prisma db push', (migration) => {
      const at = dockerfile.indexOf(`${migration}/migration.sql`);
      const push = dockerfile.indexOf('prisma db push');
      expect(at).toBeGreaterThan(push);
    });

    it('starts the app only after every migration has run', () => {
      const app = dockerfile.indexOf('node dist/src/main.js');
      for (const migration of [COLLAPSE, SCOPING, UNIQUE_KEYS]) {
        expect(dockerfile.indexOf(`${migration}/migration.sql`)).toBeLessThan(app);
      }
    });
  });
});
