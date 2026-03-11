import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import * as sanitizeHtml from 'sanitize-html';
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
    const [unreadCount, conversations] = await Promise.all([
      this.prisma.mailConversation.count({ where: { isUnread: true } }),
      this.prisma.mailConversation.findMany({
        orderBy: { sendTime: 'desc' },
        take: 3,
      }),
    ]);

    return {
      unreadCount,
      preview: conversations.map((c) => ({
        id: c.id,
        conversationId: c.conversationId,
        subject: c.subject,
        senderNamePreview: c.senderNamePreview,
        sendTime: c.sendTime.toISOString(),
        isUnread: c.isUnread,
      })),
    };
  }

  async getConversations(page: number, limit: number) {
    const [items, total] = await Promise.all([
      this.prisma.mailConversation.findMany({
        orderBy: { sendTime: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.mailConversation.count(),
    ]);

    return {
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
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
      where: {
        conversationId,
        bodyHtmlSanitized: { not: null },
      },
    });

    if (existingMessages.length > 0) {
      return { conversation, messages: existingMessages };
    }

    // Lazy fetch from upstream
    try {
      const upstream = await this.mashovClient.get<UpstreamConversationDetail>(
        `/api/mail/inbox/conversations/${conversationId}`,
        {
          headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
        },
      );

      const messages = await Promise.all(
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

      return { conversation, messages };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch conversation detail from upstream: ${msg}`);
      // Return with metadata-only messages as fallback
      const fallback = await this.prisma.mailMessage.findMany({ where: { conversationId } });
      return { conversation, messages: fallback };
    }
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

    return { archived: conversationIds.length };
  }
}
