import { Logger } from '@nestjs/common';
import { SyncRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { MailCountsTask } from './mail-counts.task';

function makeSyncRun(id: string): SyncRun {
  return {
    id,
    source: MailCountsTask.SOURCE,
    status: 'running',
    startedAt: new Date('2026-03-18T00:05:00Z'),
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

interface CountArgs {
  where?: {
    isUnread?: boolean;
    labels?: unknown;
    lastFetchedAt?: unknown;
    locallyReadThroughAt?: unknown;
  };
}

/**
 * Every fetch is per-connection, so the suite always has one. There is no
 * shared-session path left to fall back to.
 */
const DEFAULT_CONN = {
  id: 'conn-default',
  schoolCode: 540175,
  schoolYear: 2026,
  username: 'parent',
  encryptedPassword: 'enc',
};

describe('MailCountsTask', () => {
  let task: MailCountsTask;
  let mockMashovClient: jest.Mocked<Pick<MashovHttpClient, 'getForConnection'>>;
  let mockPrisma: jest.Mocked<PrismaService>;
  let mockSyncRunService: jest.Mocked<Pick<SyncRunService, 'openRun' | 'closeRun'>>;
  let conversationCount: jest.Mock;
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  // One count() mock routed by predicate shape, so the task is free to reorder or
  // parallelise its queries without the test caring.
  const counts = {
    localUnread: 39,
    archived: 4,
    orphans: 23,
    locallyOverridden: 2,
  };

  beforeEach(() => {
    conversationCount = jest.fn().mockImplementation((args: CountArgs) => {
      const where = args?.where ?? {};
      if (where.locallyReadThroughAt !== undefined) return Promise.resolve(counts.locallyOverridden);
      if (where.lastFetchedAt !== undefined) return Promise.resolve(counts.orphans);
      if (where.isUnread === undefined) return Promise.resolve(counts.archived);
      return Promise.resolve(counts.localUnread);
    });

    mockMashovClient = { getForConnection: jest.fn() };
    mockPrisma = {
      householdConnection: {
        findMany: jest.fn().mockResolvedValue([DEFAULT_CONN]),
        findFirst: jest.fn().mockResolvedValue({ id: 'household-1' }),
        update: jest.fn().mockResolvedValue({ id: 'household-1' }),
      },
      mailConversation: { count: conversationCount },
      syncRun: {
        findFirst: jest.fn().mockResolvedValue({ startedAt: new Date('2026-03-18T00:00:00Z') }),
      },
    } as unknown as jest.Mocked<PrismaService>;
    mockSyncRunService = {
      openRun: jest.fn().mockResolvedValue(makeSyncRun('run-1')),
      closeRun: jest.fn().mockResolvedValue(makeSyncRun('run-1')),
    };

    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    task = new MailCountsTask(
      mockMashovClient as unknown as MashovHttpClient,
      mockPrisma as unknown as PrismaService,
      mockSyncRunService as unknown as SyncRunService,
      { decrypt: jest.fn() } as unknown as EncryptionService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('per-connection local count', () => {
    const CONN_A = {
      id: 'conn-a',
      schoolCode: 540175,
      schoolYear: 2026,
      username: 'parent-a',
      encryptedPassword: 'enc',
    };
    const CONN_B = {
      id: 'conn-b',
      schoolCode: 999999,
      schoolYear: 2027,
      username: 'parent-b',
      encryptedPassword: 'enc',
    };

    it("counts only the connection's own mailbox", async () => {
      // Unscoped, every connection wrote the UNION of both mailboxes into its
      // own cachedNewCount -- and the badge sums those rows, so two schools
      // reported the union twice. This is the double-count at its source.
      (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([CONN_A]);
      (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({
        unreadConversations: 39,
      });

      await task.execute();

      const localCountCall = conversationCount.mock.calls.find(
        (call) => (call[0] as CountArgs)?.where?.isUnread === true,
      );
      expect(localCountCall?.[0]?.where).toMatchObject({
        householdConnectionId: 'conn-a',
        isUnread: true,
      });
    });

    it('counts each connection separately so the two drift independently', async () => {
      (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([
        CONN_A,
        CONN_B,
      ]);
      (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({
        unreadConversations: 39,
      });

      await task.execute();

      const scopes = conversationCount.mock.calls
        .map((call) => (call[0] as CountArgs)?.where)
        .filter((where) => where?.isUnread === true)
        .map((where) => (where as Record<string, unknown>).householdConnectionId);
      expect(scopes).toEqual(['conn-a', 'conn-b']);
    });

    it('never scopes the local count to NULL now that the shared session is gone', async () => {
      // NULL used to select the shared session's unowned rows. Legacy
      // NULL-stamped rows still exist and `unreadBadge` still adds them, but
      // no sync run may claim them: that would double-count them.
      (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({
        unreadConversations: 39,
      });

      await task.execute();

      const localCountCall = conversationCount.mock.calls.find(
        (call) => (call[0] as CountArgs)?.where?.isUnread === true,
      );
      expect(localCountCall?.[0]?.where).toMatchObject({
        householdConnectionId: DEFAULT_CONN.id,
      });
    });
  });

  it('persists both counts on the sync run so drift is queryable without container logs', async () => {
    (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

    await task.execute();

    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
      'run-1',
      'success',
      expect.objectContaining({ upstreamCount: 16, localCount: 39 }),
    );
  });

  it('does not close a drifting run as partial', async () => {
    (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

    await task.execute();

    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-1', 'success', expect.any(Object));
  });

  it('warns with a breakdown when upstream and local disagree', async () => {
    (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

    await task.execute();

    expect(debugSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain('upstream=16');
    expect(message).toContain('local=39');
    expect(message).toContain('archived=4');
    expect(message).toContain('orphans=23');
    expect(message).toContain('locallyOverridden=2');
  });

  it('stays at debug and skips the breakdown queries when the counts agree', async () => {
    (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({ unreadConversations: 39 });

    await task.execute();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0][0])).toContain('upstream=39 local=39');
    expect(conversationCount).toHaveBeenCalledTimes(1);
  });

  it('scopes the orphan reference run to the connection being reported on', async () => {
    // startsWith('mail_inbox') would pick up another connection's run -- and then every
    // row of this connection's mailbox reads as an orphan, because the union table's
    // rows were last refreshed by whichever walk ran most recently. A diagnostic that
    // lies on the multi-connection setup is worse than no diagnostic.
    (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

    await task.execute();

    expect(mockPrisma.syncRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source: `mail_inbox:${DEFAULT_CONN.id}`, status: 'success' },
      }),
    );
  });

  it('reports orphans as unknown when no successful inbox run is on record', async () => {
    (mockPrisma.syncRun.findFirst as jest.Mock).mockResolvedValue(null);
    (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

    await task.execute();

    expect(String(warnSpy.mock.calls[0][0])).toContain('orphans=unknown');
  });

  it('writes cachedNewCount only to the connection the run belongs to', async () => {
    // R15. The retired shared session had no connection row of its own, so its
    // count was written into `findFirst({ active: true })` -- an arbitrary
    // household, a cross-household write, and a double count besides.
    // Every run now owns a connection, so the write is always to that one.
    (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue({
      unreadConversations: 16,
    });

    await task.execute();

    expect(mockPrisma.householdConnection.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.householdConnection.update).toHaveBeenCalledWith({
      where: { id: DEFAULT_CONN.id },
      data: { cachedNewCount: 39 },
    });
    // The number is not lost: it is where an operator reads it from.
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
      'run-1',
      'success',
      expect.objectContaining({ localCount: 39, upstreamCount: 16 }),
    );
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
    });
  });

});
