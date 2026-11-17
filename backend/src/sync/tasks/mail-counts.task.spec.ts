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

describe('MailCountsTask', () => {
  let task: MailCountsTask;
  let mockMashovClient: jest.Mocked<Pick<MashovHttpClient, 'get' | 'getForConnection'>>;
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

    mockMashovClient = { get: jest.fn(), getForConnection: jest.fn() };
    mockPrisma = {
      householdConnection: {
        findMany: jest.fn().mockResolvedValue([]),
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

  it('persists both counts on the sync run so drift is queryable without container logs', async () => {
    (mockMashovClient.get as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

    await task.execute();

    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith(
      'run-1',
      'success',
      expect.objectContaining({ upstreamCount: 16, localCount: 39 }),
    );
  });

  it('does not close a drifting run as partial', async () => {
    (mockMashovClient.get as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

    await task.execute();

    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-1', 'success', expect.any(Object));
  });

  it('warns with a breakdown when upstream and local disagree', async () => {
    (mockMashovClient.get as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

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
    (mockMashovClient.get as jest.Mock).mockResolvedValue({ unreadConversations: 39 });

    await task.execute();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0][0])).toContain('upstream=39 local=39');
    expect(conversationCount).toHaveBeenCalledTimes(1);
  });

  it('reports orphans as unknown when no successful inbox run is on record', async () => {
    (mockPrisma.syncRun.findFirst as jest.Mock).mockResolvedValue(null);
    (mockMashovClient.get as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

    await task.execute();

    expect(String(warnSpy.mock.calls[0][0])).toContain('orphans=unknown');
  });

  it('still writes cachedNewCount from the local count', async () => {
    (mockMashovClient.get as jest.Mock).mockResolvedValue({ unreadConversations: 16 });

    await task.execute();

    expect(mockPrisma.householdConnection.update).toHaveBeenCalledWith({
      where: { id: 'household-1' },
      data: { cachedNewCount: 39 },
    });
  });
});
