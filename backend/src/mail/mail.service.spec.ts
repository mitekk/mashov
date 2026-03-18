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
  const householdUpdate = overrides.householdUpdate
    ?? overrides.householdUpdateMany
    ?? jest.fn().mockResolvedValue({ count: 0 });

  return {
    householdConnection: {
      findFirst: overrides.householdFindFirst ?? jest.fn().mockResolvedValue(null),
      update: householdUpdate,
      updateMany: householdUpdate,
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
    syncRun: {
      findFirst: overrides.syncRunFindFirst ?? jest.fn().mockResolvedValue(null),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeMockMashovClient(overrides: Partial<Record<string, jest.Mock>>) {
  return {
    get: overrides.get ?? jest.fn().mockResolvedValue({}),
    getResponse: overrides.getResponse ?? jest.fn().mockResolvedValue({
      data: new ArrayBuffer(0),
      headers: {},
    }),
    put: overrides.put ?? jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<MashovHttpClient>;
}

describe('MailService', () => {
  describe('getSummary', () => {
    it('prefers household cachedNewCount when active connection exists', async () => {
      const householdFindFirst = jest.fn().mockResolvedValue({ cachedNewCount: 68 });
      const conversationCount = jest.fn().mockResolvedValue(60);
      const conversationFindMany = jest.fn().mockResolvedValue([
        makeConversation({ conversationId: 'conv-upstream-1', isUnread: true }),
      ]);
      const service = new MailService(
        makeMockPrisma({
          householdFindFirst,
          conversationCount,
          conversationFindMany,
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getSummary();
      expect(result.newConversations).toBe(68);
      expect(result.recentConversations[0].conversationId).toBe('conv-upstream-1');
      expect(result.lastSyncAt).toBe(NOW.toISOString());
      expect(householdFindFirst).toHaveBeenCalled();
    });

    it('falls back to DB unread non-archived count when no active connection exists', async () => {
      const conversationCount = jest.fn().mockResolvedValue(60);
      const service = new MailService(
        makeMockPrisma({
          householdFindFirst: jest.fn().mockResolvedValue(null),
          conversationCount,
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getSummary();
      expect(result.newConversations).toBe(60);
    });

    it('queries count and recent conversations with unread + non-archived filter', async () => {
      const conversationCount = jest.fn().mockResolvedValue(4);
      const conversationFindMany = jest.fn().mockResolvedValue([]);
      const service = new MailService(
        makeMockPrisma({
          conversationCount,
          conversationFindMany,
        }),
        makeMockMashovClient({}),
      );

      await service.getSummary();

      const unreadNonArchivedWhere = {
        isUnread: true,
        NOT: { labels: { array_contains: ['archived'] } },
      };
      expect(conversationCount).toHaveBeenCalledWith({ where: unreadNonArchivedWhere });
      expect(conversationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: unreadNonArchivedWhere,
        }),
      );
    });

    it('does not include unreadConversations field in summary', async () => {
      const service = new MailService(
        makeMockPrisma({
          householdFindFirst: jest.fn().mockResolvedValue(null),
          conversationCount: jest.fn().mockResolvedValue(2),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getSummary();
      expect(result).not.toHaveProperty('unreadConversations');
    });
  });

  describe('getConversations', () => {
    it('returns paginated list with isNew from mail_conversation directly', async () => {
      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: jest.fn().mockResolvedValue([
            makeConversation({ conversationId: 'conv-1', isUnread: true }),
          ]),
          conversationCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getConversations(1, 20, 'all');
      expect(result.pagination).toMatchObject({ page: 1, total: 1, totalPages: 1 });
      expect(result.data[0]).toMatchObject({
        conversationId: 'conv-1',
        isNew: true,
      });
    });

    it('does not include isHandled field on conversation list items', async () => {
      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: jest.fn().mockResolvedValue([
            makeConversation({ conversationId: 'conv-1' }),
          ]),
          conversationCount: jest.fn().mockResolvedValue(1),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getConversations(1, 20, 'all');
      expect(result.data[0]).not.toHaveProperty('isHandled');
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

    it('returns flattened contract shape with isNew from conversation record', async () => {
      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(
            makeConversation({ conversationId: 'conv-1', isUnread: false }),
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
        }),
        makeMockMashovClient({}),
      );

      const result = await service.getConversationDetail('conv-1');
      expect(result).toMatchObject({
        conversationId: 'conv-1',
        isNew: false,
      });
      expect(result).not.toHaveProperty('isHandled');
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

  describe('downloadMessageAttachment', () => {
    it('downloads using absolute attachment URL from message metadata', async () => {
      const getResponse = jest.fn().mockResolvedValue({
        data: Buffer.from('file-bytes'),
        headers: { 'content-type': 'application/pdf' },
      });
      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(
            makeConversation({ conversationId: 'conv-1' }),
          ),
          messageFindMany: jest.fn().mockResolvedValue([
            {
              messageId: 'msg-1',
              conversationId: 'conv-1',
              files: [
                {
                  fileId: 'file-1',
                  fileName: 'document.pdf',
                  url: 'https://cdn.example.com/download/file-1',
                },
              ],
            },
          ]),
        }),
        makeMockMashovClient({ getResponse }),
      );

      await service.downloadMessageAttachment('conv-1', 'msg-1', 'file-1');

      expect(getResponse).toHaveBeenCalledWith(
        'https://cdn.example.com/download/file-1',
        expect.objectContaining({
          responseType: 'arraybuffer',
          headers: expect.objectContaining({
            Referer: 'https://web.mashov.info/students/main/mailbox/conversation/conv-1',
          }),
        }),
      );
    });

    it('supports Mashov download endpoint pattern with /download/:fileName', async () => {
      const getResponse = jest.fn().mockImplementation(async (url: string) => {
        if (url === '/api/mail/messages/msg-1/files/file-1/download/document.pdf') {
          return {
            data: Buffer.from('file-bytes'),
            headers: { 'content-type': 'application/pdf' },
          };
        }
        throw new Error('not found');
      });
      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(
            makeConversation({ conversationId: 'conv-1' }),
          ),
          messageFindMany: jest.fn().mockResolvedValue([
            {
              messageId: 'msg-1',
              conversationId: 'conv-1',
              files: [{ fileId: 'file-1', fileName: 'document.pdf' }],
            },
          ]),
        }),
        makeMockMashovClient({ getResponse }),
      );

      await service.downloadMessageAttachment('conv-1', 'msg-1', 'file-1');

      expect(getResponse).toHaveBeenCalledWith(
        '/api/mail/messages/msg-1/files/file-1/download/document.pdf',
        expect.any(Object),
      );
    });

    it('refreshes conversation detail and retries attachment download when first attempt fails', async () => {
      const initialMessage = {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        files: [{ fileId: 'file-1', fileName: 'document.pdf' }],
      };
      const refreshedMessage = {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        files: [
          {
            fileId: 'file-1',
            fileName: 'document.pdf',
            url: 'https://download.example.com/file-1',
          },
        ],
      };

      const messageFindMany = jest
        .fn()
        .mockResolvedValueOnce([initialMessage])
        .mockResolvedValueOnce([refreshedMessage]);
      const mashovGet = jest.fn().mockResolvedValue({
        conversationId: 'conv-1',
        subject: 'Subject',
        sendTime: NOW.toISOString(),
        isNew: true,
        hasDrafts: false,
        hasAttachments: true,
        preventReply: false,
        labels: [],
        messages: [
          {
            messageId: 'msg-1',
            conversationId: 'conv-1',
            senderId: 'sender-1',
            senderName: 'Teacher',
            subject: 'Subject',
            body: '<p>Body</p>',
            sendTime: NOW.toISOString(),
            isNew: true,
            recipients: [],
            files: [
              {
                fileId: 'file-1',
                fileName: 'document.pdf',
                url: 'https://download.example.com/file-1',
              },
            ],
            preventReply: false,
            sentViaEmail: false,
            sentViaSms: false,
          },
        ],
      });
      const getResponse = jest.fn().mockImplementation(async (url: string) => {
        if (url === 'https://download.example.com/file-1') {
          return {
            data: Buffer.from('file-bytes'),
            headers: { 'content-type': 'application/pdf' },
          };
        }
        throw new Error('not found');
      });

      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest.fn().mockResolvedValue(
            makeConversation({ conversationId: 'conv-1' }),
          ),
          conversationUpdate: jest.fn().mockResolvedValue(makeConversation({ conversationId: 'conv-1' })),
          messageFindMany,
          messageUpsert: jest.fn().mockResolvedValue({}),
        }),
        makeMockMashovClient({
          get: mashovGet,
          getResponse,
        }),
      );

      await service.downloadMessageAttachment('conv-1', 'msg-1', 'file-1');

      expect(mashovGet).toHaveBeenCalledWith(
        '/api/mail/conversations/conv-1',
        expect.any(Object),
      );
      expect(getResponse).toHaveBeenCalledWith(
        'https://download.example.com/file-1',
        expect.any(Object),
      );
    });
  });

  describe('markConversationsRead', () => {
    it('sets isNew=false on conversations and updates cachedNewCount', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
      const householdUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany,
          householdUpdate,
          conversationCount: jest.fn().mockResolvedValue(5),
          householdFindFirst: jest.fn().mockResolvedValue({ id: 'household-1' }),
        }),
        makeMockMashovClient({}),
      );

      const result = await service.markConversationsRead(['conv-1', 'conv-2']);
      expect(result.updated).toBe(2);
      expect(conversationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ conversationId: { in: ['conv-1', 'conv-2'] } }),
          data: expect.objectContaining({ isUnread: false }),
        }),
      );
    });

    it('updates cachedNewCount after marking conversations as read', async () => {
      const householdUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany: jest.fn().mockResolvedValue({ count: 1 }),
          householdUpdate,
          conversationCount: jest.fn().mockResolvedValue(3),
          householdFindFirst: jest.fn().mockResolvedValue({ id: 'household-1' }),
        }),
        makeMockMashovClient({}),
      );

      await service.markConversationsRead(['conv-1']);
      expect(householdUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'household-1' }),
          data: expect.objectContaining({ cachedNewCount: 3 }),
        }),
      );
    });
  });

  describe('mail actions', () => {
    it('markUnread sets isUnread=true and returns updated count', async () => {
      const mashovPut = jest.fn().mockResolvedValue({});
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: jest.fn().mockResolvedValue([
            { conversationId: 'conv-1' },
            { conversationId: 'conv-2' },
          ]),
          conversationUpdateMany,
        }),
        makeMockMashovClient({ put: mashovPut }),
      );

      const result = await service.markUnread(['conv-1', 'conv-2']);
      expect(result.updated).toBe(2);
      expect(conversationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isUnread: true }),
        }),
      );
      expect(mashovPut).toHaveBeenCalledWith(
        '/api/mail/conversations/markAsUnread',
        ['conv-1', 'conv-2'],
        expect.any(Object),
      );
    });

    it('markUnread skips archived conversations', async () => {
      const mashovPut = jest.fn().mockResolvedValue({});
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: jest.fn().mockResolvedValue([]),
          conversationUpdateMany,
        }),
        makeMockMashovClient({ put: mashovPut }),
      );

      const result = await service.markUnread(['conv-archived-1']);
      expect(result.updated).toBe(0);
      expect(mashovPut).not.toHaveBeenCalled();
      expect(conversationUpdateMany).not.toHaveBeenCalled();
    });

    it('archive sets labels to archived and isUnread=false', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const mashovPut = jest.fn().mockResolvedValue({});
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany,
          householdFindFirst: jest.fn().mockResolvedValue({ id: 'household-1' }),
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
      expect(conversationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ conversationId: { in: ['conv-upstream-1'] } }),
          data: expect.objectContaining({ isUnread: false, labels: ['archived'] }),
        }),
      );
    });

    it('unarchive clears archived label and sets isUnread=true', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const householdUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const mashovPut = jest.fn().mockResolvedValue({});
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany,
          householdUpdate,
          conversationCount: jest.fn().mockResolvedValue(7),
          householdFindFirst: jest.fn().mockResolvedValue({ id: 'household-1' }),
        }),
        makeMockMashovClient({ put: mashovPut }),
      );

      const result = await service.unarchive(['conv-archived-1']);
      expect(result.updated).toBe(1);
      expect(mashovPut).toHaveBeenCalledWith(
        '/api/mail/conversations/markAsUnread',
        ['conv-archived-1'],
        expect.any(Object),
      );
      expect(conversationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ conversationId: { in: ['conv-archived-1'] } }),
          data: expect.objectContaining({ isUnread: true, labels: [] }),
        }),
      );
      expect(householdUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'household-1' }),
          data: expect.objectContaining({ cachedNewCount: 7 }),
        }),
      );
    });
  });
});
