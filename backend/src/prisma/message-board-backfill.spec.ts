import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261126000000_message_board_first_seen',
  'migration.sql',
);

/**
 * The backfill exists to stop one specific thing: the digest announcing the
 * whole active message board on the first run after the column is added.
 *
 * `db push` adds `firstSeenAt` with DEFAULT now(), which Postgres writes into
 * every existing row. The backfill must move those rows OUTSIDE
 * DIGEST_BOARD_LOOKBACK_DAYS. `updatedAt` cannot do that: MessageBoardTask's
 * upsert writes an `update` payload for every still-posted notice on every
 * 06:00 run, so `@updatedAt` is always within the last day -- the very churn
 * the column was added to escape.
 */
describe('message board firstSeenAt backfill', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('does not backfill from updatedAt, which the 06:00 upsert churns daily', () => {
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    expect(statements).not.toMatch(/SET\s+"firstSeenAt"\s*=\s*"updatedAt"/i);
  });

  it('backfills to a timestamp well outside any plausible board lookback', () => {
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const match = /interval\s+'(\d+)\s+days?'/i.exec(statements);

    expect(match).not.toBeNull();
    // DIGEST_BOARD_LOOKBACK_DAYS defaults to 2 and is an operator knob; this
    // has to clear anything they would plausibly set.
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(30);
  });

  it('runs exactly once ever, via the data_backfill marker', () => {
    // Not merely idempotent. Repeating it is UNSAFE: a notice the sync task
    // genuinely created minutes before a restart would be backdated out of the
    // lookback and never announced. A timestamp-based guard cannot tell that
    // row from a push default, so the marker table -- which exists for exactly
    // this -- is what gates it.
    expect(sql).toContain('data_backfill');
    expect(sql).toMatch(/message-board-first-seen/);
  });
});
