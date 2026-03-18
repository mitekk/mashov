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

interface MailAttachment {
  fileId: string;
  fileName: string;
  url?: string;
}

interface DownloadedFile {
  buffer: Buffer;
  contentType: string | null;
  contentDisposition: string | null;
  fileName: string | null;
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
    const [localNewConversations, household, recentConversations, lastSync] = await Promise.all([
      this.prisma.mailConversation.count({
        where: {
          isUnread: true,
          NOT: { labels: { array_contains: ['archived'] } },
        },
      }),
      this.prisma.householdConnection.findFirst({
        where: { active: true },
        orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
        select: { cachedNewCount: true },
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

    const newConversations = household?.cachedNewCount ?? localNewConversations;

    return {
      newConversations,
      recentConversations: recentConversations.map((c) => ({
        conversationId: c.conversationId,
        subject: c.subject,
        senderNamePreview: c.senderNamePreview ?? '',
        sendTime: c.sendTime.toISOString(),
        isNew: c.isUnread,
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
        isNew: item.isUnread,
        hasDrafts: item.hasDrafts,
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
      await this.hydrateConversationFromUpstream(conversationId, conversation);
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
      isNew: resolvedConversation.isUnread,
      hasDrafts: resolvedConversation.hasDrafts,
      hasAttachments: resolvedConversation.hasAttachments,
      preventReply: resolvedConversation.preventReply,
      labels: this.asStringArray(resolvedConversation.labels),
      messages: messages.map((msg) => {
        const files = this.normalizeMessageFiles(msg.files);
        return {
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
          files: files.map((file) => ({
            fileId: file.fileId,
            fileName: file.fileName,
          })),
          preventReply: msg.preventReply,
          sentViaEmail: msg.sentViaEmail,
          sentViaSms: msg.sentViaSms,
          hasAttachments: files.length > 0,
        };
      }),
      lastFetchedAt: resolvedConversation.lastFetchedAt.toISOString(),
    };
  }

  async downloadMessageAttachment(
    conversationId: string,
    messageId: string,
    fileId: string,
  ): Promise<DownloadedFile> {
    const conversation = await this.prisma.mailConversation.findUnique({
      where: { conversationId },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${conversationId}`);
    }

    const referer = `https://web.mashov.info/students/main/mailbox/conversation/${conversationId}`;

    let message = await this.getMessageInConversation(conversationId, messageId);
    if (!message) {
      await this.hydrateConversationFromUpstream(conversationId, conversation);
      message = await this.getMessageInConversation(conversationId, messageId);
    }
    if (!message) throw new NotFoundException(`Message not found: ${messageId}`);

    let attachment = this.findMessageAttachment(message.files, fileId);
    if (!attachment) {
      await this.hydrateConversationFromUpstream(conversationId, conversation);
      const refreshedMessage = await this.getMessageInConversation(conversationId, messageId);
      attachment = this.findMessageAttachment(refreshedMessage?.files, fileId);
    }
    if (!attachment) throw new NotFoundException(`Attachment not found: ${fileId}`);

    try {
      return await this.tryDownloadCandidates(
        this.buildAttachmentDownloadCandidates({
          conversationId,
          messageId,
          fileId,
          fileName: attachment.fileName,
          fileUrl: attachment.url,
        }),
        referer,
        attachment.fileName,
      );
    } catch {
      // Attachment URLs may be short-lived; refresh from upstream and retry once.
      await this.hydrateConversationFromUpstream(conversationId, conversation);
      const refreshedMessage = await this.getMessageInConversation(conversationId, messageId);
      const refreshedAttachment = this.findMessageAttachment(refreshedMessage?.files, fileId);
      if (!refreshedAttachment) {
        throw new NotFoundException(`Attachment not found: ${fileId}`);
      }

      return this.tryDownloadCandidates(
        this.buildAttachmentDownloadCandidates({
          conversationId,
          messageId,
          fileId,
          fileName: refreshedAttachment.fileName,
          fileUrl: refreshedAttachment.url,
        }),
        referer,
        refreshedAttachment.fileName,
      );
    }
  }

  private async getMessageInConversation(conversationId: string, messageId: string) {
    const [message] = await this.prisma.mailMessage.findMany({
      where: { conversationId, messageId },
      take: 1,
    });
    return message ?? null;
  }

  private findMessageAttachment(files: unknown, fileId: string): MailAttachment | null {
    return this.normalizeMessageFiles(files).find((file) => file.fileId === fileId) ?? null;
  }

  private buildAttachmentDownloadCandidates(input: {
    conversationId: string;
    messageId: string;
    fileId: string;
    fileName: string;
    fileUrl?: string;
  }): string[] {
    const encodedName = encodeURIComponent(input.fileName || input.fileId);
    return [
      input.fileUrl ?? '',
      `/api/mail/messages/${input.messageId}/files/${input.fileId}/download/${encodedName}`,
      `/api/mail/conversations/${input.conversationId}/messages/${input.messageId}/files/${input.fileId}/download/${encodedName}`,
      `/api/mail/conversations/${input.conversationId}/messages/${input.messageId}/files/${input.fileId}/${encodedName}`,
      `/api/mail/conversations/${input.conversationId}/messages/${input.messageId}/files/${input.fileId}`,
      `/api/mail/conversations/${input.conversationId}/messages/${input.messageId}/attachments/${input.fileId}/${encodedName}`,
      `/api/mail/conversations/${input.conversationId}/messages/${input.messageId}/attachments/${input.fileId}`,
      `/api/mail/messages/${input.messageId}/files/${input.fileId}/${encodedName}`,
      `/api/mail/messages/${input.messageId}/files/${input.fileId}`,
      `/api/mail/messages/${input.messageId}/attachments/${input.fileId}/${encodedName}`,
      `/api/mail/messages/${input.messageId}/attachments/${input.fileId}`,
      `/api/mail/conversations/${input.conversationId}/files/${input.fileId}/${encodedName}`,
      `/api/mail/conversations/${input.conversationId}/files/${input.fileId}`,
      `/api/mail/files/${input.fileId}/${encodedName}`,
      `/api/mail/files/${input.fileId}`,
    ];
  }

  private async hydrateConversationFromUpstream(
    conversationId: string,
    fallbackConversation: {
      subject: string;
      senderNamePreview: string | null;
      sendTime: Date;
      isUnread: boolean;
      hasDrafts: boolean;
      hasAttachments: boolean;
      preventReply: boolean;
    },
  ): Promise<boolean> {
    try {
      const upstream = await this.mashovClient.get<UpstreamConversationDetail>(
        `/api/mail/conversations/${conversationId}`,
        {
          headers: {
            Referer: `https://web.mashov.info/students/main/mailbox/conversation/${conversationId}`,
          },
        },
      );

      await this.persistUpstreamConversationDetail(
        conversationId,
        fallbackConversation,
        upstream,
      );

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch conversation detail from upstream: ${msg}`);
      return false;
    }
  }

  private async persistUpstreamConversationDetail(
    conversationId: string,
    fallbackConversation: {
      subject: string;
      senderNamePreview: string | null;
      sendTime: Date;
      isUnread: boolean;
      hasDrafts: boolean;
      hasAttachments: boolean;
      preventReply: boolean;
    },
    upstream: UpstreamConversationDetail,
  ): Promise<void> {
    await this.prisma.mailConversation.update({
      where: { conversationId },
      data: {
        subject: upstream.subject ?? fallbackConversation.subject,
        senderNamePreview: upstream.messages?.[0]?.senderName ?? fallbackConversation.senderNamePreview,
        sendTime: upstream.sendTime ? new Date(upstream.sendTime) : fallbackConversation.sendTime,
        isUnread: upstream.isNew ?? fallbackConversation.isUnread,
        hasDrafts: upstream.hasDrafts ?? fallbackConversation.hasDrafts,
        hasAttachments: upstream.hasAttachments ?? fallbackConversation.hasAttachments,
        preventReply: upstream.preventReply ?? fallbackConversation.preventReply,
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
  }

  private buildInboxWhere(filter: 'all' | 'new' | 'archived'): Prisma.MailConversationWhereInput {
    if (filter === 'archived') {
      return { labels: { array_contains: ['archived'] } };
    }
    return {
      ...(filter === 'new' ? { isUnread: true } : {}),
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

  private normalizeMessageFiles(value: unknown): MailAttachment[] {
    if (!Array.isArray(value)) return [];

    return value
      .map((entry) => this.normalizeAttachmentMeta(entry))
      .filter((entry): entry is MailAttachment => Boolean(entry));
  }

  private normalizeAttachmentMeta(value: unknown): MailAttachment | null {
    if (!value || typeof value !== 'object') return null;

    const record = value as Record<string, unknown>;
    const fileId = this.pickFirstString(record, [
      'fileId',
      'id',
      'guid',
      'attachmentId',
      'fileGuid',
      'attachmentGuid',
    ]);
    if (!fileId) return null;

    const fileName = this.pickFirstString(record, [
      'fileName',
      'name',
      'title',
      'originalFileName',
      'originalName',
      'nameWithExtension',
      'displayName',
    ]) ?? fileId;
    const url = this.pickFirstString(record, [
      'url',
      'link',
      'downloadUrl',
      'href',
      'fileUrl',
      'downloadPath',
      'path',
      'uri',
    ]);

    return {
      fileId,
      fileName,
      ...(url ? { url } : {}),
    };
  }

  private pickFirstString(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
    }
    return null;
  }

  private hasMessageAttachments(value: unknown): boolean {
    return this.normalizeMessageFiles(value).length > 0;
  }

  private async tryDownloadCandidates(
    candidates: Array<string | undefined | null>,
    referer: string,
    fallbackFileName: string,
  ): Promise<DownloadedFile> {
    const uniqueCandidates = Array.from(new Set(
      candidates
        .map((candidate) => this.normalizeUpstreamPath(candidate))
        .filter((candidate): candidate is string => Boolean(candidate)),
    ));

    let lastError: string | null = null;
    for (const candidate of uniqueCandidates) {
      try {
        return await this.downloadBinaryFromUpstream(candidate, referer, fallbackFileName);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // Try next candidate URL.
      }
    }

    if (lastError) {
      this.logger.warn(`Attachment download failed for all candidates: ${lastError}`);
    }
    throw new NotFoundException('Attachment download failed');
  }

  private async downloadBinaryFromUpstream(
    pathOrUrl: string,
    referer: string,
    fallbackFileName: string,
  ): Promise<DownloadedFile> {
    const response = await this.mashovClient.getResponse<ArrayBuffer>(pathOrUrl, {
      responseType: 'arraybuffer',
      headers: {
        Referer: referer,
      },
    });

    const headers = (response.headers ?? {}) as Record<string, string | string[] | undefined>;
    const contentType = this.readHeader(headers, 'content-type');
    const contentDisposition = this.readHeader(headers, 'content-disposition');

    return {
      buffer: Buffer.from(response.data),
      contentType,
      contentDisposition,
      fileName: this.extractFileNameFromDisposition(contentDisposition) ?? fallbackFileName,
    };
  }

  private normalizeUpstreamPath(pathOrUrl: string | null | undefined): string | null {
    if (!pathOrUrl || pathOrUrl.trim().length === 0) return null;

    const value = pathOrUrl.trim();
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
    if (value.startsWith('//')) return `https:${value}`;
    if (value.startsWith('/api/')) {
      return value;
    }
    if (value.startsWith('api/')) {
      return `/${value}`;
    }
    if (value.startsWith('mail/') || value.startsWith('students/') || value.startsWith('lessons/')) {
      return `/api/${value}`;
    }
    if (value.startsWith('/')) {
      return value;
    }
    return null;
  }

  private readHeader(
    headers: Record<string, string | string[] | undefined>,
    key: string,
  ): string | null {
    const direct = headers[key] ?? headers[key.toLowerCase()];
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct) && direct.length > 0) return direct[0] ?? null;
    return null;
  }

  private extractFileNameFromDisposition(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null;

    const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch {
        return utf8Match[1];
      }
    }

    const fallbackMatch = /filename="?([^\";]+)"?/i.exec(contentDisposition);
    return fallbackMatch?.[1] ?? null;
  }

  async markConversationsRead(conversationIds: string[]) {
    await this.prisma.mailConversation.updateMany({
      where: { conversationId: { in: conversationIds } },
      data: { isUnread: false },
    });

    await this.updateCachedNewCount();

    return { updated: conversationIds.length };
  }

  async markUnread(conversationIds: string[]) {
    const eligibleConversations = await this.prisma.mailConversation.findMany({
      where: {
        conversationId: { in: conversationIds },
        NOT: { labels: { array_contains: ['archived'] } },
      },
      select: { conversationId: true },
    });
    const eligibleConversationIds = eligibleConversations.map((item) => item.conversationId);

    if (eligibleConversationIds.length === 0) {
      return { updated: 0 };
    }

    try {
      await this.mashovClient.put(
        '/api/mail/conversations/markAsUnread',
        eligibleConversationIds,
        {
          headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Upstream markAsUnread failed: ${msg}; updating DB only`);
    }

    const updated = await this.prisma.mailConversation.updateMany({
      where: {
        conversationId: { in: eligibleConversationIds },
        NOT: { labels: { array_contains: ['archived'] } },
      },
      data: { isUnread: true },
    });

    await this.updateCachedNewCount();

    return { updated: updated.count };
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
      data: { isUnread: false, labels: ['archived'] as unknown as Prisma.InputJsonValue },
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
      data: { isUnread: true, labels: [] as unknown as Prisma.InputJsonValue },
    });

    await this.updateCachedNewCount();

    return { updated: updated.count };
  }

  private async updateCachedNewCount(): Promise<void> {
    const newCount = await this.prisma.mailConversation.count({
      where: {
        isUnread: true,
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
