/**
 * An unattributed `mail_conversation` that upstream has stopped returning —
 * integration tests against real Postgres.
 *
 * This is the row shape the reconciliation sweep exists for, and the one G1
 * still owed a fixture for. Nothing but the sweep ever clears `isUnread`: a
 * conversation deleted upstream, or moved to a folder that is neither inbox
 * nor archive, keeps its last-known `rawPayload` forever, so derivation cannot
 * fix it (`deriveIsUnread` would re-derive the same stale `true`). That is the
 * production incident `283c053` was measured on — 39 local unread against 16
 * upstream, 23 stale orphans.
 *
 * `householdConnectionId: null` is the hard case among those orphans, because
 * it is unreachable from both directions:
 *
 *  - A **connection-scoped** run sweeps `householdConnectionId: conn.id`, and
 *    no value equals SQL NULL, so it cannot match. Which is exactly why the
 *    scoping is the protection and the once-present "unstamped rows exist"
 *    gate was removed as a way to get permanently stuck.
 *  - The **shared-session** run does own the NULL rows, but it is gated off
 *    whenever any stamped row exists, because it has no idea what the
 *    per-connection walks refreshed and its `lastFetchedAt < runStartedAt`
 *    test would be answering about somebody else's mailbox.
 *  - No walk can ever re-stamp the row either, because re-stamping happens in
 *    an upsert's `update` branch and upstream no longer returns it.
 *
 * So on a deployment that has any stamped mail at all, this row's `isUnread`
 * is permanent. The tests below assert that outcome rather than wish it away,
 * and the last one shows what a parent actually sees because of it: the badge
 * excludes the row (every `cachedNewCount` is per connection) while the same
 * response's unread list includes it (the read scope admits NULL as
 * "ownership unknown"). Recorded as a Minor in
 * `docs/plans/merged-household-access-followups.md`.
 *
 * Why these cannot be proved against a mocked Prisma — `mail-inbox.task.spec.ts`
 * already covers the gates and the scoping with one:
 *
 *  1. `householdConnectionId: conn.id` not matching a NULL row is Postgres's
 *     three-valued logic, not a mock's `===`.
 *  2. The sweep's compound `where` (stamp + `isUnread` + `lastFetchedAt <` +
 *     `locallyMarkedUnreadAt: null`) and `cachedNewCount`'s
 *     `NOT array_contains ['archived']` are a real `UPDATE` and a real JSONB
 *     query.
 *  3. The badge/list divergence is two different queries over one table, which
 *     only a real table can disagree about.
 *
 * The suite deletes every `mail_conversation` in its own seed, as
 * `api.test.ts` and `auth.test.ts` already do, because three of the task's
 * decisions are made from table-wide counts. It runs under `--runInBand`.
 */

import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { MailInboxTask } from '../../backend/src/sync/tasks/mail-inbox.task';
import { MailService } from '../../backend/src/mail/mail.service';
import { SyncRunService } from '../../backend/src/sync/sync-run.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { EncryptionService } from '../../backend/src/session/encryption.service';
import type { MashovHttpClient } from '../../backend/src/session/mashov-http.client';
import type { ConnectionScopeService } from '../../backend/src/common/connection-scope/connection-scope.service';

const SEMEL = 556677;
const YEAR = 2027;
const USER_A = 'ms-user-a';
const USER_B = 'ms-user-b';
const CONN_A = 'ms-conn-a';
const CONN_B = 'ms-conn-b';

/** Upstream still returns this one, so the walk refreshes it. */
const LIVE_A = 'ms-conv-a-live';
/** Stamped to A, upstream has stopped returning it: A's run must sweep it. */
const ORPHAN_A = 'ms-conv-a-orphan';
/** The same, stamped to B: A's run must not touch it. */
const ORPHAN_B = 'ms-conv-b-orphan';
/** The fixture this file is about: no stamp, and upstream is done with it. */
const ORPHAN_NULL = 'ms-conv-null-orphan';
/** Unattributed too, but the user said "unread" on purpose. */
const PINNED_NULL = 'ms-conv-null-pinned';

const ALL_CONVERSATIONS = [LIVE_A, ORPHAN_A, ORPHAN_B, ORPHAN_NULL, PINNED_NULL];

/** Comfortably before any run's `startedAt`, so every orphan is stale. */
const LONG_AGO = new Date('2026-11-01T00:00:00Z');

function upstreamConversation(conversationId: string) {
  return {
    conversationId,
    subject: 'הודעה מבית הספר',
    sendTime: '2026-11-17T08:00:00',
    isNew: true,
    hasDrafts: false,
    hasAttachments: false,
    preventReply: false,
    labels: [],
    messages: [
      {
        messageId: `${conversationId}:msg`,
        conversationId,
        senderId: 'teacher-1',
        senderName: 'מורה',
        subject: 'הודעה מבית הספר',
        lastUpdate: '2026-11-17T08:00:00',
        sendTime: '2026-11-17T08:00:00',
        folder: 1,
        isNew: true,
        isDeleted: false,
        sendOnBehalf: false,
        sendViaEmail: false,
        sendViaSms: false,
        preventReply: false,
        sentViaEmail: false,
        sentViaSms: false,
      },
    ],
  };
}

describe('The unattributed mail orphan the sweep exists for', () => {
  let prisma: PrismaClient;
  let sweepEnabledBefore: string | undefined;

  /**
   * One live conversation on the inbox's first page and nothing else.
   *
   * The inbox must be non-empty or the `pageCount === 0` gate skips the sweep
   * — a 2xx empty walk is indistinguishable from a referer-gated or expired
   * session, and that gate is the production guard. The archive is empty,
   * which is fine: only hitting the archive page *cap* is a gate.
   */
  function fakeClient(liveFor: 'connection' | 'shared' | 'nothing') {
    const page = (url: string, wanted: 'connection' | 'shared') => {
      if (liveFor !== wanted) return [];
      if (!url.includes('/api/mail/inbox/conversations')) return [];
      if (!url.includes('skip=0')) return [];
      return [upstreamConversation(LIVE_A)];
    };
    return {
      getForConnection: jest.fn(async (url: string) => page(url, 'connection')),
      get: jest.fn(async (url: string) => page(url, 'shared')),
    };
  }

  function makeTask(client: { getForConnection: unknown; get: unknown }): MailInboxTask {
    return new MailInboxTask(
      client as unknown as MashovHttpClient,
      prisma as unknown as PrismaService,
      new SyncRunService(prisma as unknown as PrismaService),
      { decrypt: (value: string) => value } as unknown as EncryptionService,
    );
  }

  function makeMailService(): MailService {
    return new MailService(
      prisma as unknown as PrismaService,
      {} as unknown as MashovHttpClient,
      {} as unknown as ConnectionScopeService,
    );
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
    // The sweep defaults to on, but the suite is about the sweep, so it says so
    // rather than inheriting whatever the container was given.
    sweepEnabledBefore = process.env.MAIL_SWEEP_ENABLED;
    process.env.MAIL_SWEEP_ENABLED = 'true';
  });

  afterAll(async () => {
    await cleanup();
    if (sweepEnabledBefore === undefined) delete process.env.MAIL_SWEEP_ENABLED;
    else process.env.MAIL_SWEEP_ENABLED = sweepEnabledBefore;
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.syncRun.deleteMany({ where: { source: { startsWith: 'mail_inbox' } } });
    await prisma.mailMessage.deleteMany({});
    await prisma.mailConversation.deleteMany({});
    await prisma.householdConnection.deleteMany({ where: { schoolCode: SEMEL } });
    await prisma.appUser.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  }

  async function seed(): Promise<void> {
    await cleanup();

    for (const [id, username] of [
      [USER_A, 'mail-parent-a'],
      [USER_B, 'mail-parent-b'],
    ]) {
      await prisma.appUser.create({
        data: {
          id,
          mashovUserId: `upstream-${id}`,
          username,
          displayName: username,
          semel: SEMEL,
        },
      });
    }

    for (const [id, userId, username] of [
      [CONN_A, USER_A, 'mail-parent-a'],
      [CONN_B, USER_B, 'mail-parent-b'],
    ]) {
      await prisma.householdConnection.create({
        data: {
          id,
          userId,
          username,
          schoolCode: SEMEL,
          schoolYear: YEAR,
          encryptedPassword: 'enc',
          schoolName: 'בית ספר דואר',
          active: true,
          // Non-zero on purpose: a run that never writes the column must be
          // distinguishable from one that writes a zero.
          cachedNewCount: 99,
        },
      });
    }

    const conversation = (
      conversationId: string,
      stamp: string | null,
      extra: { locallyMarkedUnreadAt?: Date } = {},
    ) => ({
      conversationId,
      subject: `נושא ${conversationId}`,
      senderNamePreview: 'מורה',
      sendTime: new Date('2026-11-10T08:00:00Z'),
      isUnread: true,
      labels: [],
      lastFetchedAt: LONG_AGO,
      householdConnectionId: stamp,
      ...extra,
    });

    await prisma.mailConversation.createMany({
      data: [
        conversation(LIVE_A, CONN_A),
        conversation(ORPHAN_A, CONN_A),
        conversation(ORPHAN_B, CONN_B),
        conversation(ORPHAN_NULL, null),
        conversation(PINNED_NULL, null, { locallyMarkedUnreadAt: new Date('2026-11-12T09:00:00Z') }),
      ],
    });
  }

  /** conversationId -> isUnread, for the suite's own rows only. */
  async function unreadState(): Promise<Record<string, boolean>> {
    const rows = await prisma.mailConversation.findMany({
      where: { conversationId: { in: ALL_CONVERSATIONS } },
      select: { conversationId: true, isUnread: true },
    });
    return Object.fromEntries(rows.map((row) => [row.conversationId, row.isUnread]));
  }

  /**
   * Makes the shared-session path reachable: it is taken only when the task
   * finds no active user-owned connection anywhere, and a neighbouring suite's
   * leftovers would otherwise decide this test's outcome. Restores them, so
   * this suite leaves nothing deactivated behind it.
   */
  async function withNoActiveConnections<T>(body: () => Promise<T>): Promise<T> {
    const active = await prisma.householdConnection.findMany({
      where: { active: true, userId: { not: null } },
      select: { id: true },
    });
    const ids = active.map((row) => row.id);
    await prisma.householdConnection.updateMany({ where: { id: { in: ids } }, data: { active: false } });
    try {
      return await body();
    } finally {
      await prisma.householdConnection.updateMany({ where: { id: { in: ids } }, data: { active: true } });
    }
  }

  beforeEach(seed);

  it('sweeps the running connection\'s own orphan and cannot reach the unattributed one', async () => {
    await makeTask(fakeClient('connection')).execute({ connectionId: CONN_A });

    expect(await unreadState()).toEqual({
      // Upstream still returns it, and still says unread.
      [LIVE_A]: true,
      // A's orphan: refreshed by nothing, so swept.
      [ORPHAN_A]: false,
      // B's orphan: A's run has no business clearing it, and the scoping is
      // what stops it.
      [ORPHAN_B]: true,
      // `householdConnectionId: 'ms-conn-a'` does not match NULL in Postgres.
      // Not a decision the task makes -- three-valued logic makes it.
      [ORPHAN_NULL]: true,
      [PINNED_NULL]: true,
    });
  });

  it('is left unread by every connection\'s run, because no run owns it', async () => {
    for (const connectionId of [CONN_A, CONN_B]) {
      await makeTask(fakeClient('connection')).execute({ connectionId });
    }

    const state = await unreadState();
    expect(state[ORPHAN_NULL]).toBe(true);
    // And no walk can ever re-stamp it either: a stamp is written in an
    // upsert's `update` branch, which only runs for a conversation upstream
    // still returns. This row will not be in any walk again. That permanence
    // is the reason the "unstamped rows exist" gate was removed rather than
    // kept -- one such row would have frozen reconciliation for every
    // connection, which is a worse failure than this row staying unread.
    const stillUnstamped = await prisma.mailConversation.findUnique({
      where: { conversationId: ORPHAN_NULL },
      select: { householdConnectionId: true, lastFetchedAt: true },
    });
    expect(stillUnstamped?.householdConnectionId).toBeNull();
    expect(stillUnstamped?.lastFetchedAt).toEqual(LONG_AGO);
  });

  it('is not swept by the shared-session run either, while stamped rows exist', async () => {
    // The shared session owns the NULL rows, so this is the one run that could
    // clear it -- and it refuses, because stamped rows mean per-connection
    // walks are running and this run cannot tell what they refreshed.
    await withNoActiveConnections(async () => {
      await makeTask(fakeClient('shared')).execute();
    });

    const state = await unreadState();
    expect(state[ORPHAN_NULL]).toBe(true);
    // The gate's own input, asserted so a failure above says which half moved.
    await expect(
      prisma.mailConversation.count({ where: { householdConnectionId: { not: null } } }),
    ).resolves.toBeGreaterThan(0);
  });

  it('is swept by the shared-session run on a deployment with no stamped mail', async () => {
    // The pre-ownership shape, and the only run in which this row is
    // reconcilable at all: one mailbox, no stamps, so `lastFetchedAt <
    // runStartedAt` is a sound orphan test over the whole table.
    await prisma.mailMessage.deleteMany({});
    await prisma.mailConversation.deleteMany({ where: { householdConnectionId: { not: null } } });
    await prisma.mailConversation.create({
      data: {
        conversationId: LIVE_A,
        subject: 'חי',
        sendTime: new Date('2026-11-10T08:00:00Z'),
        isUnread: true,
        labels: [],
        lastFetchedAt: LONG_AGO,
        householdConnectionId: null,
      },
    });

    await withNoActiveConnections(async () => {
      await makeTask(fakeClient('shared')).execute();
    });

    const state = await unreadState();
    // Refreshed by the walk, so not an orphan.
    expect(state[LIVE_A]).toBe(true);
    // The whole point: upstream stopped returning it, so it is cleared.
    expect(state[ORPHAN_NULL]).toBe(false);
    // Except when the parent said "unread" themselves. For a conversation
    // upstream no longer returns, the local row is the only record of what
    // they wanted, and sweeping it would flip it back every seven minutes.
    expect(state[PINNED_NULL]).toBe(true);
  });

  it('is counted by no badge while being listed as unread, which is what the parent sees', async () => {
    // Characterising the consequence, not endorsing it. Recorded as a Minor in
    // docs/plans/merged-household-access-followups.md.
    await makeTask(fakeClient('connection')).execute({ connectionId: CONN_A });

    const connections = await prisma.householdConnection.findMany({
      where: { schoolCode: SEMEL },
      select: { id: true, cachedNewCount: true },
      orderBy: { id: 'asc' },
    });
    // A's run wrote its own count from its own mailbox: LIVE_A alone, since
    // ORPHAN_A was just swept. The seeded 99 proves the column was written.
    expect(connections).toEqual([
      { id: CONN_A, cachedNewCount: 1 },
      // Untouched by A's run, as it must be -- the badge sums these.
      { id: CONN_B, cachedNewCount: 99 },
    ]);

    const summary = await makeMailService().getSummary(USER_A);
    // The badge is the sum of per-connection counts, and the unattributed row
    // belongs to no connection, so it is in no count.
    expect(summary.newConversations).toBe(1);
    // The same response's unread list is read with the household scope, which
    // admits NULL as "ownership unknown" rather than hiding the row -- so the
    // row the badge does not count is right there, marked unread.
    expect(summary.recentConversations.map((conversation) => conversation.conversationId).sort()).toEqual(
      [LIVE_A, ORPHAN_NULL, PINNED_NULL].sort(),
    );
    expect(summary.recentConversations.every((conversation) => conversation.isNew)).toBe(true);
  });
});
