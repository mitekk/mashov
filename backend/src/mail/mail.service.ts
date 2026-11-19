import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import sanitizeHtml = require('sanitize-html');
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MashovHttpClient } from '../session/mashov-http.client';
import type { ConnectionTarget } from '../session/connection-target';
import { ConnectionScopeService } from '../common/connection-scope/connection-scope.service';
import { resolveSchoolLabels } from '../common/school-label';
import { activeConnectionIdsFor } from '../common/student-links';
import { deriveIsUnread } from './unread';

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
    private readonly scope: ConnectionScopeService,
  ) {}

  /**
   * The inbox badge and the three most recent unread conversations.
   *
   * Takes the caller, because the badge is a SUM now. Reading one connection's
   * row was accidentally tenant-safe; summing `{ active: true }` across the
   * whole table is not -- two households each with 5 unread would both have
   * been shown 10.
   */
  async getSummary(userId?: string) {
    const ownScope = await this.householdMailScope(userId);

    const [localNewConversations, household, recentConversations, lastSync] = await Promise.all([
      this.prisma.mailConversation.count({
        where: {
          ...ownScope,
          isUnread: true,
          NOT: { labels: { array_contains: ['archived'] } },
        },
      }),
      // SUMMED, not read from one row. Each connection's cachedNewCount is
      // now its own mailbox's unread count, so the household badge is their
      // total -- reading the most recent connection's row alone would show one
      // school's mail and silently hide the other's.
      this.prisma.householdConnection.aggregate({
        where: { active: true, ...(userId ? { userId } : {}) },
        _sum: { cachedNewCount: true },
        _count: { _all: true },
      }),
      this.prisma.mailConversation.findMany({
        where: {
          ...ownScope,
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

    // `_count` distinguishes "no connections, so fall back to the local
    // count" from "connections whose counts genuinely sum to zero". Without
    // it, _sum is null in both cases and an empty inbox would fall back to a
    // local count that may not be zero.
    const newConversations =
      household._count._all > 0
        ? household._sum.cachedNewCount ?? 0
        : localNewConversations;

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

  async getConversations(
    page: number,
    limit: number,
    filter: 'all' | 'new' | 'archived',
    /** Narrows to one school's mailbox; omitted, every mailbox. */
    schoolId?: string,
    userId?: string,
  ) {
    await this.assertOwnedSchool(schoolId, userId);
    // Two predicates, not one merged object: the household scope is an `OR`
    // and so is nothing in `buildInboxWhere`, so merging them would let one
    // overwrite the other.
    const where: Prisma.MailConversationWhereInput = {
      AND: [await this.householdMailScope(userId), this.buildInboxWhere(filter, schoolId)],
    };
    const [items, total] = await Promise.all([
      this.prisma.mailConversation.findMany({
        where,
        orderBy: { sendTime: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        // Joined rather than resolved per row: the conversation already has
        // the connection, and the inbox shows its label on every line.
        include: {
          connection: { select: { id: true, schoolCode: true, schoolName: true, displayLabel: true } },
        },
      }),
      this.prisma.mailConversation.count({ where }),
    ]);

    const labels = resolveSchoolLabels(
      [
        ...new Map(
          items
            .map((item) => item.connection)
            // Truthy, not `!== null`: Prisma yields null for a missing
            // relation, but a row read without the include yields undefined,
            // and both mean "no school".
            .filter((connection): connection is NonNullable<typeof connection> => Boolean(connection))
            .map((connection) => [connection.id, connection]),
        ).values(),
      ],
    );

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
        // `null` on an unstamped conversation, which the UI reads as no badge.
        schoolId: item.connection?.id ?? null,
        schoolShortLabel: item.connection
          ? labels.get(item.connection.id) ??
            item.connection.schoolName ??
            String(item.connection.schoolCode)
          : null,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async getConversationDetail(conversationId: string, userId?: string) {
    const conversation = await this.prisma.mailConversation.findUnique({
      where: { conversationId },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${conversationId}`);
    }
    await this.assertVisible(conversationId, conversation.householdConnectionId, userId);

    // Check if full messages with body exist in DB
    const existingMessages = await this.prisma.mailMessage.findMany({
      where: { conversationId },
      orderBy: { sendTime: 'asc' },
    });
    const hasRenderableBody = existingMessages.some(
      (msg) => typeof msg.bodyHtmlSanitized === 'string' && msg.bodyHtmlSanitized.trim().length > 0,
    );

    if (!hasRenderableBody) {
      await this.hydrateConversationFromUpstream(conversationId, conversation, userId);
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
    userId?: string,
  ): Promise<DownloadedFile> {
    const conversation = await this.prisma.mailConversation.findUnique({
      where: { conversationId },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${conversationId}`);
    }
    await this.assertVisible(conversationId, conversation.householdConnectionId, userId);

    const referer = `https://web.mashov.info/students/main/mailbox/conversation/${conversationId}`;

    let message = await this.getMessageInConversation(conversationId, messageId);
    if (!message) {
      await this.hydrateConversationFromUpstream(conversationId, conversation, userId);
      message = await this.getMessageInConversation(conversationId, messageId);
    }
    if (!message) throw new NotFoundException(`Message not found: ${messageId}`);

    let attachment = this.findMessageAttachment(message.files, fileId);
    if (!attachment) {
      await this.hydrateConversationFromUpstream(conversationId, conversation, userId);
      const refreshedMessage = await this.getMessageInConversation(conversationId, messageId);
      attachment = this.findMessageAttachment(refreshedMessage?.files, fileId);
    }
    if (!attachment) throw new NotFoundException(`Attachment not found: ${fileId}`);

    // Resolved once for the whole download, including the retry below: the
    // message's own stamp, so a bare messageId is enough and no join is
    // needed.
    //
    // Resolved HERE, and not before the lookups above, because `messageId`
    // comes from the caller and only `conversationId` has been checked against
    // the household. `targetForMessage` reads the message's own stamp and the
    // stamped branch of the fallback takes no caller, so resolving it earlier
    // would decrypt another household's password inside this request on the
    // strength of an id nothing had validated. By this line the message is
    // known to be in a conversation the caller may see.
    const target = await this.scope.targetForMessage(messageId, userId).catch(() =>
      this.scope.targetForConversation(conversationId, userId),
    );

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
        target,
      );
    } catch {
      // Attachment URLs may be short-lived; refresh from upstream and retry once.
      await this.hydrateConversationFromUpstream(conversationId, conversation, userId);
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
        target,
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
      locallyReadThroughAt: Date | null;
      // The household the conversation belongs to, carried down so the
      // messages this fetch writes are stamped the same way. Every caller
      // passes the whole `mailConversation` row, so this costs them nothing.
      householdConnectionId: string | null;
    },
    userId?: string,
  ): Promise<boolean> {
    try {
      const upstream = await this.mashovClient.getForTarget<UpstreamConversationDetail>(
        `/api/mail/conversations/${conversationId}`,
        await this.scope.targetForConversation(conversationId, userId),
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
      locallyReadThroughAt: Date | null;
      householdConnectionId: string | null;
    },
    upstream: UpstreamConversationDetail,
  ): Promise<void> {
    await this.prisma.mailConversation.update({
      where: { conversationId },
      data: {
        subject: upstream.subject ?? fallbackConversation.subject,
        senderNamePreview: upstream.messages?.[0]?.senderName ?? fallbackConversation.senderNamePreview,
        sendTime: upstream.sendTime ? new Date(upstream.sendTime) : fallbackConversation.sendTime,
        // The same derivation as the sync walk, so opening a conversation honours the
        // local read override instead of restoring unread from an upstream flag that
        // never learned the user read it. See src/mail/unread.ts.
        isUnread: deriveIsUnread(
          { isNew: upstream.isNew ?? fallbackConversation.isUnread, messages: upstream.messages },
          fallbackConversation.locallyReadThroughAt,
        ),
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

        // The conversation's own stamp, not the resolved upstream target: the
        // unlink in ConnectionService deletes messages and conversations as one
        // transaction and was written against message and conversation stamps
        // being identical. Messages written here used to carry no stamp at all,
        // so a NULL-stamped message under a stamped conversation made
        // mailConversation.deleteMany violate mail_message_conversationId_fkey
        // -- the same 500 on every retry (R2).
        const stamp = fallbackConversation.householdConnectionId;

        return this.prisma.mailMessage.upsert({
          where: { messageId: msg.messageId },
          create: {
            messageId: msg.messageId,
            conversationId: msg.conversationId || conversationId,
            householdConnectionId: stamp,
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
            // Self-heal: rows written before this fix are NULL-stamped, and a
            // re-fetch is the only thing that reaches them. Written only when
            // the conversation itself is stamped, so an unstamped conversation
            // cannot un-stamp a message a sync walk already attributed.
            ...(stamp ? { householdConnectionId: stamp } : {}),
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

  /**
   * Restricts a mail read to the caller's own mailboxes.
   *
   * Unstamped conversations are included, as everywhere else: NULL means
   * "ownership unknown", and excluding them would empty the inbox on a
   * deployment that has not re-synced since the ownership migration.
   *
   * No caller means no filter. Every mail route runs behind `AppSessionGuard`
   * and none is `@Public()`, so on real traffic there is always a caller; the
   * unscoped path is for a server-side caller with no user to speak of, and
   * today the only thing that drives it is `tests/integration/api.test.ts`,
   * whose requests are unauthenticated. Nothing in the crons or the digest
   * reaches `MailService` at all -- `MailCountsTask` and `MailInboxTask` own
   * their own queries. Said plainly here because an optional `userId` whose
   * absence means "whole table" is only safe while that stays true, and
   * R3-R6 are about to add callers.
   */
  private async householdMailScope(userId?: string): Promise<Prisma.MailConversationWhereInput> {
    const own = await this.ownConnectionIds(userId);
    if (own === null) return {};

    return {
      OR: [{ householdConnectionId: { in: own } }, { householdConnectionId: null }],
    };
  }

  /**
   * The caller's active connection ids, or `null` when there is no caller.
   *
   * `null` is not an empty list: it means "unscoped", for a caller-less
   * server-side read. An empty array is a real caller who has connected no
   * school, and admits only the unstamped rows.
   *
   * Delegates to `activeConnectionIdsFor` rather than issuing its own query,
   * so mail's notion of "the caller's connections" is the same one the student
   * visibility edge uses and the two cannot drift.
   */
  private async ownConnectionIds(userId?: string): Promise<string[] | null> {
    if (!userId) return null;
    return activeConnectionIdsFor(this.prisma, userId);
  }

  /**
   * Whether a caller may act on a row with this stamp.
   *
   * NULL is admitted, as it is everywhere else on this branch: it means
   * "ownership unknown, re-stamp on the next walk", and excluding it would
   * empty the inbox on a deployment that has not re-synced since the
   * ownership migration.
   *
   * For a MUTATION that rule has a consequence the read case does not, and it
   * is deliberate rather than overlooked: on a box with more than one active
   * connection -- where the ownership backfill refused and unstamped rows
   * therefore exist -- either household may archive or re-flag an
   * unattributed row, and the other household sees that write. Upstream is
   * still safe, because the call goes out under the acting household's own
   * account. The alternative, refusing NULL on a mutation, makes a row the
   * parent can see and cannot act on, and the next inbox walk stamps it
   * within seven minutes. Recorded as a Minor in
   * docs/plans/merged-household-access-followups.md.
   */
  private canSee(householdConnectionId: string | null, own: string[] | null): boolean {
    if (own === null) return true;
    if (householdConnectionId === null) return true;
    return own.includes(householdConnectionId);
  }

  /** A conversation the caller may not act on is a 404, never a 403. */
  private async assertVisible(
    conversationId: string,
    householdConnectionId: string | null,
    userId?: string,
  ): Promise<void> {
    if (this.canSee(householdConnectionId, await this.ownConnectionIds(userId))) return;
    // The same message as the not-found case on purpose: a distinguishable
    // answer would confirm the id names a real conversation.
    throw new NotFoundException(`Conversation not found: ${conversationId}`);
  }

  /**
   * The requested ids the caller may act on, in the caller's order, with
   * their stamps.
   *
   * A foreign id is filtered out silently and the mutation reports the honest
   * `updated` count -- which is already how an id with no local row at all
   * behaves, since routing drops a row it has no stamp for. What matters is
   * that no local write happens for it and, above all, that no upstream call
   * goes out under the other household's credentials.
   *
   * With no caller every id is kept, including ids with no local row: that is
   * the list the unscoped `updateMany` was given before this scoping existed,
   * and the caller-less path must keep behaving exactly as it did.
   */
  private async visibleConversations(
    conversationIds: string[],
    userId?: string,
  ): Promise<Array<{ conversationId: string; householdConnectionId: string | null }>> {
    if (conversationIds.length === 0) return [];
    const own = await this.ownConnectionIds(userId);

    const rows = await this.prisma.mailConversation.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { conversationId: true, householdConnectionId: true },
    });
    const stampByConversation = new Map(
      rows.map((row) => [row.conversationId, row.householdConnectionId ?? null]),
    );

    const visible: Array<{ conversationId: string; householdConnectionId: string | null }> = [];
    for (const conversationId of conversationIds) {
      if (!stampByConversation.has(conversationId)) {
        if (own === null) visible.push({ conversationId, householdConnectionId: null });
        continue;
      }
      const householdConnectionId = stampByConversation.get(conversationId) ?? null;
      if (this.canSee(householdConnectionId, own)) {
        visible.push({ conversationId, householdConnectionId });
      }
    }
    return visible;
  }

  /**
   * A `schoolId` belonging to another household is a 404, not a 403.
   *
   * The same reasoning as `SyncController.resolveConnections`: a 403 would
   * confirm the id exists. No caller means no check, which keeps the
   * server-side paths unchanged.
   */
  private async assertOwnedSchool(schoolId?: string, userId?: string): Promise<void> {
    if (!schoolId || !userId) return;

    const owned = await this.prisma.householdConnection.findFirst({
      where: { id: schoolId, userId, active: true },
      select: { id: true },
    });
    if (owned) return;

    throw new NotFoundException({
      error: {
        code: 'NOT_FOUND',
        message: 'No such school is connected to this account',
        details: [],
      },
    });
  }

  private buildInboxWhere(
    filter: 'all' | 'new' | 'archived',
    schoolId?: string,
  ): Prisma.MailConversationWhereInput {
    const school = schoolId ? { householdConnectionId: schoolId } : {};
    if (filter === 'archived') {
      return { ...school, labels: { array_contains: ['archived'] } };
    }
    return {
      ...school,
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
    target: ConnectionTarget,
  ): Promise<DownloadedFile> {
    const uniqueCandidates = Array.from(new Set(
      candidates
        .map((candidate) => this.normalizeUpstreamPath(candidate))
        .filter((candidate): candidate is string => Boolean(candidate)),
    ));

    let lastError: string | null = null;
    for (const candidate of uniqueCandidates) {
      try {
        return await this.downloadBinaryFromUpstream(
          candidate,
          referer,
          fallbackFileName,
          target,
        );
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
    target: ConnectionTarget,
  ): Promise<DownloadedFile> {
    const response = await this.mashovClient.getResponseForTarget<ArrayBuffer>(
      pathOrUrl,
      target,
      {
        responseType: 'arraybuffer',
        headers: {
          Referer: referer,
        },
      },
    );

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

  async markConversationsRead(conversationIds: string[], userId?: string) {
    const visible = await this.visibleConversations(conversationIds, userId);
    const visibleIds = visible.map((row) => row.conversationId);
    if (visibleIds.length === 0) return { updated: 0 };

    await this.prisma.mailConversation.updateMany({
      where: { conversationId: { in: visibleIds } },
      data: { isUnread: false, locallyMarkedUnreadAt: null },
    });

    // This is the only mail mutation with no upstream call -- markUnread, archive and
    // unarchive all PUT to Mashov, but no markAsRead endpoint is documented. Upstream
    // therefore keeps reporting the message unread, and without a record of the user's
    // action the next inbox walk would restore isUnread: true and the badge would
    // visibly bounce back within 7 minutes.
    //
    // The watermark is a stored message sendTime, never now(): Mashov timestamps are
    // naive and parsed in the container's zone, so a UTC now() would sit behind the
    // instants it is compared against and clear the override for mail read within
    // hours of arriving -- the common case. Comparing sendTimes against sendTimes
    // keeps both sides in one parsing domain.
    const [conversations, messages] = await Promise.all([
      this.prisma.mailConversation.findMany({
        where: { conversationId: { in: visibleIds } },
        select: { conversationId: true, sendTime: true },
      }),
      this.prisma.mailMessage.findMany({
        where: { conversationId: { in: visibleIds } },
        select: { conversationId: true, sendTime: true },
      }),
    ]);
    const newestByConversationId = new Map<string, Date>();
    // Seed from the conversation's own sendTime so a conversation whose messages are not
    // stored yet still gets a watermark -- otherwise mark-read bounces back on exactly
    // those rows. It is a Mashov-parsed timestamp like the message sendTimes that
    // override it below, so both stay in one parsing domain.
    for (const conversation of conversations) {
      newestByConversationId.set(conversation.conversationId, conversation.sendTime);
    }
    for (const message of messages) {
      const current = newestByConversationId.get(message.conversationId);
      if (!current || message.sendTime.getTime() > current.getTime()) {
        newestByConversationId.set(message.conversationId, message.sendTime);
      }
    }
    for (const [conversationId, locallyReadThroughAt] of newestByConversationId) {
      await this.prisma.mailConversation.updateMany({
        where: { conversationId },
        data: { locallyReadThroughAt },
      });
    }

    await this.updateCachedNewCount(this.touchedConnectionIds(visible));

    return { updated: visibleIds.length };
  }

  async markUnread(conversationIds: string[], userId?: string) {
    const eligibleConversations = await this.prisma.mailConversation.findMany({
      where: {
        conversationId: { in: conversationIds },
        NOT: { labels: { array_contains: ['archived'] } },
      },
      select: { conversationId: true },
    });
    const visible = await this.visibleConversations(
      eligibleConversations.map((item) => item.conversationId),
      userId,
    );
    const eligibleConversationIds = visible.map((row) => row.conversationId);

    if (eligibleConversationIds.length === 0) {
      return { updated: 0 };
    }

    // An id list from the client can span schools, and one upstream call
    // cannot carry both: Mashov authenticates per school, so a mixed list is
    // one request per connection with its own subset. A failure on one
    // connection must not stop the other's.
    await this.forEachConnectionSubset(
      visible,
      'markAsUnread',
      (subset, target) =>
        this.mashovClient.putForTarget('/api/mail/conversations/markAsUnread', subset, target, {
          headers: { Referer: 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
        }),
      userId,
    );

    const updated = await this.prisma.mailConversation.updateMany({
      where: {
        conversationId: { in: eligibleConversationIds },
        NOT: { labels: { array_contains: ['archived'] } },
      },
      // Clear the local read override: the user is explicitly undoing it. Record the
      // request so the reconciliation sweep leaves this row alone -- for a conversation
      // upstream no longer returns, this row is the only record of what the user wanted.
      data: { isUnread: true, locallyReadThroughAt: null, locallyMarkedUnreadAt: new Date() },
    });

    await this.updateCachedNewCount(this.touchedConnectionIds(visible));

    return { updated: updated.count };
  }

  async archive(conversationIds: string[], userId?: string) {
    const visible = await this.visibleConversations(conversationIds, userId);
    const visibleIds = visible.map((row) => row.conversationId);
    if (visibleIds.length === 0) return { updated: 0 };

    await this.forEachConnectionSubset(
      visible,
      'archive',
      (subset, target) =>
        this.mashovClient.putForTarget('/api/mail/conversations/move/archive', subset, target, {
          headers: { Referer: 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
        }),
      userId,
    );

    const updated = await this.prisma.mailConversation.updateMany({
      where: { conversationId: { in: visibleIds } },
      data: {
        isUnread: false,
        labels: ['archived'] as unknown as Prisma.InputJsonValue,
        locallyMarkedUnreadAt: null,
      },
    });

    await this.updateCachedNewCount(this.touchedConnectionIds(visible));

    return { updated: updated.count };
  }

  async unarchive(conversationIds: string[], userId?: string) {
    // No unarchive endpoint is documented in apis/; markAsUnread is the closest upstream
    // lever we have. It answers with the number of conversations it actually marked
    // (apis/put-api-mail-conversations-markAsUnread.md), which is what tells us whether
    // the unread state we are about to store locally is real.
    // Both the upstream confirmation and the local write are per connection.
    // Collapsing them to one boolean would let one school's failed call
    // suppress the other school's *confirmed* unread -- the two mailboxes know
    // nothing about each other, and their answers must not be mixed.
    const visible = await this.visibleConversations(conversationIds, userId);
    const visibleIds = visible.map((row) => row.conversationId);
    if (visibleIds.length === 0) return { updated: 0 };

    const grouped = this.groupByConnection(visible);
    let totalUpdated = 0;

    for (const [connectionId, subset] of grouped) {
      let markedUnreadUpstream = false;
      try {
        const target = connectionId
          ? await this.scope.targetFor(connectionId)
          : await this.scope.targetForConversation(subset[0], userId);
        const marked = await this.mashovClient.putForTarget<unknown>(
          '/api/mail/conversations/markAsUnread',
          subset,
          target,
          {
            headers: { Referer: 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
          },
        );
        markedUnreadUpstream = typeof marked === 'number' ? marked > 0 : true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Upstream unarchive(markAsUnread) failed for connection ${connectionId ?? 'unstamped'}: ${msg}; updating DB only`,
        );
      }

      const updated = await this.prisma.mailConversation.updateMany({
        where: { conversationId: { in: subset } },
        data: {
          labels: [] as unknown as Prisma.InputJsonValue,
          locallyReadThroughAt: null,
          // Only claim unread when upstream confirms it. conv.isNew is the read-state
          // authority, and a conversation archived while read is read -- inventing unread
          // here would inflate the badge, which is the bug this branch exists to fix. If
          // the call failed, the next walk settles the real state within 7 minutes.
          ...(markedUnreadUpstream
            ? { isUnread: true, locallyMarkedUnreadAt: new Date() }
            : {}),
        },
      });
      totalUpdated += updated.count;
    }

    await this.updateCachedNewCount(this.touchedConnectionIds(visible));

    return { updated: totalUpdated };
  }

  /**
   * Split acted-on rows by the connection that owns them.
   *
   * An id list from the client can span schools, and one upstream call cannot
   * carry both: Mashov authenticates per school, so acting on a mixed list
   * means one request per connection with its own subset. Unstamped rows group
   * under `null` rather than being dropped -- before the backfill has run
   * every row is unstamped, and dropping them would make archive silently do
   * nothing.
   *
   * Takes the rows `visibleConversations` approved, rather than re-reading
   * them: the ownership decision and the routing decision have to be made from
   * ONE read of the stamp. Re-reading left a window in which `MailInboxTask`,
   * which runs every seven minutes, could stamp a row between the two queries
   * -- and the id would then route to the connection that had just claimed it,
   * through `targetFor`, which takes no caller and would hand back that
   * household's decrypted password.
   */
  private groupByConnection(
    rows: Array<{ conversationId: string; householdConnectionId: string | null }>,
  ): Map<string | null, string[]> {
    const grouped = new Map<string | null, string[]>();
    // The caller's order, not a query's, so each subset keeps the order the
    // user acted in.
    for (const row of rows) {
      const bucket = grouped.get(row.householdConnectionId);
      if (bucket) bucket.push(row.conversationId);
      else grouped.set(row.householdConnectionId, [row.conversationId]);
    }
    return grouped;
  }

  /**
   * The distinct mailboxes a set of acted-on rows belongs to.
   *
   * An unstamped row contributes nothing, which is behaviour-preserving: no
   * connection owns it, so its unread state was never in any
   * `cachedNewCount`, and the old table-wide sweep did not move a count for it
   * either.
   */
  private touchedConnectionIds(
    rows: Array<{ householdConnectionId: string | null }>,
  ): string[] {
    return [
      ...new Set(
        rows
          .map((row) => row.householdConnectionId)
          .filter((id): id is string => id !== null),
      ),
    ];
  }

  /**
   * Run one upstream call per owning connection, each with only its own ids.
   *
   * Per-connection failure is warn-and-continue, as the single-connection
   * version was: the local write still happens and the next inbox walk
   * settles the real state within seven minutes. What must not happen is one
   * school's failure skipping the other school's call.
   */
  private async forEachConnectionSubset(
    rows: Array<{ conversationId: string; householdConnectionId: string | null }>,
    label: string,
    call: (subset: string[], target: ConnectionTarget) => Promise<unknown>,
    userId?: string,
  ): Promise<void> {
    const grouped = this.groupByConnection(rows);

    for (const [connectionId, subset] of grouped) {
      try {
        const target = connectionId
          ? await this.scope.targetFor(connectionId)
          : await this.scope.targetForConversation(subset[0], userId);
        await call(subset, target);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Upstream ${label} failed for connection ${connectionId ?? 'unstamped'}: ${msg}; updating DB only`,
        );
      }
    }
  }

  /**
   * Recompute `cachedNewCount` per connection, each from its own mailbox.
   *
   * MailCountsTask writes the same number every five minutes and MailInboxTask
   * after every walk, so this has to agree with them exactly or a user action
   * and the cron fight over one number. Unscoped -- one count written to one
   * arbitrary row -- is what made the badge report the union of both schools.
   *
   * Takes the connections the action actually touched -- which may span
   * schools, so it is a list rather than one id. It used to be called with no
   * argument and then refreshed every active connection in the database, so
   * one parent archiving one conversation rewrote every other household's
   * count too: write amplification and a cross-tenant write for a number that
   * could not have changed.
   */
  private async updateCachedNewCount(connectionIds: string[]): Promise<void> {
    for (const connection of connectionIds.map((id) => ({ id }))) {
      await this.prisma.householdConnection.update({
        where: { id: connection.id },
        data: {
          cachedNewCount: await this.prisma.mailConversation.count({
            where: {
              householdConnectionId: connection.id,
              isUnread: true,
              NOT: { labels: { array_contains: ['archived'] } },
            },
          }),
        },
      });
    }
  }
}
