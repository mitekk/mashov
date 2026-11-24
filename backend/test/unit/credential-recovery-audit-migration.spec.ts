import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * `model CredentialRecoveryAudit` shipped with no migration at all.
 *
 * Production's schema comes from `prisma db push --accept-data-loss` on boot
 * (backend/Dockerfile), so the table IS created there from the model and
 * `writeAudit` does not throw — the audit trail is not empty. The committed
 * migration is still the record every other table has, and it is what
 * `prisma migrate deploy` needs against a fresh or scratch database, where
 * `db push` never runs.
 *
 * This spec pins the file to the model, because the two drift silently: a
 * column added to the model and not here is invisible until someone runs
 * `migrate deploy` and gets a table the code cannot write to.
 */
const ROOT = join(__dirname, '..', '..');
const MIGRATION = join(
  ROOT,
  'prisma',
  'migrations',
  '20261128000000_credential_recovery_audit',
  'migration.sql',
);
const SCHEMA = join(ROOT, 'prisma', 'schema.prisma');

describe('credential_recovery_audit migration', () => {
  it('exists', () => {
    expect(existsSync(MIGRATION)).toBe(true);
  });

  const sql = () => readFileSync(MIGRATION, 'utf8');

  it('creates the table the model maps to', () => {
    expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS "credential_recovery_audit"/);
  });

  it('carries every column the model declares, and no others', () => {
    // Drift in either direction is a bug: a missing column breaks every write
    // under `migrate deploy`, and an extra one is a column nothing fills.
    const model = readFileSync(SCHEMA, 'utf8')
      .split('model CredentialRecoveryAudit {')[1]
      .split('\n}')[0];

    const modelFields = [...model.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]);
    expect(modelFields.sort()).toEqual(
      ['at', 'id', 'idNumberHash', 'ip', 'schoolCode'].sort(),
    );

    for (const field of modelFields) {
      expect(sql()).toContain(`"${field}"`);
    }
  });

  it('declares the primary key', () => {
    expect(sql()).toMatch(/PRIMARY KEY \("id"\)/);
  });

  it('creates BOTH indexes the model declares', () => {
    // `@@index([schoolCode, at])` answers "how many resets at this school
    // lately" -- the abuse-amplifier question -- and `@@index([idNumberHash,
    // at])` answers it per identity. Prisma names them `<table>_<cols>_idx`.
    expect(sql()).toMatch(
      /CREATE INDEX IF NOT EXISTS "credential_recovery_audit_schoolCode_at_idx"/,
    );
    expect(sql()).toMatch(
      /CREATE INDEX IF NOT EXISTS "credential_recovery_audit_idNumberHash_at_idx"/,
    );
  });

  it('is idempotent DDL only, so boot under `db push` need not execute it', () => {
    const statements = sql()
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS/);
    }
  });

  it('never names the ID number column anything that suggests it holds one', () => {
    // The model stores a hash. A column called `idNumber` would invite someone
    // to write the real thing into it.
    expect(sql()).not.toMatch(/"idNumber"/);
  });
});
