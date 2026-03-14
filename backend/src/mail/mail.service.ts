import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import sanitizeHtml = require('sanitize-html');
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MashovHttpClient } from '../session/mashov-http.client';

interface UpstreamMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  subject: string;
  body?: string;
  sendTime: string;
  isNew: boolean;
  recipients: unknown[];
  files?: unknown[];
  preventReply: boolean;
  sentViaEmail: boolean;
  sentViaSms: boolean;
}

interface UpstreamConversationDetail {
  conversationId: string;
  subject?: string;
  sendTime?: string;
  isNew?: boolean;
  hasDrafts?: boolean;
  hasAttachments?: boolean;
  preventReply?: boolean;
  labels?: unknown[];
  messages?: UpstreamMessage[];
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'b', 'i', 'em', 'strong', 'u', 'br', 'p', 'div', 'span',
    'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
  ],
  allowedAttributes: {
    'a': ['href', 'target'],
    'span': ['style'],
    'div': ['style'],
    'p': ['style'],
  },
  allowedStyles: {
    '*': {
      'color': [/^#[0-9a-f]{3,6}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
      'font-size': [/^\d+(?:px|em|%)$/],
      'font-weight': [/^bold$/, /^\d+$/],
      'text-align': [/^(?:left|right|center|justify)$/],
      'text-decoration': [/^underline$/],
    },
  },
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mashovClient: MashovHttpClient,
  ) {}

  async getSummary() {
    const [household, unreadFallback, recentConversations, lastSync] = await Promise.all([
      this.prisma.householdConnection.findFirst({
        where: { active: true },
        orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
        select: { cachedUnreadCount: true },
      }),
      this.prisma.mailConversation.count({
        where: {
          isUnread: true,
          NOT: { labels: { array_contains: ['archived'] } },
        },
      }),
      this.prisma.mailConversation.findMany({
        where: {
          isUnread: true,
          NOT: { labels: { array_contains: ['archived'] } },
        },
        orderBy: { sendTime: 'desc' },
        take: 3,
      }),
      this.prisma.syncRun.findFirst({
        where: { source: 'mail_inbox', status: 'success' },
        orderBy: { endedAt: 'desc' },
        select: { endedAt: true },
      }),
    ]);

    const unreadConversations = household?.cachedUnreadCount ?? unreadFallback;

    return {
      unreadConversations,
      recentConversations: recentConversations.map((c) => ({
        conversationId: c.conversationId,
        subject: c.subject,
        senderNamePreview: c.senderNamePreview ?? '',
        sendTime: c.sendTime.toISOString(),
        isUnread: c.isUnread,
        hasAttachments: c.hasAttachments,
        preventReply: c.preventReply,
      })),
      lastSyncAt: lastSync?.endedAt?.toISOString() ?? null,
    };
  }

  async getConversations(page: number, limit: number, unreadOnly: boolean) {
    const where = this.buildInboxWhere(unreadOnly);
    const [items, total] = await Promise.all([
      this.prisma.mailConversation.findMany({
        where,
        orderBy: { sendTime: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.mailConversation.count({ where }),
    ]);

    const readStateRows = await this.prisma.readState.findMany({
      where: {
        itemType: 'mail_conversation',
        itemId: { in: items.map((item) => item.conversationId) },
        scopeType: 'household',
        scopeId: 'default',
      },
      select: { itemId: true, isHandled: true },
    });
    const handledMap = new Map(readStateRows.map((row) => [row.itemId, row.isHandled]));

    return {
      data: items.map((item) => ({
        conversationId: item.conversationId,
        subject: item.subject,
        senderNamePreview: item.senderNamePreview ?? '',
        sendTime: item.sendTime.toISOString(),
        isUnread: item.isUnread,
        hasAttachments: item.hasAttachments,
        preventReply: item.preventReply,
        labels: this.asStringArray(item.labels),
        isHandled: handledMap.get(item.conversationId) ?? false,
        lastFetchedAt: item.lastFetchedAt.toISOString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async getConversationDetail(conversationId: string) {
    const conversation = await this.prisma.mailConversation.findUnique({
      where: { conversationId },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${conversationId}`);
    }

    if (this.asStringArray(conversation.labels).includes('archived')) {
      throw new NotFoundException(`Conversation not found: ${conversationId}`);
    }

    // Check if full messages with body exist in DB
    const existingMessages = await this.prisma.mailMessage.findMany({
      where: { conversationId },
      orderBy: { sendTime: 'asc' },
    });
    const hasRenderableBody = existingMessages.some(
      (msg) => typeof msg.bodyHtmlSanitized === 'string' && msg.bodyHtmlSanitized.trim().length > 0,
    );

    if (!hasRenderableBody) {
      // Lazy fetch from upstream
      try {
        const upstream = await this.mashovClient.get<UpstreamConversationDetail>(
          `/api/mail/conversations/${conversationId}`,
          {
            headers: {
              Referer: `https://web.mashov.info/students/main/mailbox/conversation/${conversationId}`,
            },
          },
        );

        await this.prisma.mailConversation.update({
          where: { conversationId },
          data: {
            subject: upstream.subject ?? conversation.subject,
            senderNamePreview: upstream.messages?.[0]?.senderName ?? conversation.senderNamePreview,
            sendTime: upstream.sendTime ? new Date(upstream.sendTime) : conversation.sendTime,
            isUnread: upstream.isNew ?? conversation.isUnread,
            hasDrafts: upstream.hasDrafts ?? conversation.hasDrafts,
            hasAttachments: upstream.hasAttachments ?? conversation.hasAttachments,
            preventReply: upstream.preventReply ?? conversation.preventReply,
            ...(Array.isArray(upstream.labels)
              ? { labels: upstream.labels as Prisma.InputJsonValue }
              : {}),
            rawPayload: upstream as unknown as Prisma.InputJsonValue,
            lastFetchedAt: new Date(),
          },
        });

        await Promise.all(
          (upstream.messages ?? []).map(async (msg) => {
            if (!msg.messageId) return;
            const sanitized = msg.body ? sanitizeHtml(msg.body, SANITIZE_OPTIONS) : null;
            const preview = sanitized
              ? sanitizeHtml(sanitized, { allowedTags: [] }).substring(0, 200)
              : null;
            const files = Array.isArray(msg.files) ? msg.files : [];
            const recipients = Array.isArray(msg.recipients) ? msg.recipients : [];

            return this.prisma.mailMessage.upsert({
              where: { messageId: msg.messageId },
              create: {
                messageId: msg.messageId,
                conversationId: msg.conversationId || conversationId,
                senderId: msg.senderId ?? '',
                senderName: msg.senderName ?? '',
                subject: msg.subject ?? '',
                bodyHtmlSanitized: sanitized,
                bodyTextPreview: preview,
                sendTime: new Date(msg.sendTime),
                isUnread: msg.isNew,
                recipients: recipients as Prisma.InputJsonValue,
                files: files as Prisma.InputJsonValue,
                preventReply: msg.preventReply,
                sentViaEmail: msg.sentViaEmail,
                sentViaSms: msg.sentViaSms,
                rawPayload: msg as unknown as Prisma.InputJsonValue,
              },
              update: {
                senderId: msg.senderId ?? '',
                senderName: msg.senderName ?? '',
                subject: msg.subject ?? '',
                bodyHtmlSanitized: sanitized,
                bodyTextPreview: preview,
                sendTime: new Date(msg.sendTime),
                isUnread: msg.isNew,
                recipients: recipients as Prisma.InputJsonValue,
                files: files as Prisma.InputJsonValue,
                preventReply: msg.preventReply,
                sentViaEmail: msg.sentViaEmail,
                sentViaSms: msg.sentViaSms,
                rawPayload: msg as unknown as Prisma.InputJsonValue,
              },
            });
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to fetch conversation detail from upstream: ${msg}`);
      }
    }

    const messages = await this.prisma.mailMessage.findMany({
      where: { conversationId },
      orderBy: { sendTime: 'asc' },
    });

    const resolvedConversation = await this.prisma.mailConversation.findUnique({
      where: { conversationId },
    });
    if (!resolvedConversation) {
      throw new NotFoundException(`Conversation not found: ${conversationId}`);
    }

    const readState = await this.prisma.readState.findUnique({
      where: {
        itemType_itemId_scopeType_scopeId: {
          itemType: 'mail_conversation',
          itemId: conversationId,
          scopeType: 'household',
          scopeId: 'default',
        },
      },
      select: { isHandled: true },
    });

    return {
      conversationId: resolvedConversation.conversationId,
      subject: resolvedConversation.subject,
      sendTime: resolvedConversation.sendTime.toISOString(),
      isUnread: resolvedConversation.isUnread,
      hasDrafts: resolvedConversation.hasDrafts,
      hasAttachments: resolvedConversation.hasAttachments,
      preventReply: resolvedConversation.preventReply,
      labels: this.asStringArray(resolvedConversation.labels),
      isHandled: readState?.isHandled ?? false,
      messages: messages.map((msg) => ({
        messageId: msg.messageId,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        subject: msg.subject,
        bodyHtmlSanitized: msg.bodyHtmlSanitized ?? '',
        bodyTextPreview: msg.bodyTextPreview ?? '',
        sendTime: msg.sendTime.toISOString(),
        isUnread: msg.isUnread,
        recipients: this.normalizeRecipients(msg.recipients),
        preventReply: msg.preventReply,
        sentViaEmail: msg.sentViaEmail,
        sentViaSms: msg.sentViaSms,
        hasAttachments: this.hasMessageAttachments(msg.files),
      })),
      lastFetchedAt: resolvedConversation.lastFetchedAt.toISOString(),
    };
  }

  private buildInboxWhere(unreadOnly: boolean): Prisma.MailConversationWhereInput {
    return {
      ...(unreadOnly ? { isUnread: true } : {}),
      NOT: { labels: { array_contains: ['archived'] } },
    };
  }

  private asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  private normalizeRecipients(value: unknown): Array<{
    displayOrder: number;
    displayName: string;
    valueType: string;
    targetType: string;
    isGroup: boolean;
  }> {
    if (!Array.isArray(value)) return [];

    return value.map((recipient, index) => {
      if (recipient && typeof recipient === 'object') {
        const candidate = recipient as Record<string, unknown>;
        return {
          displayOrder:
            typeof candidate.displayOrder === 'number' ? candidate.displayOrder : index,
          displayName:
            typeof candidate.displayName === 'string'
              ? candidate.displayName
              : typeof candidate.value === 'string'
                ? candidate.value
                : '',
          valueType: typeof candidate.valueType === 'string' ? candidate.valueType : '',
          targetType: typeof candidate.targetType === 'string' ? candidate.targetType : '',
          isGroup: Boolean(candidate.isGroup),
        };
      }

      return {
        displayOrder: index,
        displayName: '',
        valueType: '',
        targetType: '',
        isGroup: false,
      };
    });
  }

  private hasMessageAttachments(value: unknown): boolean {
    return Array.isArray(value) && value.length > 0;
  }

  async markUnread(conversationIds: string[]) {
    try {
      await this.mashovClient.put(
        '/api/mail/conversations/markAsUnread',
        conversationIds,
        {
          headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Upstream markAsUnread failed: ${msg}; updating DB only`);
    }

    await this.prisma.mailConversation.updateMany({
      where: { conversationId: { in: conversationIds } },
      data: { isUnread: true },
    });

    return { updated: conversationIds.length };
  }

  async archive(conversationIds: string[]) {
    try {
      await this.mashovClient.put(
        '/api/mail/conversations/move/archive',
        conversationIds,
        {
          headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Upstream archive failed: ${msg}; updating DB only`);
    }

    await this.prisma.mailMessage.deleteMany({
      where: { conversationId: { in: conversationIds } },
    });

    const deleted = await this.prisma.mailConversation.deleteMany({
      where: { conversationId: { in: conversationIds } },
    });

    await this.prisma.readState.deleteMany({
      where: {
        itemType: 'mail_conversation',
        itemId: { in: conversationIds },
        scopeType: 'household',
        scopeId: 'default',
      },
    });

    return { updated: deleted.count };
  }
}
