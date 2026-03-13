import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MashovHttpClient } from '../session/mashov-http.client';
import { MailService } from './mail.service';

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

function makeMockPrisma(overrides: Partial<Record<string, jest.Mock>>) {
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
    readState: {
      findMany: overrides.readStateFindMany ?? jest.fn().mockResolvedValue([]),
      findUnique: overrides.readStateFindUnique ?? jest.fn().mockResolvedValue(null),
    },
    syncRun: {
      findFirst: overrides.syncRunFindFirst ?? jest.fn().mockResolvedValue(null),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeMockMashovClient(overrides: Partial<Record<string, jest.Mock>>) {
  return {
    get: overrides.get ?? jest.fn().mockResolvedValue({}),
    put: overrides.put ?? jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<MashovHttpClient>;
}

describe('MailService', () => {
  describe('getSummary', () => {
    it('returns unread count, recent conversations and lastSyncAt', async () => {
      const service = new MailService(
        makeMockPrisma({
          conversationCount: jest.fn().mockResolvedValue(2),
          conversationFindMany: jest.fn().mockResolvedValue([
            makeConversation({ isUnread: true }),
          ]),
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getSummary();
      expect(result.unreadConversations).toBe(2);
      expect(result.recentConversations[0].conversationId).toBe('conv-upstream-1');
      expect(result.lastSyncAt).toBe(NOW.toISOString());
    });
  });

  describe('getConversations', () => {
    it('returns paginated list with isHandled from read_state', async () => {
      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: jest.fn().mockResolvedValue([
            makeConversation({ conversationId: 'conv-1' }),
          ]),
          conversationCount: jest.fn().mockResolvedValue(1),
          readStateFindMany: jest.fn().mockResolvedValue([
            { itemId: 'conv-1', isHandled: true },
          ]),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getConversations(1, 20, false);
      expect(result.pagination).toMatchObject({ page: 1, total: 1, totalPages: 1 });
      expect(result.data[0]).toMatchObject({
        conversationId: 'conv-1',
        isHandled: true,
      });
    });
  });

  describe('getConversationDetail', () => {
    it('throws NotFoundException when conversation does not exist', async () => {
      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(null),
        }),
        makeMockMashovClient({}),
      );

      await expect(service.getConversationDetail('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns flattened contract shape', async () => {
      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(
            makeConversation({ conversationId: 'conv-1' }),
          ),
          messageFindMany: jest.fn().mockResolvedValue([
            {
              messageId: 'msg-1',
              conversationId: 'conv-1',
              senderId: 'sender-1',
              senderName: 'Teacher',
              subject: 'Hello',
              bodyHtmlSanitized: '<p>Body</p>',
              bodyTextPreview: 'Body',
              sendTime: NOW,
              isUnread: false,
              recipients: [],
              preventReply: false,
              sentViaEmail: false,
              sentViaSms: false,
            },
          ]),
          readStateFindUnique: jest.fn().mockResolvedValue({ isHandled: true }),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getConversationDetail('conv-1');
      expect(result).toMatchObject({
        conversationId: 'conv-1',
        isHandled: true,
      });
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.messages[0].messageId).toBe('msg-1');
    });

    it('falls back to DB metadata when upstream lazy fetch fails', async () => {
      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(makeConversation()),
          messageFindMany: jest
            .fn()
            .mockResolvedValueOnce([
              {
                messageId: 'msg-1',
                conversationId: 'conv-upstream-1',
                senderId: 'sender-1',
                senderName: 'Teacher',
                subject: 'Hello',
                bodyHtmlSanitized: null,
                bodyTextPreview: null,
                sendTime: NOW,
                isUnread: false,
                recipients: [],
                preventReply: false,
                sentViaEmail: false,
                sentViaSms: false,
              },
            ])
            .mockResolvedValueOnce([
              {
                messageId: 'msg-1',
                conversationId: 'conv-upstream-1',
                senderId: 'sender-1',
                senderName: 'Teacher',
                subject: 'Hello',
                bodyHtmlSanitized: null,
                bodyTextPreview: null,
                sendTime: NOW,
                isUnread: false,
                recipients: [],
                preventReply: false,
                sentViaEmail: false,
                sentViaSms: false,
              },
            ]),
        }),
        makeMockMashovClient({
          get: jest.fn().mockRejectedValue(new Error('network error')),
        }),
      );

      const result = await service.getConversationDetail('conv-upstream-1');
      expect(result.messages).toHaveLength(1);
    });
  });

  describe('mail actions', () => {
    it('markUnread updates DB and returns updated count', async () => {
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany: jest.fn().mockResolvedValue({ count: 2 }),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.markUnread(['conv-1', 'conv-2']);
      expect(result.updated).toBe(2);
    });

    it('archive adds archived label and returns updated count', async () => {
      const mockUpdate = jest.fn().mockResolvedValue(makeConversation());
      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: jest.fn().mockResolvedValue([
            { id: 'conv-id-1', labels: [] },
          ]),
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
  });
});
