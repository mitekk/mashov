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
    householdConnection: {
      findFirst: overrides.householdFindFirst ?? jest.fn().mockResolvedValue(null),
    },
    mailConversation: {
      count: overrides.conversationCount ?? jest.fn().mockResolvedValue(0),
      findMany: overrides.conversationFindMany ?? jest.fn().mockResolvedValue([]),
      findUnique: overrides.conversationFindUnique ?? jest.fn().mockResolvedValue(null),
      updateMany: overrides.conversationUpdateMany ?? jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: overrides.conversationDeleteMany ?? jest.fn().mockResolvedValue({ count: 0 }),
      update: overrides.conversationUpdate ?? jest.fn().mockResolvedValue(makeConversation()),
    },
    mailMessage: {
      findMany: overrides.messageFindMany ?? jest.fn().mockResolvedValue([]),
      upsert: overrides.messageUpsert ?? jest.fn().mockResolvedValue({}),
      deleteMany: overrides.messageDeleteMany ?? jest.fn().mockResolvedValue({ count: 0 }),
    },
    readState: {
      findMany: overrides.readStateFindMany ?? jest.fn().mockResolvedValue([]),
      findUnique: overrides.readStateFindUnique ?? jest.fn().mockResolvedValue(null),
      deleteMany: overrides.readStateDeleteMany ?? jest.fn().mockResolvedValue({ count: 0 }),
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
    it('returns unread count from cached household count when available', async () => {
      const service = new MailService(
        makeMockPrisma({
          householdFindFirst: jest.fn().mockResolvedValue({ cachedUnreadCount: 68 }),
          conversationCount: jest.fn().mockResolvedValue(2),
          conversationFindMany: jest.fn().mockResolvedValue([
            makeConversation({ isUnread: true }),
          ]),
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getSummary();
      expect(result.unreadConversations).toBe(68);
      expect(result.recentConversations[0].conversationId).toBe('conv-upstream-1');
      expect(result.lastSyncAt).toBe(NOW.toISOString());
    });

    it('falls back to unread count from DB when household cache is missing', async () => {
      const service = new MailService(
        makeMockPrisma({
          householdFindFirst: jest.fn().mockResolvedValue(null),
          conversationCount: jest.fn().mockResolvedValue(4),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getSummary();
      expect(result.unreadConversations).toBe(4);
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
      expect(result.messages[0].hasAttachments).toBe(false);
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

    it('lazy fetches detail from upstream conversation endpoint when body is missing', async () => {
      const messageUpsert = jest.fn().mockResolvedValue({});
      const mashovGet = jest.fn().mockResolvedValue({
        conversationId: 'conv-upstream-1',
        subject: 'Updated Subject',
        sendTime: NOW.toISOString(),
        isNew: true,
        hasDrafts: false,
        hasAttachments: true,
        preventReply: false,
        labels: [],
        messages: [
          {
            messageId: 'msg-upstream-1',
            conversationId: 'conv-upstream-1',
            senderId: 'sender-1',
            senderName: 'Teacher',
            subject: 'Subject',
            body: '<p>unsafe<script>alert(1)</script>Body</p>',
            sendTime: NOW.toISOString(),
            isNew: true,
            recipients: [],
            files: [{ fileId: 'f-1' }],
            preventReply: false,
            sentViaEmail: false,
            sentViaSms: false,
          },
        ],
      });

      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(makeConversation()),
          conversationUpdate: jest.fn().mockResolvedValue(makeConversation()),
          messageFindMany: jest
            .fn()
            .mockResolvedValueOnce([
              {
                messageId: 'msg-upstream-1',
                conversationId: 'conv-upstream-1',
                senderId: 'sender-1',
                senderName: 'Teacher',
                subject: 'Subject',
                bodyHtmlSanitized: null,
                bodyTextPreview: null,
                sendTime: NOW,
                isUnread: true,
                recipients: [],
                files: [{ fileId: 'f-1' }],
                preventReply: false,
                sentViaEmail: false,
                sentViaSms: false,
              },
            ])
            .mockResolvedValueOnce([
              {
                messageId: 'msg-upstream-1',
                conversationId: 'conv-upstream-1',
                senderId: 'sender-1',
                senderName: 'Teacher',
                subject: 'Subject',
                bodyHtmlSanitized: '<p>unsafeBody</p>',
                bodyTextPreview: 'unsafeBody',
                sendTime: NOW,
                isUnread: true,
                recipients: [],
                files: [{ fileId: 'f-1' }],
                preventReply: false,
                sentViaEmail: false,
                sentViaSms: false,
              },
            ]),
          messageUpsert,
        }),
        makeMockMashovClient({ get: mashovGet }),
      );

      const result = await service.getConversationDetail('conv-upstream-1');
      expect(mashovGet).toHaveBeenCalledWith(
        '/api/mail/conversations/conv-upstream-1',
        expect.any(Object),
      );
      expect(messageUpsert).toHaveBeenCalled();
      expect(result.messages[0].hasAttachments).toBe(true);
    });
  });

  describe('mail actions', () => {
    it('markUnread updates DB and returns updated count', async () => {
      const mashovPut = jest.fn().mockResolvedValue({});
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany: jest.fn().mockResolvedValue({ count: 2 }),
        }),
        makeMockMashovClient({ put: mashovPut }),
      );

      const result = await service.markUnread(['conv-1', 'conv-2']);
      expect(result.updated).toBe(2);
      expect(mashovPut).toHaveBeenCalledWith(
        '/api/mail/conversations/markAsUnread',
        ['conv-1', 'conv-2'],
        expect.any(Object),
      );
    });

    it('archive deletes conversations and messages and returns deleted count', async () => {
      const conversationDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const messageDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const readStateDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const mashovPut = jest.fn().mockResolvedValue({});
      const service = new MailService(
        makeMockPrisma({
          conversationDeleteMany,
          messageDeleteMany,
          readStateDeleteMany,
        }),
        makeMockMashovClient({ put: mashovPut }),
      );

      const result = await service.archive(['conv-upstream-1']);
      expect(result.updated).toBe(1);
      expect(mashovPut).toHaveBeenCalledWith(
        '/api/mail/conversations/move/archive',
        ['conv-upstream-1'],
        expect.any(Object),
      );
      expect(messageDeleteMany).toHaveBeenCalled();
      expect(conversationDeleteMany).toHaveBeenCalled();
      expect(readStateDeleteMany).toHaveBeenCalled();
    });
  });
});
