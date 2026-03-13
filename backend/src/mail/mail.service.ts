import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import sanitizeHtml = require('sanitize-html');
import { PrismaService } from '../prisma/prisma.service';
import { MashovHttpClient } from '../session/mashov-http.client';

interface UpstreamMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  subject: string;
  body: string;
  sendTime: string;
  isNew: boolean;
  recipients: unknown[];
  files: unknown[];
  preventReply: boolean;
  sentViaEmail: boolean;
  sentViaSms: boolean;
}

interface UpstreamConversationDetail {
  conversationId: string;
  subject: string;
  messages: UpstreamMessage[];
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
    const [unreadConversations, recentConversations, lastSync] = await Promise.all([
      this.prisma.mailConversation.count({ where: { isUnread: true } }),
      this.prisma.mailConversation.findMany({
        where: { isUnread: true },
        orderBy: { sendTime: 'desc' },
        take: 3,
      }),
      this.prisma.syncRun.findFirst({
        where: { source: 'mail_inbox', status: 'success' },
        orderBy: { endedAt: 'desc' },
        select: { endedAt: true },
      }),
    ]);

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
    const where = unreadOnly ? { isUnread: true } : {};
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
          `/api/mail/inbox/conversations/${conversationId}`,
          {
            headers: { Referer: 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
          },
        );

        await Promise.all(
          (upstream.messages ?? []).map(async (msg) => {
            const sanitized = msg.body ? sanitizeHtml(msg.body, SANITIZE_OPTIONS) : null;
            const preview = sanitized
              ? sanitizeHtml(sanitized, { allowedTags: [] }).substring(0, 200)
              : null;

            return this.prisma.mailMessage.upsert({
              where: { messageId: msg.messageId },
              create: {
                messageId: msg.messageId,
                conversationId: msg.conversationId,
                senderId: msg.senderId,
                senderName: msg.senderName,
                subject: msg.subject,
                bodyHtmlSanitized: sanitized,
                bodyTextPreview: preview,
                sendTime: new Date(msg.sendTime),
                isUnread: msg.isNew,
                recipients: (msg.recipients ?? []) as import('@prisma/client').Prisma.InputJsonValue,
                files: (msg.files ?? []) as import('@prisma/client').Prisma.InputJsonValue,
                preventReply: msg.preventReply,
                sentViaEmail: msg.sentViaEmail,
                sentViaSms: msg.sentViaSms,
                rawPayload: msg as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
              update: {
                bodyHtmlSanitized: sanitized,
                bodyTextPreview: preview,
                sendTime: new Date(msg.sendTime),
                isUnread: msg.isNew,
                rawPayload: msg as unknown as import('@prisma/client').Prisma.InputJsonValue,
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
      conversationId: conversation.conversationId,
      subject: conversation.subject,
      sendTime: conversation.sendTime.toISOString(),
      isUnread: conversation.isUnread,
      hasDrafts: conversation.hasDrafts,
      hasAttachments: conversation.hasAttachments,
      preventReply: conversation.preventReply,
      labels: this.asStringArray(conversation.labels),
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
      })),
      lastFetchedAt: conversation.lastFetchedAt.toISOString(),
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

  async markUnread(conversationIds: string[]) {
    try {
      await this.mashovClient.put(
        '/api/mail/conversations/markAsUnread',
        { conversationIds },
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
        { conversationIds },
        {
          headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Upstream archive failed: ${msg}; updating DB only`);
    }

    // Update labels to include 'archived' in DB
    const conversations = await this.prisma.mailConversation.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { id: true, labels: true },
    });

    await Promise.all(
      conversations.map((conv) => {
        const labels = Array.isArray(conv.labels) ? conv.labels : [];
        if (!labels.includes('archived')) {
          labels.push('archived');
        }
        return this.prisma.mailConversation.update({
          where: { id: conv.id },
          data: { labels: labels as import('@prisma/client').Prisma.InputJsonValue },
        });
      }),
    );

    return { updated: conversationIds.length };
  }
}
