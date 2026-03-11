import { NotFoundException } from '@nestjs/common';
import { MailService } from './mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { MashovHttpClient } from '../session/mashov-http.client';

const NOW = new Date('2026-03-11T10:00:00Z');

function makeConversation(overrides?: object) {
  return {
    id: 'conv-id-1',
    conversationId: 'conv-upstream-1',
    subject: 'Parent meeting',
    senderNamePreview: 'Principal',
    sendTime: NOW,
    isUnread: false,
    hasDrafts: false,
    hasAttachments: false,
    preventReply: false,
    labels: [],
    rawPayload: {},
    lastFetchedAt: NOW,
    ...overrides,
  };
}

function makeMockPrisma(overrides: Partial<{
  conversationCount: jest.Mock;
  conversationFindMany: jest.Mock;
  conversationFindUnique: jest.Mock;
  conversationUpdateMany: jest.Mock;
  conversationUpdate: jest.Mock;
  messageFindMany: jest.Mock;
  messageUpsert: jest.Mock;
  syncRunFindFirst: jest.Mock;
}>): jest.Mocked<PrismaService> {
  return {
    mailConversation: {
      count: overrides.conversationCount ?? jest.fn().mockResolvedValue(0),
      findMany: overrides.conversationFindMany ?? jest.fn().mockResolvedValue([]),
      findUnique: overrides.conversationFindUnique ?? jest.fn().mockResolvedValue(null),
      updateMany: overrides.conversationUpdateMany ?? jest.fn().mockResolvedValue({ count: 0 }),
      update: overrides.conversationUpdate ?? jest.fn().mockResolvedValue(makeConversation()),
    },
    mailMessage: {
      findMany: overrides.messageFindMany ?? jest.fn().mockResolvedValue([]),
      upsert: overrides.messageUpsert ?? jest.fn().mockResolvedValue({}),
    },
    syncRun: {
      findFirst: overrides.syncRunFindFirst ?? jest.fn().mockResolvedValue(null),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeMockMashovClient(overrides: Partial<{
  get: jest.Mock;
  put: jest.Mock;
}>): jest.Mocked<MashovHttpClient> {
  return {
    get: overrides.get ?? jest.fn().mockResolvedValue({}),
    put: overrides.put ?? jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<MashovHttpClient>;
}

describe('MailService', () => {
  describe('getSummary', () => {
    it('returns summary with 0 unread and empty recentConversations when DB is empty', async () => {
      const service = new MailService(makeMockPrisma({}), makeMockMashovClient({}));
      const result = await service.getSummary();

      expect(result.unreadConversations).toBe(0);
      expect(result.recentConversations).toEqual([]);
      expect(result.lastSyncAt).toBeNull();
    });

    it('returns correct unread count and recent conversations', async () => {
      const conv = makeConversation({ isUnread: true });
      const service = new MailService(
        makeMockPrisma({
          conversationCount: jest.fn().mockResolvedValue(3),
          conversationFindMany: jest.fn().mockResolvedValue([conv]),
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getSummary();
      expect(result.unreadConversations).toBe(3);
      expect(result.recentConversations).toHaveLength(1);
      expect(result.recentConversations[0].conversationId).toBe('conv-upstream-1');
      expect(result.lastSyncAt).toBe(NOW.toISOString());
    });
  });

  describe('getConversations', () => {
    it('returns empty paginated result when no conversations exist', async () => {
      const service = new MailService(makeMockPrisma({}), makeMockMashovClient({}));
      const result = await service.getConversations(1, 20, false);

      expect(result.data).toEqual([]);
      expect(result.pagination).toMatchObject({ page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    it('filters by unreadOnly when flag is true', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([]);
      const mockCount = jest.fn().mockResolvedValue(0);
      const service = new MailService(
        makeMockPrisma({ conversationFindMany: mockFindMany, conversationCount: mockCount }),
        makeMockMashovClient({}),
      );

      await service.getConversations(1, 20, true);

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isUnread: true } }),
      );
    });

    it('does not filter when unreadOnly is false', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([]);
      const mockCount = jest.fn().mockResolvedValue(0);
      const service = new MailService(
        makeMockPrisma({ conversationFindMany: mockFindMany, conversationCount: mockCount }),
        makeMockMashovClient({}),
      );

      await service.getConversations(1, 20, false);

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  describe('getConversationDetail', () => {
    it('throws NotFoundException when conversation does not exist', async () => {
      const service = new MailService(
        makeMockPrisma({ conversationFindUnique: jest.fn().mockResolvedValue(null) }),
        makeMockMashovClient({}),
      );

      await expect(service.getConversationDetail('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('returns conversation with messages from DB when messages exist with body', async () => {
      const conv = makeConversation();
      const messages = [
        { id: 'msg-1', messageId: 'msg-upstream-1', conversationId: 'conv-upstream-1', bodyHtmlSanitized: '<p>Hello</p>' },
      ];

      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(conv),
          messageFindMany: jest.fn().mockResolvedValue(messages),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getConversationDetail('conv-upstream-1');
      expect(result.conversation.conversationId).toBe('conv-upstream-1');
      expect(result.messages).toHaveLength(1);
    });

    it('fetches from upstream when no messages with body exist in DB', async () => {
      const conv = makeConversation();
      const upstreamResponse = {
        conversationId: 'conv-upstream-1',
        subject: 'Parent meeting',
        messages: [
          {
            messageId: 'msg-up-1',
            conversationId: 'conv-upstream-1',
            senderId: 'sender-1',
            senderName: 'Teacher',
            subject: 'Parent meeting',
            body: '<p>Hello</p>',
            sendTime: '2026-03-11T10:00:00Z',
            isNew: false,
            recipients: [],
            files: [],
            preventReply: false,
            sentViaEmail: false,
            sentViaSms: false,
          },
        ],
      };

      const mockGet = jest.fn().mockResolvedValue(upstreamResponse);
      const mockUpsert = jest.fn().mockResolvedValue({ id: 'msg-local-1' });

      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(conv),
          messageFindMany: jest.fn().mockResolvedValue([]), // no messages in DB
          messageUpsert: mockUpsert,
        }),
        makeMockMashovClient({ get: mockGet }),
      );

      const result = await service.getConversationDetail('conv-upstream-1');
      expect(mockGet).toHaveBeenCalled();
      expect(result.messages).toBeDefined();
    });

    it('falls back to metadata-only messages when upstream fetch fails', async () => {
      const conv = makeConversation();
      const fallbackMessages = [
        { id: 'msg-1', messageId: 'msg-up-1', conversationId: 'conv-upstream-1', bodyHtmlSanitized: null },
      ];

      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(conv),
          messageFindMany: jest.fn()
            .mockResolvedValueOnce([]) // first call: no body messages
            .mockResolvedValueOnce(fallbackMessages), // second call: fallback
        }),
        makeMockMashovClient({ get: jest.fn().mockRejectedValue(new Error('network error')) }),
      );

      const result = await service.getConversationDetail('conv-upstream-1');
      expect(result.messages).toEqual(fallbackMessages);
    });
  });

  describe('markUnread', () => {
    it('updates conversations in DB and returns the count', async () => {
      const mockUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
      const service = new MailService(
        makeMockPrisma({ conversationUpdateMany: mockUpdateMany }),
        makeMockMashovClient({}),
      );

      const result = await service.markUnread(['conv-1', 'conv-2']);
      expect(result.updated).toBe(2);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversationId: { in: ['conv-1', 'conv-2'] } },
          data: { isUnread: true },
        }),
      );
    });

    it('continues and updates DB even when upstream markAsUnread call fails', async () => {
      const mockPut = jest.fn().mockRejectedValue(new Error('upstream unavailable'));
      const mockUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

      const service = new MailService(
        makeMockPrisma({ conversationUpdateMany: mockUpdateMany }),
        makeMockMashovClient({ put: mockPut }),
      );

      const result = await service.markUnread(['conv-1']);
      expect(result.updated).toBe(1);
      expect(mockUpdateMany).toHaveBeenCalled();
    });
  });

  describe('archive', () => {
    it('adds "archived" label to conversations and returns the count', async () => {
      const conv = makeConversation({ labels: [] });
      const mockFindMany = jest.fn().mockResolvedValue([{ id: conv.id, labels: [] }]);
      const mockUpdate = jest.fn().mockResolvedValue(conv);

      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: mockFindMany,
          conversationUpdate: mockUpdate,
        }),
        makeMockMashovClient({}),
      );

      const result = await service.archive(['conv-upstream-1']);
      expect(result.updated).toBe(1);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { labels: ['archived'] },
        }),
      );
    });

    it('does not duplicate the "archived" label if already present', async () => {
      const mockFindMany = jest.fn().mockResolvedValue([
        { id: 'conv-id-1', labels: ['archived'] },
      ]);
      const mockUpdate = jest.fn().mockResolvedValue(makeConversation());

      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: mockFindMany,
          conversationUpdate: mockUpdate,
        }),
        makeMockMashovClient({}),
      );

      await service.archive(['conv-upstream-1']);
      const callArgs = mockUpdate.mock.calls[0][0];
      const labels = callArgs.data.labels as string[];
      expect(labels.filter((l) => l === 'archived')).toHaveLength(1);
    });

    it('continues and updates DB even when upstream archive call fails', async () => {
      const mockPut = jest.fn().mockRejectedValue(new Error('upstream unavailable'));
      const mockFindMany = jest.fn().mockResolvedValue([{ id: 'conv-id-1', labels: [] }]);
      const mockUpdate = jest.fn().mockResolvedValue(makeConversation());

      const service = new MailService(
        makeMockPrisma({ conversationFindMany: mockFindMany, conversationUpdate: mockUpdate }),
        makeMockMashovClient({ put: mockPut }),
      );

      const result = await service.archive(['conv-upstream-1']);
      expect(result.updated).toBe(1);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });
});
