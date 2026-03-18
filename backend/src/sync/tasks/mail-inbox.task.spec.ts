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
  const message = makeMessage({
    conversationId,
    ...((overrideMessages as Array<Record<string, unknown>> | undefined)?.[0] ?? {}),
  });

  return {
    conversationId,
    subject: 'Subject',
    sendTime: '2026-03-18T08:00:00Z',
    isNew: true,
    hasDrafts: false,
    hasAttachments: false,
    preventReply: false,
    labels: [],
    messages: [message],
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
      } as unknown as PrismaService['householdConnection'],
      mailConversation: {
        upsert: jest.fn().mockResolvedValue({ id: 'conv-row-1' }),
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
});
