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

describe('MailInboxTask', () => {
  let task: MailInboxTask;
  let mockMashovClient: jest.Mocked<Pick<MashovHttpClient, 'get' | 'getForConnection'>>;
  let mockPrisma: jest.Mocked<Pick<PrismaService, 'householdConnection' | 'mailConversation' | 'mailMessage'>>;
  let mockSyncRunService: jest.Mocked<Pick<SyncRunService, 'openRun' | 'closeRun'>>;
  let mockEncryptionService: jest.Mocked<Pick<EncryptionService, 'decrypt'>>;

  beforeEach(() => {
    mockMashovClient = {
      get: jest.fn(),
      getForConnection: jest.fn(),
    };
    mockPrisma = {
      householdConnection: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
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
    (mockMashovClient.get as jest.Mock)
      .mockResolvedValueOnce([inboxConversation])
      .mockResolvedValueOnce([archivedConversation]);

    const result = await task.execute();

    expect(mockMashovClient.get).toHaveBeenNthCalledWith(
      1,
      '/api/mail/inbox/conversations?skip=0&take=50',
      {
        headers: {
          Referer: 'https://web.mashov.info/students/main/mailbox/folder/inbox',
        },
      },
    );
    expect(mockMashovClient.get).toHaveBeenNthCalledWith(
      2,
      '/api/mail/archive/conversations?skip=0&take=50',
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
    expect(mockSyncRunService.closeRun).toHaveBeenCalledWith('run-1', 'success', {
      fetchedCount: 2,
      updatedCount: 2,
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
    (mockMashovClient.get as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(firstArchivePage)
      .mockResolvedValueOnce([]);

    const result = await task.execute();

    expect(mockMashovClient.get).toHaveBeenNthCalledWith(
      1,
      '/api/mail/inbox/conversations?skip=0&take=50',
      expect.any(Object),
    );
    expect(mockMashovClient.get).toHaveBeenNthCalledWith(
      2,
      '/api/mail/archive/conversations?skip=0&take=50',
      expect.any(Object),
    );
    expect(mockMashovClient.get).toHaveBeenNthCalledWith(
      3,
      '/api/mail/archive/conversations?skip=50&take=50',
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

    it('derives isUnread from messages when the conversation flag is stale', async () => {
      (mockMashovClient.get as jest.Mock)
        .mockResolvedValueOnce([makeConversation({ isNew: true, messages: [{ isNew: false }] })])
        .mockResolvedValueOnce([]);

      await task.execute();

      expectUpsertedIsUnread(false);
    });

    it('keeps isUnread true when any message is unread', async () => {
      (mockMashovClient.get as jest.Mock)
        .mockResolvedValueOnce([
          makeConversation({ isNew: false, messages: [{ isNew: false }, { isNew: true }] }),
        ])
        .mockResolvedValueOnce([]);

      await task.execute();

      expectUpsertedIsUnread(true);
    });

    it('treats a deleted unread message as read', async () => {
      (mockMashovClient.get as jest.Mock)
        .mockResolvedValueOnce([
          makeConversation({ isNew: true, messages: [{ isNew: true, isDeleted: true }] }),
        ])
        .mockResolvedValueOnce([]);

      await task.execute();

      expectUpsertedIsUnread(false);
    });

    it('falls back to the conversation flag when messages is empty', async () => {
      (mockMashovClient.get as jest.Mock)
        .mockResolvedValueOnce([makeConversation({ isNew: true, messages: [] })])
        .mockResolvedValueOnce([]);

      await task.execute();

      expectUpsertedIsUnread(true);
    });

    it('respects a local read override', async () => {
      (mockPrisma.mailConversation.findMany as jest.Mock).mockResolvedValueOnce([
        { conversationId: 'conv-1', locallyReadThroughAt: new Date('2026-03-18T08:00:00Z') },
      ]);
      (mockMashovClient.get as jest.Mock)
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
      (mockMashovClient.get as jest.Mock)
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
      (mockMashovClient.get as jest.Mock)
        .mockResolvedValueOnce([makeConversation()])
        .mockResolvedValueOnce([]);

      await task.execute();

      expect(mockPrisma.mailConversation.updateMany).toHaveBeenCalledWith({
        where: {
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
      (mockMashovClient.get as jest.Mock)
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
      (mockMashovClient.get as jest.Mock)
        .mockResolvedValueOnce([makeConversation()])
        .mockResolvedValueOnce([]);

      await task.execute();

      expect(mockPrisma.mailConversation.updateMany).not.toHaveBeenCalled();
    });

    it('skips the sweep when more than one connection is active', async () => {
      (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([
        { id: 'conn-1', schoolCode: 1, schoolYear: 2026, username: 'a', encryptedPassword: 'x' },
        { id: 'conn-2', schoolCode: 2, schoolYear: 2026, username: 'b', encryptedPassword: 'y' },
      ]);
      (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue([]);

      await task.execute();

      expect(mockPrisma.mailConversation.updateMany).not.toHaveBeenCalled();
    });

    it('skips the sweep on a run targeted at a single connection', async () => {
      (mockPrisma.householdConnection.findMany as jest.Mock).mockResolvedValue([
        { id: 'conn-1', schoolCode: 1, schoolYear: 2026, username: 'a', encryptedPassword: 'x' },
      ]);
      (mockMashovClient.getForConnection as jest.Mock).mockResolvedValue([]);

      await task.execute({ connectionId: 'conn-1' });

      expect(mockPrisma.mailConversation.updateMany).not.toHaveBeenCalled();
    });

    it('refreshes cachedNewCount so the badge and the list agree before the next counts tick', async () => {
      (mockPrisma.householdConnection.findFirst as jest.Mock).mockResolvedValue({
        id: 'household-1',
      });
      (mockPrisma.mailConversation.count as jest.Mock).mockResolvedValue(16);
      (mockMashovClient.get as jest.Mock)
        .mockResolvedValueOnce([makeConversation()])
        .mockResolvedValueOnce([]);

      await task.execute();

      expect(mockPrisma.householdConnection.update).toHaveBeenCalledWith({
        where: { id: 'household-1' },
        data: { cachedNewCount: 16 },
      });
    });
  });
});
