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
    const [household, newFallback, recentConversations, lastSync] = await Promise.all([
      this.prisma.householdConnection.findFirst({
        where: { active: true },
        orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
        select: { cachedNewCount: true },
      }),
      this.prisma.mailConversation.count({
        where: {
          isNew: true,
          NOT: { labels: { array_contains: ['archived'] } },
        },
      }),
      this.prisma.mailConversation.findMany({
        where: {
          isNew: true,
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

    const newConversations = household?.cachedNewCount ?? newFallback;

    return {
      newConversations,
      recentConversations: recentConversations.map((c) => ({
        conversationId: c.conversationId,
        subject: c.subject,
        senderNamePreview: c.senderNamePreview ?? '',
        sendTime: c.sendTime.toISOString(),
        isNew: c.isNew,
        hasAttachments: c.hasAttachments,
        preventReply: c.preventReply,
      })),
      lastSyncAt: lastSync?.endedAt?.toISOString() ?? null,
    };
  }

  async getConversations(page: number, limit: number, filter: 'all' | 'new' | 'archived') {
    const where = this.buildInboxWhere(filter);
    const [items, total] = await Promise.all([
      this.prisma.mailConversation.findMany({
        where,
        orderBy: { sendTime: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.mailConversation.count({ where }),
    ]);

    return {
      data: items.map((item) => ({
        conversationId: item.conversationId,
        subject: item.subject,
        senderNamePreview: item.senderNamePreview ?? '',
        sendTime: item.sendTime.toISOString(),
        isNew: item.isNew,
        hasAttachments: item.hasAttachments,
        preventReply: item.preventReply,
        labels: this.asStringArray(item.labels),
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
            isNew: upstream.isNew ?? conversation.isNew,
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
                isNew: msg.isNew,
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
                isNew: msg.isNew,
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

    return {
      conversationId: resolvedConversation.conversationId,
      subject: resolvedConversation.subject,
      sendTime: resolvedConversation.sendTime.toISOString(),
      isNew: resolvedConversation.isNew,
      hasDrafts: resolvedConversation.hasDrafts,
      hasAttachments: resolvedConversation.hasAttachments,
      preventReply: resolvedConversation.preventReply,
      labels: this.asStringArray(resolvedConversation.labels),
      messages: messages.map((msg) => ({
        messageId: msg.messageId,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        subject: msg.subject,
        bodyHtmlSanitized: msg.bodyHtmlSanitized ?? '',
        bodyTextPreview: msg.bodyTextPreview ?? '',
        sendTime: msg.sendTime.toISOString(),
        isNew: msg.isNew,
        recipients: this.normalizeRecipients(msg.recipients),
        preventReply: msg.preventReply,
        sentViaEmail: msg.sentViaEmail,
        sentViaSms: msg.sentViaSms,
        hasAttachments: this.hasMessageAttachments(msg.files),
      })),
      lastFetchedAt: resolvedConversation.lastFetchedAt.toISOString(),
    };
  }

  private buildInboxWhere(filter: 'all' | 'new' | 'archived'): Prisma.MailConversationWhereInput {
    if (filter === 'archived') {
      return { labels: { array_contains: ['archived'] } };
    }
    return {
      ...(filter === 'new' ? { isNew: true } : {}),
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

  async markConversationsRead(conversationIds: string[]) {
    await this.prisma.mailConversation.updateMany({
      where: { conversationId: { in: conversationIds } },
      data: { isNew: false },
    });

    await this.updateCachedNewCount();

    return { updated: conversationIds.length };
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
      data: { isNew: true },
    });

    await this.updateCachedNewCount();

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

    const updated = await this.prisma.mailConversation.updateMany({
      where: { conversationId: { in: conversationIds } },
      data: { isNew: false, labels: ['archived'] as unknown as Prisma.InputJsonValue },
    });

    await this.updateCachedNewCount();

    return { updated: updated.count };
  }

  async unarchive(conversationIds: string[]) {
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
      this.logger.warn(`Upstream unarchive(markAsUnread) failed: ${msg}; updating DB only`);
    }

    const updated = await this.prisma.mailConversation.updateMany({
      where: { conversationId: { in: conversationIds } },
      data: { isNew: true, labels: [] as unknown as Prisma.InputJsonValue },
    });

    await this.updateCachedNewCount();

    return { updated: updated.count };
  }

  private async updateCachedNewCount(): Promise<void> {
    const newCount = await this.prisma.mailConversation.count({
      where: {
        isNew: true,
        NOT: { labels: { array_contains: ['archived'] } },
      },
    });

    const household = await this.prisma.householdConnection.findFirst({
      where: { active: true },
    });

    if (household) {
      await this.prisma.householdConnection.update({
        where: { id: household.id },
        data: { cachedNewCount: newCount },
      });
    }
  }
}
