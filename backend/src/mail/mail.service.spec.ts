import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MashovHttpClient } from '../session/mashov-http.client';
import { ConnectionScopeService } from '../common/connection-scope/connection-scope.service';
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
    locallyReadThroughAt: null,
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
      // The badge sums cachedNewCount across a household's connections, so the
      // read is an aggregate rather than one row. `_count` is what separates
      // "no connections, fall back to the local count" from "connections whose
      // counts sum to zero".
      aggregate:
        overrides.householdAggregate ??
        jest.fn().mockResolvedValue({ _sum: { cachedNewCount: null }, _count: { _all: 0 } }),
      // The caller's own connections, for the household scope.
      findMany: overrides.householdFindMany ?? jest.fn().mockResolvedValue([]),
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
  const response = jest.fn().mockResolvedValue({ data: new ArrayBuffer(0), headers: {} });
  return {
    // The env-session surface. Kept so a spec can still assert it is unused;
    // src/session/env-session-fence.spec.ts is what enforces that.
    get: overrides.get ?? jest.fn().mockResolvedValue({}),
    getResponse: overrides.getResponse ?? response,
    put: overrides.put ?? jest.fn().mockResolvedValue({}),
    // The per-connection surface the reads and mutations actually use.
    getForTarget: overrides.getForTarget ?? overrides.get ?? jest.fn().mockResolvedValue({}),
    getResponseForTarget: overrides.getResponseForTarget ?? overrides.getResponse ?? response,
    putForTarget: overrides.putForTarget ?? overrides.put ?? jest.fn().mockResolvedValue({}),
    deleteForTarget: overrides.deleteForTarget ?? jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<MashovHttpClient>;
}

/** The single target makeMockScope resolves everything to. */
const SCOPE_TARGET = {
  id: 'conn-1',
  schoolCode: 1234,
  schoolYear: 2027,
  username: 'parent',
  password: 'pw',
  schoolName: 'School',
};

/**
 * ConnectionScopeService stand-in. The reads under test resolve the owning
 * school through it; one connection means every lookup answers the same way,
 * which is what keeps these assertions identical to the pre-ownership ones.
 */
function makeMockScope(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const target = {
    id: 'conn-1',
    schoolCode: 1234,
    schoolYear: 2027,
    username: 'parent',
    password: 'pw',
    schoolName: 'School',
  };
  return {
    targetFor: overrides.targetFor ?? jest.fn().mockResolvedValue(target),
    targetForStudent: overrides.targetForStudent ?? jest.fn().mockResolvedValue(target),
    targetForConversation:
      overrides.targetForConversation ?? jest.fn().mockResolvedValue(target),
    targetForMessage: overrides.targetForMessage ?? jest.fn().mockResolvedValue(target),
    listTargets: overrides.listTargets ?? jest.fn().mockResolvedValue([target]),
    studentGuidsForUser: overrides.studentGuidsForUser ?? jest.fn().mockResolvedValue([]),
    stampStudent: overrides.stampStudent ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as ConnectionScopeService;
}

describe('MailService', () => {
  describe('getSummary', () => {
    it('prefers the summed cachedNewCount when active connections exist', async () => {
      const householdAggregate = jest
        .fn()
        .mockResolvedValue({ _sum: { cachedNewCount: 68 }, _count: { _all: 1 } });
      const conversationCount = jest.fn().mockResolvedValue(60);
      const conversationFindMany = jest.fn().mockResolvedValue([
        makeConversation({ conversationId: 'conv-upstream-1', isUnread: true }),
      ]);
      const service = new MailService(
        makeMockPrisma({
          householdAggregate,
          conversationCount,
          conversationFindMany,
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      const result = await service.getSummary();
      expect(result.newConversations).toBe(68);
      expect(result.recentConversations[0].conversationId).toBe('conv-upstream-1');
      expect(result.lastSyncAt).toBe(NOW.toISOString());
      expect(householdAggregate).toHaveBeenCalled();
    });

    it('sums the badge across two schools', async () => {
      // The metric the original unread fix was measured on. Reading one
      // connection's row would show one school's mail and silently hide the
      // other's; summing is what makes the badge the household's total.
      const householdAggregate = jest
        .fn()
        .mockResolvedValue({ _sum: { cachedNewCount: 16 + 7 }, _count: { _all: 2 } });
      const service = new MailService(
        makeMockPrisma({
          householdAggregate,
          conversationCount: jest.fn().mockResolvedValue(999),
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await expect(service.getSummary()).resolves.toMatchObject({ newConversations: 23 });
    });

    it('reports zero rather than falling back when the connections really sum to zero', async () => {
      // _sum is null both for "no rows" and for "rows summing to zero", so
      // without the _count check an emptied inbox would fall back to a local
      // count that need not be zero -- a badge that will not clear.
      const service = new MailService(
        makeMockPrisma({
          householdAggregate: jest
            .fn()
            .mockResolvedValue({ _sum: { cachedNewCount: 0 }, _count: { _all: 1 } }),
          conversationCount: jest.fn().mockResolvedValue(42),
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await expect(service.getSummary()).resolves.toMatchObject({ newConversations: 0 });
    });

    it("sums only the CALLER's connections, never every household's", async () => {
      // Reading one connection's row was accidentally tenant-safe. Summing
      // `{ active: true }` across the whole table is not: two households each
      // with 5 unread would both have been shown 10, and the inbox listed the
      // other household's subjects and sender names.
      const householdAggregate = jest
        .fn()
        .mockResolvedValue({ _sum: { cachedNewCount: 5 }, _count: { _all: 1 } });
      const conversationFindMany = jest.fn().mockResolvedValue([]);
      const service = new MailService(
        makeMockPrisma({
          householdAggregate,
          conversationFindMany,
          conversationCount: jest.fn().mockResolvedValue(0),
          householdFindMany: jest.fn().mockResolvedValue([{ id: 'conn-mine' }]),
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.getSummary('user-mine');

      expect(householdAggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { active: true, userId: 'user-mine' } }),
      );
      // The local count and the recent-conversation list are scoped too, or
      // the badge is right while the list under it is not.
      const [recentArgs] = conversationFindMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(recentArgs.where.OR).toEqual([
        { householdConnectionId: { in: ['conn-mine'] } },
        { householdConnectionId: null },
      ]);
    });

    it('applies no household filter when there is no caller', async () => {
      // The digest and cron paths are server-side and deliberately global.
      const householdAggregate = jest
        .fn()
        .mockResolvedValue({ _sum: { cachedNewCount: 5 }, _count: { _all: 1 } });
      const service = new MailService(
        makeMockPrisma({
          householdAggregate,
          conversationCount: jest.fn().mockResolvedValue(0),
          syncRunFindFirst: jest.fn().mockResolvedValue({ endedAt: NOW }),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.getSummary();

      expect(householdAggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { active: true } }),
      );
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
        makeMockScope(),
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
        makeMockScope(),
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
        makeMockScope(),
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
        makeMockScope(),
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
        makeMockScope(),
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
        makeMockScope(),
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
        makeMockScope(),
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
        makeMockScope(),
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
        makeMockScope(),
      );

      const result = await service.getConversationDetail('conv-upstream-1');
      expect(mashovGet).toHaveBeenCalledWith(
        '/api/mail/conversations/conv-upstream-1', SCOPE_TARGET,
        expect.any(Object));
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
        makeMockScope(),
      );

      await service.downloadMessageAttachment('conv-1', 'msg-1', 'file-1');

      expect(getResponse).toHaveBeenCalledWith(
        'https://cdn.example.com/download/file-1', SCOPE_TARGET,
        expect.objectContaining({
          responseType: 'arraybuffer',
          headers: expect.objectContaining({
            Referer: 'https://web.mashov.info/students/main/mailbox/conversation/conv-1',
          }),
        }));
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
        makeMockScope(),
      );

      await service.downloadMessageAttachment('conv-1', 'msg-1', 'file-1');

      expect(getResponse).toHaveBeenCalledWith(
        '/api/mail/messages/msg-1/files/file-1/download/document.pdf', SCOPE_TARGET,
        expect.any(Object));
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
        makeMockScope(),
      );

      await service.downloadMessageAttachment('conv-1', 'msg-1', 'file-1');

      expect(mashovGet).toHaveBeenCalledWith(
        '/api/mail/conversations/conv-1', SCOPE_TARGET,
        expect.any(Object));
      expect(getResponse).toHaveBeenCalledWith(
        'https://download.example.com/file-1', SCOPE_TARGET,
        expect.any(Object));
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
        makeMockScope(),
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
          // The conversation acted on, and the mailbox it belongs to: the
          // refresh now writes the rows the action touched and no others.
          conversationFindMany: jest
            .fn()
            .mockResolvedValue([
              { conversationId: 'conv-1', householdConnectionId: 'household-1', sendTime: NOW },
            ]),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.markConversationsRead(['conv-1']);
      expect(householdUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'household-1' }),
          data: expect.objectContaining({ cachedNewCount: 3 }),
        }),
      );
    });

    it('recomputes cachedNewCount per connection, each from its own mailbox', async () => {
      // Each row must hold its OWN mailbox's count, because the badge sums
      // them. Writing one unscoped count into each row is what reported the
      // union of both schools once per school.
      const householdUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const conversationCount = jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(where.householdConnectionId === 'conn-a' ? 16 : 7),
      );
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany: jest.fn().mockResolvedValue({ count: 1 }),
          householdUpdate,
          conversationCount,
          conversationFindMany: jest.fn().mockResolvedValue([
            { conversationId: 'conv-a1', householdConnectionId: 'conn-a', sendTime: NOW },
            { conversationId: 'conv-b1', householdConnectionId: 'conn-b', sendTime: NOW },
          ]),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.markConversationsRead(['conv-a1', 'conv-b1']);

      const written = householdUpdate.mock.calls.map((call) => ({
        id: call[0].where.id,
        count: call[0].data.cachedNewCount,
      }));
      expect(written).toEqual([
        { id: 'conn-a', count: 16 },
        { id: 'conn-b', count: 7 },
      ]);
    });

    it('refreshes only the connections the action touched', async () => {
      // With no argument this swept every active connection in the database:
      // one write per household per mail action, including households the
      // caller cannot see. An unstamped row contributes nothing, which changes
      // no count -- no connection owns it, so the sweep never moved its number
      // either.
      const householdUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const householdFindMany = jest
        .fn()
        .mockResolvedValue([{ id: 'conn-a' }, { id: 'conn-b' }, { id: 'conn-c' }]);
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany: jest.fn().mockResolvedValue({ count: 1 }),
          householdUpdate,
          householdFindMany,
          conversationCount: jest.fn().mockResolvedValue(4),
          conversationFindMany: jest.fn().mockResolvedValue([
            { conversationId: 'conv-a1', householdConnectionId: 'conn-a', sendTime: NOW },
            { conversationId: 'conv-a2', householdConnectionId: 'conn-a', sendTime: NOW },
            { conversationId: 'conv-null', householdConnectionId: null, sendTime: NOW },
          ]),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.archive(['conv-a1', 'conv-a2', 'conv-null']);

      expect(householdUpdate.mock.calls.map((call) => call[0].where.id)).toEqual(['conn-a']);
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
        makeMockScope(),
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
        ['conv-1', 'conv-2'], SCOPE_TARGET,
        expect.any(Object));
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
        makeMockScope(),
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
        makeMockScope(),
      );

      const result = await service.archive(['conv-upstream-1']);
      expect(result.updated).toBe(1);
      expect(mashovPut).toHaveBeenCalledWith(
        '/api/mail/conversations/move/archive',
        ['conv-upstream-1'], SCOPE_TARGET,
        expect.any(Object));
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
          conversationFindMany: jest
            .fn()
            .mockResolvedValue([
              { conversationId: 'conv-archived-1', householdConnectionId: 'household-1' },
            ]),
        }),
        makeMockMashovClient({ put: mashovPut }),
        makeMockScope(),
      );

      const result = await service.unarchive(['conv-archived-1']);
      expect(result.updated).toBe(1);
      expect(mashovPut).toHaveBeenCalledWith(
        '/api/mail/conversations/markAsUnread',
        ['conv-archived-1'], SCOPE_TARGET,
        expect.any(Object));
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

  describe('mail actions across two schools', () => {
    const TARGET_A = { ...SCOPE_TARGET, id: 'conn-a', schoolCode: 540175 };
    const TARGET_B = {
      ...SCOPE_TARGET,
      id: 'conn-b',
      schoolCode: 999999,
      username: 'parent-b',
    };

    /** Scope stub resolving each school's connection id to its own target. */
    function twoSchoolScope() {
      return makeMockScope({
        targetFor: jest.fn((id: string) =>
          Promise.resolve(id === 'conn-a' ? TARGET_A : TARGET_B),
        ),
        targetForConversation: jest.fn().mockResolvedValue(TARGET_A),
        targetForMessage: jest.fn().mockResolvedValue(TARGET_A),
        listTargets: jest.fn().mockResolvedValue([TARGET_A, TARGET_B]),
      });
    }

    /**
     * The two mailboxes as the table holds them.
     *
     * The split is read from `householdConnectionId` now, by the same query
     * that decides whether the caller may act on the row at all, so the
     * fixture is a row set rather than a stub of the grouping.
     */
    const OWNERS: Record<string, string> = {
      'conv-a1': 'conn-a',
      'conv-a2': 'conn-a',
      'conv-b1': 'conn-b',
    };

    function twoSchoolPrisma(overrides: Partial<Record<string, jest.Mock>> = {}) {
      return makeMockPrisma({
        conversationFindMany: jest.fn(({ where } = { where: {} }) => {
          const ids: string[] = where?.conversationId?.in ?? Object.keys(OWNERS);
          return Promise.resolve(
            ids
              .filter((conversationId) => conversationId in OWNERS)
              .map((conversationId) => ({
                conversationId,
                householdConnectionId: OWNERS[conversationId],
                sendTime: NOW,
              })),
          );
        }),
        ...overrides,
      });
    }

    it('archive issues one call per school, each with only its own ids', async () => {
      // Mashov authenticates per school, so one request cannot carry both
      // mailboxes: sending school A's session school B's conversation ids is a
      // 403 at best and silently wrong at worst.
      const mashovPut = jest.fn().mockResolvedValue({});
      const service = new MailService(
        twoSchoolPrisma({ conversationUpdateMany: jest.fn().mockResolvedValue({ count: 3 }) }),
        makeMockMashovClient({ put: mashovPut }),
        twoSchoolScope(),
      );

      await service.archive(['conv-a1', 'conv-b1', 'conv-a2']);

      expect(mashovPut).toHaveBeenCalledTimes(2);
      expect(mashovPut).toHaveBeenCalledWith(
        '/api/mail/conversations/move/archive',
        ['conv-a1', 'conv-a2'],
        TARGET_A,
        expect.anything(),
      );
      expect(mashovPut).toHaveBeenCalledWith(
        '/api/mail/conversations/move/archive',
        ['conv-b1'],
        TARGET_B,
        expect.anything(),
      );
    });

    it("archives one school's mail locally even when the other school's call fails", async () => {
      const mashovPut = jest.fn().mockImplementation((_url, _body, target) =>
        target.id === 'conn-a' ? Promise.reject(new Error('403')) : Promise.resolve({}),
      );
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 3 });
      const service = new MailService(
        twoSchoolPrisma({ conversationUpdateMany }),
        makeMockMashovClient({ put: mashovPut }),
        twoSchoolScope(),
      );

      const result = await service.archive(['conv-a1', 'conv-b1']);

      // Both calls attempted, and the local write still happens: the next
      // inbox walk settles the real state within seven minutes.
      expect(mashovPut).toHaveBeenCalledTimes(2);
      expect(result.updated).toBe(3);
      expect(conversationUpdateMany).toHaveBeenCalled();
    });

    it('markUnread sends each school only its own eligible ids', async () => {
      const mashovPut = jest.fn().mockResolvedValue({});
      const service = new MailService(
        twoSchoolPrisma({ conversationUpdateMany: jest.fn().mockResolvedValue({ count: 2 }) }),
        makeMockMashovClient({ put: mashovPut }),
        twoSchoolScope(),
      );

      await service.markUnread(['conv-a1', 'conv-b1']);

      expect(mashovPut).toHaveBeenCalledTimes(2);
      const sentIds = mashovPut.mock.calls.map((call) => call[1]);
      expect(sentIds).toEqual([['conv-a1'], ['conv-b1']]);
    });

    it("unarchive does not let one school's failure suppress the other's confirmed unread", async () => {
      // The decisive case. Before this was per connection, a single boolean
      // carried both answers: school A failing meant school B's conversation
      // was unarchived but never marked unread, so the badge under-reported
      // mail the user had explicitly brought back.
      const mashovPut = jest.fn().mockImplementation((_url, _body, target) =>
        target.id === 'conn-a' ? Promise.reject(new Error('503')) : Promise.resolve(1),
      );
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        twoSchoolPrisma({ conversationUpdateMany }),
        makeMockMashovClient({ put: mashovPut }),
        twoSchoolScope(),
      );

      await service.unarchive(['conv-a1', 'conv-b1']);

      const callsBySubset = new Map(
        conversationUpdateMany.mock.calls.map((call) => {
          const arg = call[0] as {
            where: { conversationId: { in: string[] } };
            data: Record<string, unknown>;
          };
          return [arg.where.conversationId.in.join(','), arg.data];
        }),
      );

      // A failed: unarchived, but no invented unread.
      expect(callsBySubset.get('conv-a1')).not.toHaveProperty('isUnread');
      // B confirmed: unread is real and recorded.
      expect(callsBySubset.get('conv-b1')).toMatchObject({ isUnread: true });
    });

    it('sums the updated count across schools', async () => {
      const service = new MailService(
        twoSchoolPrisma({ conversationUpdateMany: jest.fn().mockResolvedValue({ count: 1 }) }),
        makeMockMashovClient({ put: jest.fn().mockResolvedValue(1) }),
        twoSchoolScope(),
      );

      await expect(service.unarchive(['conv-a1', 'conv-b1'])).resolves.toEqual({
        updated: 2,
      });
    });
  });

  describe('hydration unread derivation', () => {
    function makeUpstreamDetail(overrides: object = {}, messageOverrides: object = {}) {
      return {
        conversationId: 'conv-upstream-1',
        subject: 'Updated Subject',
        sendTime: NOW.toISOString(),
        isNew: true,
        hasDrafts: false,
        hasAttachments: false,
        preventReply: false,
        labels: [],
        messages: [
          {
            messageId: 'msg-upstream-1',
            conversationId: 'conv-upstream-1',
            senderId: 'sender-1',
            senderName: 'Teacher',
            subject: 'Subject',
            body: '<p>Body</p>',
            sendTime: NOW.toISOString(),
            isNew: true,
            recipients: [],
            files: [],
            preventReply: false,
            sentViaEmail: false,
            sentViaSms: false,
            ...messageOverrides,
          },
        ],
        ...overrides,
      };
    }

    async function hydrate(detail: object, conversationOverrides: object = {}) {
      const conversationUpdate = jest.fn().mockResolvedValue(makeConversation());
      const service = new MailService(
        makeMockPrisma({
          conversationFindUnique: jest
            .fn()
            .mockResolvedValue(makeConversation(conversationOverrides)),
          conversationUpdate,
          messageFindMany: jest.fn().mockResolvedValue([]),
        }),
        makeMockMashovClient({ get: jest.fn().mockResolvedValue(detail) }),
        makeMockScope(),
      );
      await service.getConversationDetail('conv-upstream-1');
      return conversationUpdate;
    }

    it('writes read when upstream reports the conversation read', async () => {
      const conversationUpdate = await hydrate(makeUpstreamDetail({ isNew: false }));
      expect(conversationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isUnread: false }) }),
      );
    });

    it('keeps isUnread true when upstream still reports the conversation unread', async () => {
      const conversationUpdate = await hydrate(makeUpstreamDetail({}, { isNew: false }));
      expect(conversationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isUnread: true }) }),
      );
    });

    it('respects a local read override when hydrating', async () => {
      const conversationUpdate = await hydrate(makeUpstreamDetail(), {
        locallyReadThroughAt: NOW,
      });
      expect(conversationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isUnread: false }) }),
      );
    });

    it('falls back to the stored flag when upstream sends no messages', async () => {
      const conversationUpdate = await hydrate(
        makeUpstreamDetail({ isNew: undefined, messages: [] }),
        { isUnread: true },
      );
      expect(conversationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isUnread: true }) }),
      );
    });
  });
  describe('local read override', () => {
    const OLDER = new Date('2026-03-10T09:00:00Z');
    const NEWER = new Date('2026-03-11T09:00:00Z');

    it('records a read watermark from the newest message in each conversation', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany,
          messageFindMany: jest.fn().mockResolvedValue([
            { conversationId: 'conv-1', sendTime: OLDER },
            { conversationId: 'conv-1', sendTime: NEWER },
            { conversationId: 'conv-2', sendTime: OLDER },
          ]),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.markConversationsRead(['conv-1', 'conv-2']);

      expect(conversationUpdateMany).toHaveBeenCalledWith({
        where: { conversationId: 'conv-1' },
        data: { locallyReadThroughAt: NEWER },
      });
      expect(conversationUpdateMany).toHaveBeenCalledWith({
        where: { conversationId: 'conv-2' },
        data: { locallyReadThroughAt: OLDER },
      });
    });

    it('falls back to the conversation sendTime when no messages are stored yet', async () => {
      // Without a watermark the next walk would restore isUnread from a payload whose
      // messages are unread -- the bounce-back this whole mechanism exists to stop. The
      // conversation's own sendTime is a Mashov-parsed timestamp from the same parsing
      // domain as MailMessage.sendTime, so it is a safe substitute for their max.
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany,
          messageFindMany: jest.fn().mockResolvedValue([]),
          conversationFindMany: jest
            .fn()
            .mockResolvedValue([{ conversationId: 'conv-1', sendTime: OLDER }]),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.markConversationsRead(['conv-1']);

      expect(conversationUpdateMany).toHaveBeenCalledWith({
        where: { conversationId: 'conv-1' },
        data: { locallyReadThroughAt: OLDER },
      });
    });

    it('prefers the newest message sendTime over the conversation sendTime', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({
          conversationUpdateMany,
          messageFindMany: jest
            .fn()
            .mockResolvedValue([{ conversationId: 'conv-1', sendTime: NEWER }]),
          conversationFindMany: jest
            .fn()
            .mockResolvedValue([{ conversationId: 'conv-1', sendTime: OLDER }]),
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.markConversationsRead(['conv-1']);

      expect(conversationUpdateMany).toHaveBeenCalledWith({
        where: { conversationId: 'conv-1' },
        data: { locallyReadThroughAt: NEWER },
      });
    });

    it('markUnread records that the user asked for unread, so the sweep cannot undo it', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: jest.fn().mockResolvedValue([{ conversationId: 'conv-1' }]),
          conversationUpdateMany,
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.markUnread(['conv-1']);

      const marked = conversationUpdateMany.mock.calls
        .map((call) => call[0].data.locallyMarkedUnreadAt)
        .find((value) => value instanceof Date);
      expect(marked).toBeInstanceOf(Date);
    });

    it('markConversationsRead clears the explicit-unread marker', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({ conversationUpdateMany }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.markConversationsRead(['conv-1']);

      expect(conversationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isUnread: false, locallyMarkedUnreadAt: null }),
        }),
      );
    });

    it('archive clears the explicit-unread marker', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({ conversationUpdateMany }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.archive(['conv-1']);

      expect(conversationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isUnread: false, locallyMarkedUnreadAt: null }),
        }),
      );
    });

    it('markUnread clears the read watermark', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({
          conversationFindMany: jest.fn().mockResolvedValue([{ conversationId: 'conv-1' }]),
          conversationUpdateMany,
        }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.markUnread(['conv-1']);

      expect(conversationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isUnread: true, locallyReadThroughAt: null }),
        }),
      );
    });

    it('unarchive does not invent unread state when the upstream mark-unread fails', async () => {
      // conv.isNew is the read-state authority. Claiming unread for a conversation
      // upstream still considers read is what inflated the badge in the first place;
      // the next walk settles it within 7 minutes either way.
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({ conversationUpdateMany }),
        makeMockMashovClient({ put: jest.fn().mockRejectedValue(new Error('upstream down')) }),
        makeMockScope(),
      );

      await service.unarchive(['conv-1']);

      const data = conversationUpdateMany.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('isUnread');
      expect(data.labels).toEqual([]);
    });

    it('unarchive does not invent unread state when upstream marked nothing', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({ conversationUpdateMany }),
        makeMockMashovClient({ put: jest.fn().mockResolvedValue(0) }),
        makeMockScope(),
      );

      await service.unarchive(['conv-1']);

      expect(conversationUpdateMany.mock.calls[0][0].data).not.toHaveProperty('isUnread');
    });

    it('unarchive shields a confirmed unread from the reconciliation sweep', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({ conversationUpdateMany }),
        makeMockMashovClient({ put: jest.fn().mockResolvedValue(1) }),
        makeMockScope(),
      );

      await service.unarchive(['conv-1']);

      const data = conversationUpdateMany.mock.calls[0][0].data;
      expect(data.isUnread).toBe(true);
      expect(data.locallyMarkedUnreadAt).toBeInstanceOf(Date);
    });

    it('unarchive clears the read watermark', async () => {
      const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new MailService(
        makeMockPrisma({ conversationUpdateMany }),
        makeMockMashovClient({}),
        makeMockScope(),
      );

      await service.unarchive(['conv-1']);

      expect(conversationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isUnread: true, locallyReadThroughAt: null }),
        }),
      );
    });
  });
});

/**
 * Two households on one box. Every read and every mutation below is issued by
 * household A's user against household B's conversation.
 *
 * The property under test is not only "A does not see B's mail": it is that no
 * request leaves the process under B's credentials. `groupConversationsByConnection`
 * resolves a foreign conversation to the connection that owns it, so an
 * unscoped mutation archived B's mail *in B's Mashov account*.
 */
describe('MailService household scoping', () => {
  const CALLER = 'user-mine';
  const MINE = 'conn-mine';
  const THEIRS = 'conn-theirs';

  /** The caller owns conn-mine and nothing else. */
  const ownConnections = () => jest.fn().mockResolvedValue([{ id: MINE }]);

  /** `findFirst` as the ownership assert sees it: conn-mine is the caller's. */
  const ownedSchoolLookup = () =>
    jest.fn(({ where } = { where: {} }) =>
      Promise.resolve(
        where?.userId && where?.id ? (where.id === MINE ? { id: MINE } : null) : null,
      ),
    );

  const rows = [
    { conversationId: 'conv-mine', householdConnectionId: MINE },
    { conversationId: 'conv-theirs', householdConnectionId: THEIRS },
    { conversationId: 'conv-unstamped', householdConnectionId: null },
  ];

  function makeService(
    overrides: Partial<Record<string, jest.Mock>> = {},
    scopeOverrides: Partial<Record<string, jest.Mock>> = {},
  ) {
    const putForTarget = jest.fn().mockResolvedValue({});
    const getForTarget = jest.fn().mockResolvedValue({});
    const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = makeMockPrisma({
      householdFindMany: ownConnections(),
      householdFindFirst: ownedSchoolLookup(),
      conversationFindMany: jest.fn(({ where } = { where: {} }) => {
        const ids: string[] | undefined = where?.conversationId?.in;
        return Promise.resolve(
          ids === undefined ? rows : rows.filter((row) => ids.includes(row.conversationId)),
        );
      }),
      conversationCount: jest.fn().mockResolvedValue(0),
      conversationUpdateMany,
      ...overrides,
    });
    const client = makeMockMashovClient({ putForTarget, getForTarget });
    return {
      service: new MailService(prisma, client, makeMockScope(scopeOverrides)),
      prisma,
      putForTarget,
      getForTarget,
      conversationUpdateMany,
    };
  }

  describe('getConversations', () => {
    it("restricts the list to the caller's own mailboxes", async () => {
      const conversationFindMany = jest.fn().mockResolvedValue([]);
      const { service } = makeService({ conversationFindMany });

      await service.getConversations(1, 20, 'all', undefined, CALLER);

      const [args] = conversationFindMany.mock.calls[0] as [
        { where: { AND: Array<Record<string, unknown>> } },
      ];
      expect(args.where.AND[0]).toEqual({
        OR: [{ householdConnectionId: { in: [MINE] } }, { householdConnectionId: null }],
      });
    });

    it('404s a schoolId belonging to another household', async () => {
      // 404 and not 403, as /school-links and /sync/* already answer: a 403
      // would confirm the id names a real connection.
      const conversationFindMany = jest.fn().mockResolvedValue([]);
      const { service } = makeService({ conversationFindMany });

      await expect(
        service.getConversations(1, 20, 'all', THEIRS, CALLER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(conversationFindMany).not.toHaveBeenCalled();
    });

    it("serves the caller's own schoolId", async () => {
      const conversationFindMany = jest.fn().mockResolvedValue([]);
      const { service } = makeService({ conversationFindMany });

      await expect(service.getConversations(1, 20, 'all', MINE, CALLER)).resolves.toMatchObject({
        data: [],
      });
    });

    it('checks nothing when there is no caller', async () => {
      // The digest and the crons are server-side and deliberately global.
      const conversationFindMany = jest.fn().mockResolvedValue([]);
      const { service } = makeService({ conversationFindMany });

      await expect(service.getConversations(1, 20, 'all', THEIRS)).resolves.toMatchObject({
        data: [],
      });
    });
  });

  describe('getConversationDetail', () => {
    it("404s another household's conversation without calling upstream", async () => {
      const { service, getForTarget } = makeService({
        conversationFindUnique: jest
          .fn()
          .mockResolvedValue(makeConversation({ householdConnectionId: THEIRS })),
      });

      await expect(service.getConversationDetail('conv-theirs', CALLER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(getForTarget).not.toHaveBeenCalled();
    });

    it('serves an unstamped conversation, which is ownership-unknown and not theirs', async () => {
      const { service } = makeService({
        conversationFindUnique: jest
          .fn()
          .mockResolvedValue(makeConversation({ householdConnectionId: null })),
        messageFindMany: jest.fn().mockResolvedValue([
          {
            messageId: 'msg-1',
            conversationId: 'conv-unstamped',
            senderId: '1',
            senderName: 'Principal',
            subject: 'Parent meeting',
            bodyHtmlSanitized: '<p>hello</p>',
            bodyTextPreview: 'hello',
            sendTime: NOW,
            isNew: false,
            recipients: [],
            files: [],
            preventReply: false,
            sentViaEmail: false,
            sentViaSms: false,
          },
        ]),
      });

      await expect(service.getConversationDetail('conv-unstamped', CALLER)).resolves.toMatchObject(
        { conversationId: 'conv-upstream-1' },
      );
    });
  });

  describe('downloadMessageAttachment', () => {
    it("404s an attachment in another household's conversation", async () => {
      const { service, getForTarget } = makeService({
        conversationFindUnique: jest
          .fn()
          .mockResolvedValue(makeConversation({ householdConnectionId: THEIRS })),
      });

      await expect(
        service.downloadMessageAttachment('conv-theirs', 'msg-1', 'file-1', CALLER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(getForTarget).not.toHaveBeenCalled();
    });

    it('resolves no target for a messageId that is not in the conversation', async () => {
      // `assertVisible` validates the conversation; the messageId is a second,
      // unvalidated path to a `ConnectionTarget`, because `targetForMessage`
      // reads the message's OWN stamp and `resolveOrFallback`'s stamped branch
      // takes no caller. Resolving it before the message is known to belong to
      // this conversation decrypts another household's password inside this
      // request -- today harmless, and one reorder away from not being.
      const targetForMessage = jest
        .fn()
        .mockResolvedValue({ ...SCOPE_TARGET, id: THEIRS, username: 'parent-theirs' });
      const { service } = makeService(
        {
          conversationFindUnique: jest
            .fn()
            .mockResolvedValue(makeConversation({ householdConnectionId: MINE })),
          // The message is not in this conversation, before or after hydration.
          messageFindMany: jest.fn().mockResolvedValue([]),
        },
        { targetForMessage },
      );

      await expect(
        service.downloadMessageAttachment('conv-mine', 'msg-theirs', 'file-1', CALLER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(targetForMessage).not.toHaveBeenCalled();
    });
  });

  describe('mutations', () => {
    const MUTATIONS: Array<{
      name: string;
      call: (service: MailService, ids: string[]) => Promise<{ updated: number }>;
    }> = [
      { name: 'markConversationsRead', call: (s, ids) => s.markConversationsRead(ids, CALLER) },
      { name: 'markUnread', call: (s, ids) => s.markUnread(ids, CALLER) },
      { name: 'archive', call: (s, ids) => s.archive(ids, CALLER) },
      { name: 'unarchive', call: (s, ids) => s.unarchive(ids, CALLER) },
    ];

    it.each(MUTATIONS)(
      "$name neither writes nor calls upstream for another household's id",
      async ({ call }) => {
        const { service, putForTarget, conversationUpdateMany } = makeService();

        await expect(call(service, ['conv-theirs'])).resolves.toEqual({ updated: 0 });
        expect(putForTarget).not.toHaveBeenCalled();
        expect(conversationUpdateMany).not.toHaveBeenCalled();
      },
    );

    it.each(MUTATIONS)('$name acts on the caller\'s own ids in a mixed list', async ({ call }) => {
      const { service, putForTarget, conversationUpdateMany } = makeService();

      await call(service, ['conv-mine', 'conv-theirs']);

      for (const callArgs of putForTarget.mock.calls) {
        expect(callArgs[1]).toEqual(['conv-mine']);
      }
      // Collected and then asserted non-empty: a bare `for` over the calls
      // would pass just as well if the mutation had stopped writing at all.
      const writtenIdLists = conversationUpdateMany.mock.calls
        .map(
          (callArgs) =>
            (
              (callArgs[0] as { where: Record<string, unknown> }).where.conversationId as
                | { in?: string[] }
                | undefined
            )?.in,
        )
        .filter((ids): ids is string[] => Array.isArray(ids));
      expect(writtenIdLists.length).toBeGreaterThan(0);
      for (const ids of writtenIdLists) {
        expect(ids).toEqual(['conv-mine']);
      }
    });

    /**
     * The ownership check and the routing decision come from ONE read.
     *
     * Routing used to re-read the same rows through
     * `ConnectionScopeService.groupConversationsByConnection`, which applied
     * no ownership predicate of its own. `MailInboxTask` runs every seven
     * minutes, so a stamp written between the two queries routed an id the
     * caller was allowed to act on *while it was unstamped* to the connection
     * that had since claimed it -- through `targetFor`, which takes no caller
     * and hands back that household's decrypted password.
     *
     * The guard is the count: one stamp read per mutation, so there is no
     * second answer for routing to disagree with. The routing assertions
     * below pin that it is that read's stamp which is used.
     */
    it.each(MUTATIONS)('$name reads the stamps once and routes from them', async ({ call }) => {
      const targetFor = jest.fn().mockResolvedValue(SCOPE_TARGET);
      const targetForConversation = jest.fn().mockResolvedValue(SCOPE_TARGET);
      const conversationFindMany = jest.fn(({ where } = { where: {} }) => {
        const ids: string[] = where?.conversationId?.in ?? [];
        return Promise.resolve(
          rows
            .filter((row) => ids.includes(row.conversationId))
            .map((row) => ({ ...row, sendTime: NOW })),
        );
      });
      const { service } = makeService(
        { conversationFindMany },
        { targetFor, targetForConversation },
      );

      await call(service, ['conv-mine', 'conv-unstamped']);

      const stampReads = conversationFindMany.mock.calls.filter(
        (callArgs) =>
          (callArgs[0] as { select?: Record<string, unknown> } | undefined)?.select
            ?.householdConnectionId === true,
      );
      expect(stampReads).toHaveLength(1);

      // The stamped id routes through its own connection, the unstamped one
      // through the conversation resolver WITH the caller, so its fallback is
      // scoped to the household.
      for (const callArgs of targetFor.mock.calls) {
        expect(callArgs[0]).toBe(MINE);
      }
      for (const callArgs of targetForConversation.mock.calls) {
        expect(callArgs).toEqual(['conv-unstamped', CALLER]);
      }
    });

    it.each(MUTATIONS)('$name still acts on an unstamped id', async ({ call }) => {
      const { service, conversationUpdateMany } = makeService();

      await call(service, ['conv-unstamped']);

      expect(conversationUpdateMany).toHaveBeenCalled();
    });
  });
});
