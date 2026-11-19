import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';

// Prisma's InputJsonValue is not re-exported from the @prisma/client default entrypoint in v5.
// Defining a compatible local alias avoids the broken namespace resolution.
type InputJsonValue = string | number | boolean | InputJsonValue[] | { [key: string]: InputJsonValue | null };
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import { deriveIsUnread } from '../../mail/unread';

interface MashovMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  subject: string;
  lastUpdate: string;
  sendTime: string;
  folder: number;
  isNew: boolean;
  isDeleted: boolean;
  sendOnBehalf: boolean;
  sendViaEmail: boolean;
  sendViaSms: boolean;
  preventReply: boolean;
  sentViaEmail: boolean;
  sentViaSms: boolean;
}

interface MashovConversation {
  conversationId: string;
  subject: string;
  sendTime: string;
  isNew: boolean;
  hasDrafts: boolean;
  hasAttachments: boolean;
  preventReply: boolean;
  labels: unknown[];
  messages: MashovMessage[];
}

@Injectable()
export class MailInboxTask {
  private readonly logger = new Logger(MailInboxTask.name);
  public static readonly SOURCE = 'mail_inbox';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  @Cron('*/7 * * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  /**
   * Why each gate: a sweep that fires on an incomplete walk clears unread on rows the
   * walk simply never reached.
   *
   * The gate that used to refuse any run above one active connection is gone.
   * It existed because `mail_conversation` had no owner column, so connection
   * A's sweep would clear unread on B's rows every seven minutes and back
   * again. The rows now carry `householdConnectionId` and the sweep is scoped
   * to it, so the two row sets are disjoint and the sweep is safe per
   * connection. Two narrower gates below replace it.
   */
  private sweepSkipReason(gates: {
    failedCount: number;
    pageCount: number;
    archivePageCount: number;
    maxPages: number;
    sweepEnabled: boolean;
    foreignStampedCount: number;
    isSharedSession: boolean;
  }): string | null {
    // The kill switch, so a wrong badge is one environment variable away from
    // frozen rather than a rollback. Checked first: if it is off, nothing else
    // about this run matters.
    if (!gates.sweepEnabled) return 'MAIL_SWEEP_ENABLED is not true';
    if (gates.failedCount > 0) return `${gates.failedCount} item failure(s) in this run`;
    // An empty inbox response is indistinguishable from a soft failure: a 2xx with `[]`
    // is also what a referer-gated endpoint, an expired session, or a schoolYear with no
    // mail returns. A hard failure throws and never reaches here, but this does, and
    // sweeping on it would clear isUnread on every row in the table because none was
    // refreshed. The cost of skipping is that a genuinely empty inbox leaves its orphans
    // unreconciled for one cycle; the cost of not skipping is a badge that reads zero.
    if (gates.pageCount === 0) return 'inbox walk returned no conversations';
    if (gates.pageCount >= gates.maxPages) return 'inbox walk hit the page cap';
    if (gates.archivePageCount >= gates.maxPages) return 'archive walk hit the page cap';
    // A shared env-session run owns the NULL-stamped rows only. If stamped rows
    // exist, a per-connection walk is also running, and this run has no idea
    // what that walk refreshed -- its own `lastFetchedAt < runStartedAt` test
    // would be answering about somebody else's mailbox.
    if (gates.isSharedSession && gates.foreignStampedCount > 0) {
      return 'shared-session run on a connection-scoped mail table';
    }
    // There is deliberately NO "unstamped rows present" gate.
    //
    // An earlier version had one, reasoning that it would clear itself within a
    // cycle because both walk loops re-stamp in their `update` branch. That is
    // only true for rows upstream still returns -- and the rows this sweep
    // exists for are precisely the ones upstream has STOPPED returning, which
    // no walk can ever re-stamp. One such orphan would have disabled
    // reconciliation for every connection permanently, bringing back the
    // inflated badge with nothing but a debug line to show for it.
    //
    // It was never needed anyway: the sweep's own `where` is
    // `householdConnectionId: conn.id`, which an unattributed row cannot
    // match. The scoping is the protection; the gate only added a way to get
    // stuck.
    return null;
  }

  /**
   * The sweep is on unless explicitly disabled.
   *
   * Default-true because reconciliation is the thing that keeps the badge
   * honest; the switch exists so a bad badge can be frozen in place while it
   * is diagnosed, not as an opt-in.
   */
  private sweepEnabled(): boolean {
    const raw = process.env.MAIL_SWEEP_ENABLED;
    if (raw === undefined || raw.trim().length === 0) return true;
    return raw.trim().toLowerCase() !== 'false';
  }

  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: {
        userId: { not: null },
        active: true,
        ...(context.connectionId ? { id: context.connectionId } : {}),
      },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
    });
    const useSharedSession = !context.connectionId && connections.length === 0;

    // Determine which connections to sync: all user-owned ones, or fall back to shared session
    const connectionList = useSharedSession ? [null] : connections;
    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let totalFailedCount = 0;
    const allErrorMessages: string[] = [];

    for (const conn of connectionList) {
      const source = conn ? `${MailInboxTask.SOURCE}:${conn.id}` : MailInboxTask.SOURCE;
      const syncRun = await this.syncRunService.openRun(source, conn?.id ?? context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;
      let failedCount = 0;
      let pageCount = 0;
      let archivePageCount = 0;
      const errorMessages: string[] = [];
      // The sweep below compares against the run's start, not a hardcoded interval:
      // both walks refresh lastFetchedAt on every row upstream still returns.
      const runStartedAt = syncRun.startedAt;
      const pageSize = 50;
      const maxPages = 200;

      let password: string | undefined;
      if (conn) {
        try {
          password = this.encryptionService.decrypt(conn.encryptedPassword);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Mail inbox: failed to decrypt password for connection ${conn.id}: ${msg}`);
          await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
          totalFailedCount++;
          continue;
        }
      }

    try {
      for (let page = 0; page < maxPages; page++) {
        const skip = page * pageSize;
        const conversations = conn && password
          ? await this.mashovClient.getForConnection<MashovConversation[]>(
              `/api/mail/inbox/conversations?skip=${skip}&take=${pageSize}`,
              conn.id,
              conn.schoolCode,
              conn.schoolYear,
              conn.username,
              password,
              { headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/inbox' } },
            )
          : await this.mashovClient.get<MashovConversation[]>(
              `/api/mail/inbox/conversations?skip=${skip}&take=${pageSize}`,
              {
                headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
              },
            );

        if (conversations.length === 0) break;
        pageCount++;
        fetchedCount += conversations.length;

        // One query per page for the page's local read overrides, rather than one per
        // conversation. deriveIsUnread needs them to avoid undoing a mark-read that
        // upstream never learned about.
        const overrideRows = await this.prisma.mailConversation.findMany({
          where: { conversationId: { in: conversations.map((conv) => conv.conversationId) } },
          select: { conversationId: true, locallyReadThroughAt: true },
        });
        const readThroughByConversationId = new Map(
          overrideRows.map((row) => [row.conversationId, row.locallyReadThroughAt]),
        );

        for (const conv of conversations) {
          try {
            const senderName = conv.messages[0]?.senderName ?? null;
            const sendTime = new Date(conv.sendTime);
            // conv.isNew is the read state; the derivation only adds the local read
            // override, which upstream cannot know about. See src/mail/unread.ts.
            const isUnread = deriveIsUnread(
              conv,
              readThroughByConversationId.get(conv.conversationId) ?? null,
            );

            await this.prisma.mailConversation.upsert({
              where: { conversationId: conv.conversationId },
              create: {
                conversationId: conv.conversationId,
                subject: conv.subject,
                senderNamePreview: senderName,
                sendTime,
                isUnread,
                hasDrafts: conv.hasDrafts,
                hasAttachments: conv.hasAttachments,
                preventReply: conv.preventReply,
                labels: (conv.labels ?? []) as InputJsonValue,
                rawPayload: conv as unknown as InputJsonValue,
                lastFetchedAt: new Date(),
                householdConnectionId: conn ? conn.id : null,
              },
              update: {
                subject: conv.subject,
                senderNamePreview: senderName,
                sendTime,
                isUnread,
                hasDrafts: conv.hasDrafts,
                hasAttachments: conv.hasAttachments,
                preventReply: conv.preventReply,
                labels: (conv.labels ?? []) as InputJsonValue,
                rawPayload: conv as unknown as InputJsonValue,
                lastFetchedAt: new Date(),
                // Only when there IS a connection: a shared-session walk must not
                // blank a stamp a per-connection walk already set.
                ...(conn ? { householdConnectionId: conn.id } : {}),
              },
            });

            // Upsert message metadata (preview, no body)
            for (const msg of conv.messages) {
              await this.prisma.mailMessage.upsert({
                where: { messageId: msg.messageId },
                create: {
                  messageId: msg.messageId,
                  conversationId: msg.conversationId,
                  senderId: msg.senderId,
                  senderName: msg.senderName,
                  subject: msg.subject,
                  sendTime: new Date(msg.sendTime),
                  isNew: msg.isNew,
                  preventReply: msg.preventReply,
                  sentViaEmail: msg.sentViaEmail,
                  sentViaSms: msg.sentViaSms,
                  rawPayload: msg as unknown as InputJsonValue,
                  householdConnectionId: conn ? conn.id : null,
                },
                update: {
                  senderName: msg.senderName,
                  subject: msg.subject,
                  sendTime: new Date(msg.sendTime),
                  isNew: msg.isNew,
                  preventReply: msg.preventReply,
                  sentViaEmail: msg.sentViaEmail,
                  sentViaSms: msg.sentViaSms,
                  rawPayload: msg as unknown as InputJsonValue,
                  // Only when there IS a connection: a shared-session walk must not
                  // blank a stamp a per-connection walk already set.
                  ...(conn ? { householdConnectionId: conn.id } : {}),
                },
              });
            }

            upsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert conversation ${conv.conversationId}: ${msg}`);
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        if (conversations.length < pageSize) break;
      }

      // Sync archive folder — Mashov returns archived conversations without labels,
      // so we force labels: ['archived'] and isUnread: false (archived = always read).
      for (let page = 0; page < maxPages; page++) {
        const skip = page * pageSize;
        const archivedConversations = conn && password
          ? await this.mashovClient.getForConnection<MashovConversation[]>(
              `/api/mail/archive/conversations?skip=${skip}&take=${pageSize}`,
              conn.id,
              conn.schoolCode,
              conn.schoolYear,
              conn.username,
              password,
              { headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/archive' } },
            )
          : await this.mashovClient.get<MashovConversation[]>(
              `/api/mail/archive/conversations?skip=${skip}&take=${pageSize}`,
              {
                headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/archive' },
              },
            );

        if (archivedConversations.length === 0) break;
        archivePageCount++;
        fetchedCount += archivedConversations.length;

        for (const conv of archivedConversations) {
          try {
            const senderName = conv.messages[0]?.senderName ?? null;
            const sendTime = new Date(conv.sendTime);

            await this.prisma.mailConversation.upsert({
              where: { conversationId: conv.conversationId },
              create: {
                conversationId: conv.conversationId,
                subject: conv.subject,
                senderNamePreview: senderName,
                sendTime,
                isUnread: false,
                hasDrafts: conv.hasDrafts,
                hasAttachments: conv.hasAttachments,
                preventReply: conv.preventReply,
                labels: ['archived'] as InputJsonValue,
                rawPayload: conv as unknown as InputJsonValue,
                lastFetchedAt: new Date(),
                householdConnectionId: conn ? conn.id : null,
              },
              update: {
                subject: conv.subject,
                senderNamePreview: senderName,
                sendTime,
                isUnread: false,
                hasDrafts: conv.hasDrafts,
                hasAttachments: conv.hasAttachments,
                preventReply: conv.preventReply,
                labels: ['archived'] as InputJsonValue,
                rawPayload: conv as unknown as InputJsonValue,
                lastFetchedAt: new Date(),
                // Only when there IS a connection: a shared-session walk must not
                // blank a stamp a per-connection walk already set.
                ...(conn ? { householdConnectionId: conn.id } : {}),
              },
            });

            for (const msg of conv.messages) {
              await this.prisma.mailMessage.upsert({
                where: { messageId: msg.messageId },
                create: {
                  messageId: msg.messageId,
                  conversationId: msg.conversationId,
                  senderId: msg.senderId,
                  senderName: msg.senderName,
                  subject: msg.subject,
                  sendTime: new Date(msg.sendTime),
                  isNew: false,
                  preventReply: msg.preventReply,
                  sentViaEmail: msg.sentViaEmail,
                  sentViaSms: msg.sentViaSms,
                  rawPayload: msg as unknown as InputJsonValue,
                  householdConnectionId: conn ? conn.id : null,
                },
                update: {
                  senderName: msg.senderName,
                  subject: msg.subject,
                  sendTime: new Date(msg.sendTime),
                  isNew: false,
                  preventReply: msg.preventReply,
                  sentViaEmail: msg.sentViaEmail,
                  sentViaSms: msg.sentViaSms,
                  rawPayload: msg as unknown as InputJsonValue,
                  // Only when there IS a connection: a shared-session walk must not
                  // blank a stamp a per-connection walk already set.
                  ...(conn ? { householdConnectionId: conn.id } : {}),
                },
              });
            }

            upsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert archived conversation ${conv.conversationId}: ${msg}`);
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        if (archivedConversations.length < pageSize) break;
      }

      // Reconciliation. Nothing else ever clears a MailConversation, so a conversation
      // deleted upstream -- or moved to a folder that is neither inbox nor archive --
      // keeps isUnread: true and is counted forever. Derivation cannot fix those: their
      // rawPayload is frozen at whatever upstream last said, so the derived value is
      // frozen with it. Anything not refreshed by this run is such an orphan by
      // definition. Clear isUnread, never delete the row: MailMessage.conversationId
      // has a foreign key to it, and clearing is enough for both the badge and the list.
      // One indexed COUNT, and only on the shared-session path. See
      // sweepSkipReason for why a connection-scoped run needs no such check.
      const foreignStampedCount = conn
        ? 0
        : await this.prisma.mailConversation.count({
            where: { householdConnectionId: { not: null } },
          });

      const sweepSkipReason = this.sweepSkipReason({
        failedCount,
        pageCount,
        archivePageCount,
        maxPages,
        sweepEnabled: this.sweepEnabled(),
        foreignStampedCount,
        isSharedSession: conn === null,
      });
      let sweptCount = 0;
      if (sweepSkipReason === null) {
        const swept = await this.prisma.mailConversation.updateMany({
          where: {
            // The column that makes this safe. `lastFetchedAt < runStartedAt`
            // is only a sound orphan test when every row it can match was
            // refreshable by THIS walk -- which is true exactly because the
            // row sets are now disjoint per connection.
            householdConnectionId: conn ? conn.id : null,
            isUnread: true,
            lastFetchedAt: { lt: runStartedAt },
            // An orphan the user explicitly marked unread is their decision, not drift.
            locallyMarkedUnreadAt: null,
          },
          data: { isUnread: false },
        });
        sweptCount = swept.count;
      }

      // MailCountsTask only writes cachedNewCount every 5 minutes, so without this the
      // badge would lag the rows this run just corrected. Same query and same target
      // selection as that task.
      //
      // The count is this connection's own mailbox, written to its own row:
      // the badge sums these rows, so an unscoped count written into each one
      // reported the union once per school. A shared-session run writes
      // nothing. It owns the NULL-stamped rows but has no row of its own, and
      // the old `findFirst({ active: true })` fallback put its count into an
      // arbitrary household -- a cross-household write, and under R15's rule
      // a double count, since the reader now adds the unattributed rows once
      // itself (`unreadBadge`).
      if (conn) {
        await this.prisma.householdConnection.update({
          where: { id: conn.id },
          data: {
            cachedNewCount: await this.prisma.mailConversation.count({
              where: {
                householdConnectionId: conn.id,
                isUnread: true,
                NOT: { labels: { array_contains: ['archived'] } },
              },
            }),
          },
        });
      }

      await this.syncRunService.closeRun(syncRun.id, 'success', {
        fetchedCount,
        updatedCount: upsertCount,
      });
      if (pageCount === maxPages) {
        this.logger.warn(
          `Mail inbox sync reached maxPages=${maxPages}; there may be more conversations upstream`,
        );
      }
      this.logger.debug(
        `Mail inbox sync (conn=${conn?.id ?? 'shared'}): pages=${pageCount} fetched=${fetchedCount} ` +
          `upserted=${upsertCount} ` +
          (sweepSkipReason === null
            ? `swept=${sweptCount}`
            : `sweep skipped (${sweepSkipReason})`),
      );
      totalFetchedCount += fetchedCount;
      totalUpsertCount += upsertCount;
      totalFailedCount += failedCount;
      allErrorMessages.push(...errorMessages);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Mail inbox sync failed (conn=${conn?.id ?? 'shared'}): ${msg}`);
      await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
      totalFailedCount += failedCount + 1;
      allErrorMessages.push(...errorMessages, msg);
    }
    } // end connection loop

    return {
      status: totalFailedCount > 0 ? 'failed' : 'success',
      summary: {
        fetchedCount: totalFetchedCount,
        createdCount: 0,
        updatedCount: totalUpsertCount,
        failedCount: totalFailedCount,
      },
      errorMessages: allErrorMessages.slice(0, 10),
    };
  }
}
