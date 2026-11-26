import { SyncRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { MailInboxTask } from './mail-inbox.task';

function makeSyncRun(id: string): SyncRun {
  return {
    id,
    source: MailInboxTask.SOURCE,
    status: 'running',
    startedAt: new Date('2026-03-18T00:00:00Z'),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    upstreamCount: null,
    localCount: null,
    errorMessage: null,
    householdConnectionId: null,
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'sender-1',
    senderName: 'Teacher',
    subject: 'Subject',
    lastUpdate: '2026-03-18T08:00:00Z',
    sendTime: '2026-03-18T08:00:00Z',
    folder: 1,
    isNew: true,
    isDeleted: false,
    sendOnBehalf: false,
    sendViaEmail: false,
    sendViaSms: false,
    preventReply: false,
    sentViaEmail: false,
    sentViaSms: false,
    ...overrides,
  };
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  const { messages: overrideMessages, ...restOverrides } = overrides;
  const conversationId = (restOverrides.conversationId as string | undefined) ?? 'conv-1';
  const messageOverrides = (overrideMessages as Array<Record<string, unknown>> | undefined) ?? [{}];
  const messages = messageOverrides.map((messageOverride, index) =>
    makeMessage({
      messageId: `msg-${index + 1}`,
      conversationId,
      ...messageOverride,
    }),
  );

  return {
    conversationId,
    subject: 'Subject',
    sendTime: '2026-03-18T08:00:00Z',
    isNew: true,
    hasDrafts: false,
    hasAttachments: false,
    preventReply: false,
    labels: [],
    messages,
    ...restOverrides,
  };
}

/**
 * Every fetch is per-connection, so the suite always has one. There is no
 * shared-session path left to fall back to.
 */
/** The credential positional args `getForConnection` takes after the URL. */
const CONN_ARGS = ['conn-default', 540175, 2026, 'parent', 'decrypted-password'] as const;

const DEFAULT_CONN = {
  id: 'conn-default',
  schoolCode: 540175,
  schoolYear: 2026,
  username: 'parent',
  encryptedPassword: 'enc',
};

describe('MailInboxTask', () => {
  let task: MailInboxTask;
  let mockMashovClient: jest.Mocked<Pick<MashovHttpClient, 'getForConnection'>>;
  let mockPrisma: jest.Mocked<Pick<PrismaService, 'householdConnection' | 'mailConversation' | 'mailMessage'>>;
  let mockSyncRunService: jest.Mocked<Pick<SyncRunService, 'openRun' | 'closeRun' | 'closeItemRun'>>;
  let mockEncryptionService: jest.Mocked<Pick<EncryptionService, 'decrypt'>>;

  beforeEach(() => {
    mockMashovClient = {
      getForConnection: jest.fn(),
    };
    mockPrisma = {
      householdConnection: {
        findMany: jest.fn().mockResolvedValue([DEFAULT_CONN]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue({ id: 'household-1' }),
      } as unknown as PrismaService['householdConnection'],
      mailConversation: {
        upsert: jest.fn().mockResolvedValue({ id: 'conv-row-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      } as unknown as PrismaService['mailConversation'],
      mailMessage: {
        upsert: jest.fn().mockResolvedValue({ id: 'msg-row-1' }),
      } as unknown as PrismaService['mailMessage'],
    } as unknown as jest.Mocked<Pick<PrismaService, 'householdConnection' | 'mailConversation' | 'mailMessage'>>;
    mockSyncRunService = {
      openRun: jest.fn().mockResolvedValue(makeSyncRun('run-1')),
      closeRun: jest.fn().mockResolvedValue(makeSyncRun('run-1')),
      closeItemRun: jest.fn().mockResolvedValue(makeSyncRun('run-1')),
    };
    mockEncryptionService = {
      decrypt: jest.fn().mockReturnValue('decrypted-password'),
    };

    task = new MailInboxTask(
      mockMashovClient as unknown as MashovHttpClient,
      mockPrisma as unknown as PrismaService,
      mockSyncRunService as unknown as SyncRunService,
      mockEncryptionService as unknown as EncryptionService,
    );
  });

  it('syncs archive conversations after inbox and forces archived/read fields', async () => {
    const inboxConversation = makeConversation({
      conversationId: 'conv-inbox-1',
      isNew: true,
      labels: [],
      messages: [{ messageId: 'msg-inbox-1', isNew: true }],
    });
    const archivedConversation = makeConversation({
      conversationId: 'conv-archived-1',
      isNew: true,
      labels: [],
      messages: [{ messageId: 'msg-archived-1', isNew: true }],
    });
    (mockMashovClient.getForConnection as jest.Mock)
      .mockResolvedValueOnce([inboxConversation])
      .mockResolvedValueOnce([archivedConversation]);

    const result = await task.execute();

    expect(mockMashovClient.getForConnection).toHaveBeenNthCalledWith(
      1,
      '/api/mail/inbox/conversations?skip=0&take=50',
      DEFAULT_CONN.id,
      DEFAULT_CONN.schoolCode,
      DEFAULT_CONN.schoolYear,
      DEFAULT_CONN.username,
      'decrypted-password',
      {
        headers: {
          Referer: 'https://web.mashov.info/students/main/mailbox/folder/inbox',
        },
      },
    );
    expect(mockMashovClient.getForConnection).toHaveBeenNthCalledWith(
      2,
      '/api/mail/archive/conversations?skip=0&take=50',
      DEFAULT_CONN.id,
      DEFAULT_CONN.schoolCode,
      DEFAULT_CONN.schoolYear,
      DEFAULT_CONN.username,
      'decrypted-password',
      {
        headers: {
          Referer: 'https://web.mashov.info/students/main/mailbox/folder/archive',
        },
      },
    );
    expect(mockPrisma.mailConversation.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { conversationId: 'conv-archived-1' },
        create: expect.objectContaining({
          isUnread: false,
          labels: ['archived'],
        }),
        update: expect.objectContaining({
          isUnread: false,
          labels: ['archived'],
        }),
      }),
    );
    expect(mockPrisma.mailMessage.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { messageId: 'msg-archived-1' },
        create: expect.objectContaining({ isNew: false }),
        update: expect.objectContaining({ isNew: false }),
      }),
    );
    expect(mockSyncRunService.closeItemRun).toHaveBeenCalledWith('run-1', {
      fetchedCount: 2,
      updatedCount: 2,
      itemFailures: 0,
      itemErrors: [],
    });
    expect(result).toEqual({
      status: 'success',
      summary: {
        fetchedCount: 2,
        createdCount: 0,
        updatedCount: 2,
        failedCount: 0,
      },
      errorMessages: [],
    });
  });

  it('paginates archive endpoint and continues with skip=50 when first page is full', async () => {
    const firstArchivePage = Array.from({ length: 50 }, (_, index) => makeConversation({
      conversationId: `conv-archived-${index}`,
      messages: [{ messageId: `msg-archived-${index}` }],
    }));
    (mockMashovClient.getForConnection as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(firstArchivePage)
      .mockResolvedValueOnce([]);

    const result = await task.execute();

    expect(mockMashovClient.getForConnection).toHaveBeenNthCalledWith(
      1,
      '/api/mail/inbox/conversations?skip=0&take=50',
      ...CONN_ARGS,
      expect.any(Object),
    );
    expect(mockMashovClient.getForConnection).toHaveBeenNthCalledWith(
      2,
      '/api/mail/archive/conversations?skip=0&take=50',
      ...CONN_ARGS,
      expect.any(Object),
    );
    expect(mockMashovClient.getForConnection).toHaveBeenNthCalledWith(
      3,
      '/api/mail/archive/conversations?skip=50&take=50',
      ...CONN_ARGS,
      expect.any(Object),
    );
    expect(mockPrisma.mailConversation.upsert).toHaveBeenCalledTimes(50);
    expect(mockPrisma.mailMessage.upsert).toHaveBeenCalledTimes(50);
    expect(result.summary).toEqual({
      fetchedCount: 50,
      createdCount: 0,
      updatedCount: 50,
      failedCount: 0,
    });
  });
  describe('unread derivation', () => {
    function expectUpsertedIsUnread(value: boolean) {
      expect(mockPrisma.mailConversation.upsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { conversationId: 'conv-1' },
          create: expect.objectContaining({ isUnread: value }),
          update: expect.objectContaining({ isUnread: value }),
        }),
      );
    }

    it('stores the conversation flag even though the list payload reports every message read', async () => {
      // Measured against production: all 39 locally-unread conversations came back with
      // every message isNew=false, including the 16 Mashov counts as unread. Deriving
      // from messages[].isNew here would set the badge to 0.
      (mockMashovClient.getForConnection as jest.Mock)
        .mockResolvedValueOnce([makeConversation({ isNew: true, messages: [{ isNew: false }] })])
        .mockResolvedValueOnce([]);

      await task.execute();

      expectUpsertedIsUnread(true);
    });

    it('stores read when the conversation flag is clear, whatever the messages say', async () => {
      (mockMashovClient.getForConnection as jest.Mock)
        .mockResolvedValueOnce([
          makeConversation({ isNew: false, messages: [{ isNew: true }] }),
        ])
        .mockResolvedValueOnce([]);

      await task.execute();

      expectUpsertedIsUnread(false);
    });

    it('trusts the conversation flag when messages is empty', async () => {
      (mockMashovClient.getForConnection as jest.Mock)
        .mockResolvedValueOnce([makeConversation({ isNew: true, messages: [] })])
        .mockResolvedValueOnce([]);

      await task.execute();

      expectUpsertedIsUnread(true);
    });

    it('respects a local read override', async () => {
      (mockPrisma.mailConversation.findMany as jest.Mock).mockResolvedValueOnce([
        { conversationId: 'conv-1', locallyReadThroughAt: new Date('2026-03-18T08:00:00Z') },
      ]);
      (mockMashovClient.getForConnection as jest.Mock)
        .mockResolvedValueOnce([
          makeConversation({ isNew: true, messages: [{ isNew: true, sendTime: '2026-03-18T08:00:00Z' }] }),
        ])
        .mockResolvedValueOnce([]);

      await task.execute();

      expect(mockPrisma.mailConversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversationId: { in: ['conv-1'] } },
          select: { conversationId: true, locallyReadThroughAt: true },
        }),
      );
      expectUpsertedIsUnread(false);
    });

    it('re-opens when a message arrives after the override', async () => {
      (mockPrisma.mailConversation.findMany as jest.Mock).mockResolvedValueOnce([
        { conversationId: 'conv-1', locallyReadThroughAt: new Date('2026-03-18T08:00:00Z') },
      ]);
      (mockMashovClient.getForConnection as jest.Mock)
        .mockResolvedValueOnce([
          makeConversation({ isNew: true, messages: [{ isNew: true, sendTime: '2026-03-18T09:00:00Z' }] }),
        ])
        .mockResolvedValueOnce([]);

      await task.execute();

      expectUpsertedIsUnread(true);
    });
  });
  describe('reconciliation sweep', () => {
    const RUN_STARTED_AT = new Date('2026-03-18T00:00:00Z');

    it('clears unread on conversations upstream no longer returns', async () => {
      (mockMashovClient.getForConnection as jest.Mock)
        .mockResolvedValueOnce([makeConversation()])
        .mockResolvedValueOnce([]);

      await task.execute();

      expect(mockPrisma.mailConversation.updateMany).toHaveBeenCalledWith({
        where: {
          // Scoped to exactly the rows THIS walk could have refreshed -- not
          // "everything". This household has one connection, so that set also
          // includes the retired shared session's unowned rows: on a
          // one-connection deployment they can only have been this mailbox's,
          // and no other walk will ever sweep them.
          OR: [
            { householdConnectionId: DEFAULT_CONN.id },
            { householdConnectionId: null },
          ],
          isUnread: true,
          lastFetchedAt: { lt: RUN_STARTED_AT },
          // An orphan the user explicitly marked unread is their decision, not drift.
          locallyMarkedUnreadAt: null,
        },
        data: { isUnread: false },
      });
    });

    it('skips the sweep when the inbox walk returned nothing at all', async () => {
      // A 2xx with an empty array is not evidence that the mailbox is empty -- it is
      // also what a soft-failing referer-gated endpoint or a school year with no mail
      // looks like. Sweeping on it would clear isUnread across the whole table.
      (mockMashovClient.getForConnection as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeConversation({ conversationId: 'conv-archived-1' })])
        .mockResolvedValueOnce([]);

      await task.execute();

      expect(mockPrisma.mailConversation.updateMany).not.toHaveBeenCalled();
    });

    it('skips the sweep when an item failed to upsert', async () => {
      (mockPrisma.mailConversation.upsert as jest.Mock).mockRejectedValueOnce(
        new Error('upsert boom'),
      );
      (mockMashovClient.getForConnection as jest.Mock)
        .mockResolvedValueOnce([makeConversation()])
        .mockResolvedValueOnce([]);

      await task.execute();

      expect(mockPrisma.mailConversation.updateMany).not.toHaveBeenCalled();
    });

    describe('per connection', () => {
      const CONN_A = {
        id: 'conn-a',
        schoolCode: 540175,
        schoolYear: 2026,
        username: 'a',
        encryptedPassword: 'x',
      };
      const CONN_B = {
        id: 'conn-b',
        schoolCode: 999999,
        schoolYear: 2027,
        username: 'b',
        encryptedPassword: 'y',
      };

      /** Every mail row is stamped, so the transitional gate is satisfied. */
      function allRowsStamped() {
        (mockPrisma.mailConversation.count as jest.Mock).mockImplementation(({ where }) =>
          Promise.resolve(where?.householdConnectionId === null ? 0 : 1),
        );
      }

      it('sweeps per connection, touching only that connection\'s rows', async () => {
        // This is what the old "N active connections share one unscoped mail
        // table" gate existed to prevent, and what the ownership column makes
        // safe: the two row sets are disjoint, so `lastFetchedAt <
        // runStartedAt` is a sound orphan test within each one.
        (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([
          CONN_A,
          CONN_B,
        ]);
        allRowsStamped();
        (mockMashovClient.getForConnection as jest.Mock)
          .mockResolvedValueOnce([makeConversation()])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([makeConversation({ conversationId: 'conv-b' })])
          .mockResolvedValueOnce([]);

        await task.execute();

        const sweeps = (mockPrisma.mailConversation.updateMany as jest.Mock).mock.calls.map(
          (call) => call[0].where.householdConnectionId,
        );
        expect(sweeps).toEqual(['conn-a', 'conn-b']);
      });

      it('sweeps on a targeted run', async () => {
        // "refresh now" always targets the caller's connection, so every
        // user-triggered run is targeted. Refusing those meant pressing
        // refresh never corrected the count.
        (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([CONN_A]);
        allRowsStamped();
        (mockMashovClient.getForConnection as jest.Mock)
          .mockResolvedValueOnce([makeConversation()])
          .mockResolvedValueOnce([]);

        await task.execute({ connectionId: 'conn-a' });

        expect(mockPrisma.mailConversation.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ householdConnectionId: 'conn-a' }),
          }),
        );
      });

      it('still sweeps its own rows while unattributed rows exist', async () => {
        // An earlier version refused here, reasoning the condition would clear
        // itself because both walk loops re-stamp on update. That is only true
        // for rows upstream still returns -- and the rows this sweep exists for
        // are the ones upstream has STOPPED returning, which no walk can ever
        // re-stamp. One such orphan would have disabled reconciliation for
        // every connection permanently, bringing back the inflated badge.
        //
        // Refusing was never necessary: the sweep's `where` is scoped to this
        // connection, which is the protection. With CONN_A the household's ONLY
        // connection, the scope also adopts unowned rows -- they can only have
        // been this mailbox's, and nothing else will ever sweep them.
        (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([CONN_A]);
        (mockPrisma.mailConversation.count as jest.Mock).mockImplementation(({ where }) =>
          Promise.resolve(where?.householdConnectionId === null ? 5 : 0),
        );
        (mockMashovClient.getForConnection as jest.Mock)
          .mockResolvedValueOnce([makeConversation()])
          .mockResolvedValueOnce([]);

        await task.execute();

        expect(mockPrisma.mailConversation.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              OR: [{ householdConnectionId: 'conn-a' }, { householdConnectionId: null }],
            }),
          }),
        );
      });

      it('does not adopt unowned rows when the household has two connections', async () => {
        // Which connection owned them is genuinely unknowable, and both walks
        // would race to claim them. Left alone; `unreadBadge` still counts
        // them and a data migration owns the cleanup.
        (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([
          CONN_A,
          CONN_B,
        ]);
        (mockMashovClient.getForConnection as jest.Mock)
          .mockResolvedValue([])
          .mockResolvedValueOnce([makeConversation()])
          .mockResolvedValueOnce([]);

        await task.execute();

        for (const call of (mockPrisma.mailConversation.updateMany as jest.Mock).mock.calls) {
          expect(call[0].where).not.toHaveProperty('OR');
          expect(call[0].where.householdConnectionId).not.toBeNull();
        }
      });

      it('never blanks an existing stamp on a shared-session walk', async () => {
        // persistRoster is careful about this and mail was not: writing
        // `householdConnectionId: null` in an update branch un-owns a row a
        // per-connection walk had already attributed, which is one way to
        // manufacture unattributed orphans in the first place.
        (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.mailConversation.count as jest.Mock).mockResolvedValue(0);
        (mockMashovClient.getForConnection as jest.Mock)
          .mockResolvedValueOnce([makeConversation()])
          .mockResolvedValueOnce([]);

        await task.execute();

        for (const call of (mockPrisma.mailConversation.upsert as jest.Mock).mock.calls) {
          expect(call[0].update).not.toHaveProperty('householdConnectionId');
        }
        for (const call of (mockPrisma.mailMessage.upsert as jest.Mock).mock.calls) {
          expect(call[0].update).not.toHaveProperty('householdConnectionId');
        }
      });

      it('skips a shared-session run when stamped rows exist', async () => {
        // A per-connection walk is also running, and this run has no idea what
        // that walk refreshed -- its own orphan test would be answering about
        // somebody else's mailbox.
        (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.mailConversation.count as jest.Mock).mockImplementation(({ where }) =>
          Promise.resolve(where?.householdConnectionId?.not === null ? 3 : 0),
        );
        (mockMashovClient.getForConnection as jest.Mock)
          .mockResolvedValueOnce([makeConversation()])
          .mockResolvedValueOnce([]);

        await task.execute();

        expect(mockPrisma.mailConversation.updateMany).not.toHaveBeenCalled();
      });

      it('stamps every conversation and message it writes, on create and on update', async () => {
        // The update branch is what makes the system self-heal if the backfill
        // never ran -- without it the transitional gate above would never clear.
        (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([CONN_A]);
        allRowsStamped();
        (mockMashovClient.getForConnection as jest.Mock)
          .mockResolvedValueOnce([makeConversation()])
          .mockResolvedValueOnce([]);

        await task.execute({ connectionId: 'conn-a' });

        for (const call of (mockPrisma.mailConversation.upsert as jest.Mock).mock.calls) {
          expect(call[0].create.householdConnectionId).toBe('conn-a');
          expect(call[0].update.householdConnectionId).toBe('conn-a');
        }
        for (const call of (mockPrisma.mailMessage.upsert as jest.Mock).mock.calls) {
          expect(call[0].create.householdConnectionId).toBe('conn-a');
          expect(call[0].update.householdConnectionId).toBe('conn-a');
        }
      });

      it('writes each connection its own cachedNewCount', async () => {
        (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([
          CONN_A,
          CONN_B,
        ]);
        (mockPrisma.mailConversation.count as jest.Mock).mockImplementation(({ where }) => {
          if (where?.householdConnectionId === null) return Promise.resolve(0);
          if (where?.isUnread !== true) return Promise.resolve(1);
          return Promise.resolve(where.householdConnectionId === 'conn-a' ? 16 : 7);
        });
        (mockMashovClient.getForConnection as jest.Mock)
          .mockResolvedValueOnce([makeConversation()])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([makeConversation({ conversationId: 'conv-b' })])
          .mockResolvedValueOnce([]);

        await task.execute();

        const written = (mockPrisma.householdConnection.update as jest.Mock).mock.calls.map(
          (call) => ({ id: call[0].where.id, count: call[0].data.cachedNewCount }),
        );
        expect(written).toEqual([
          { id: 'conn-a', count: 16 },
          { id: 'conn-b', count: 7 },
        ]);
      });

      it('skips the sweep entirely when MAIL_SWEEP_ENABLED is false', async () => {
        // The kill switch: a bad badge is one environment variable away from
        // frozen rather than a rollback.
        const previous = process.env.MAIL_SWEEP_ENABLED;
        process.env.MAIL_SWEEP_ENABLED = 'false';
        try {
          (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([CONN_A]);
          allRowsStamped();
          (mockMashovClient.getForConnection as jest.Mock)
            .mockResolvedValueOnce([makeConversation()])
            .mockResolvedValueOnce([]);

          await task.execute();

          expect(mockPrisma.mailConversation.updateMany).not.toHaveBeenCalled();
        } finally {
          if (previous === undefined) delete process.env.MAIL_SWEEP_ENABLED;
          else process.env.MAIL_SWEEP_ENABLED = previous;
        }
      });

      it('still sweeps when MAIL_SWEEP_ENABLED is unset', async () => {
        // Default-on: reconciliation is what keeps the badge honest, so the
        // switch is an escape hatch, not an opt-in.
        const previous = process.env.MAIL_SWEEP_ENABLED;
        delete process.env.MAIL_SWEEP_ENABLED;
        try {
          (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([CONN_A]);
          allRowsStamped();
          (mockMashovClient.getForConnection as jest.Mock)
            .mockResolvedValueOnce([makeConversation()])
            .mockResolvedValueOnce([]);

          await task.execute();

          expect(mockPrisma.mailConversation.updateMany).toHaveBeenCalled();
        } finally {
          if (previous !== undefined) process.env.MAIL_SWEEP_ENABLED = previous;
        }
      });
    });

    it('writes cachedNewCount only to the connection the walk belongs to', async () => {
      // R15. The walk's own `cachedNewCount` refresh exists so the badge does
      // not lag the rows it just corrected -- a per-connection statement. The
      // retired shared session had no connection row, so its NULL-stamped
      // count went to `findFirst({ active: true })`: one household's number on
      // another's row. Every walk now owns a connection, so the write is
      // always to that one, and never to a household it did not sync.
      (mockPrisma.mailConversation.count as jest.Mock).mockResolvedValue(16);
      (mockMashovClient.getForConnection as jest.Mock)
        .mockResolvedValueOnce([makeConversation()])
        .mockResolvedValueOnce([]);

      await task.execute();

      expect(mockPrisma.householdConnection.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.householdConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: DEFAULT_CONN.id } }),
      );
    });
  });
  describe('a targeted refresh of a connection that is not usable', () => {
  /**
   * R11: a targeted refresh of a connection that cannot be used.
   *
   * `useSharedSession` is false once `context.connectionId` is set, but the
   * target list is then `[]` if that connection is inactive or has
   * `userId: null`. The loop body never ran, so the task returned
   * `status: 'success'` with every count zero and left no `sync_run` -- a
   * silent success that made a real failure undiagnosable.
   */
  beforeEach(() => {
      (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('reports the run as failed rather than a clean sync', async () => {
      const result = await task.execute({ connectionId: 'conn-gone' });

      expect(result.status).toBe('failed');
      expect(result.summary.failedCount).toBe(1);
    });

    it('opens exactly one run and closes it failed, with the reason', async () => {
      await task.execute({ connectionId: 'conn-gone' });

      expect(mockSyncRunService.openRun).toHaveBeenCalledTimes(1);
      expect(mockSyncRunService.openRun).toHaveBeenCalledWith(expect.any(String), 'conn-gone');
      expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ errorMessage: expect.stringContaining('conn-gone') }),
      );
    });

    it('never reaches upstream', async () => {
      await task.execute({ connectionId: 'conn-gone' });

      expect(mockMashovClient.getForConnection).not.toHaveBeenCalled();
      expect(mockMashovClient.getForConnection).not.toHaveBeenCalled();
    });
  });

});
