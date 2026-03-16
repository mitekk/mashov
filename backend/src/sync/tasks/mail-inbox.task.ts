import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncTaskRunResult } from '../sync.types';

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

  async execute(): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: { userId: { not: null }, active: true },
    });
    const useSharedSession = connections.length === 0;

    // Determine which connections to sync: all user-owned ones, or fall back to shared session
    const connectionList = useSharedSession ? [null] : connections;

    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let totalFailedCount = 0;
    const allErrorMessages: string[] = [];

    for (const conn of connectionList) {
      const source = conn ? `${MailInboxTask.SOURCE}:${conn.id}` : MailInboxTask.SOURCE;
      const syncRun = await this.syncRunService.openRun(source);
      let fetchedCount = 0;
      let upsertCount = 0;
      let failedCount = 0;
      let pageCount = 0;
      const errorMessages: string[] = [];
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

        for (const conv of conversations) {
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
                isUnread: conv.isNew,
                hasDrafts: conv.hasDrafts,
                hasAttachments: conv.hasAttachments,
                preventReply: conv.preventReply,
                labels: (conv.labels ?? []) as import('@prisma/client').Prisma.InputJsonValue,
                rawPayload: conv as unknown as import('@prisma/client').Prisma.InputJsonValue,
                lastFetchedAt: new Date(),
              },
              update: {
                subject: conv.subject,
                senderNamePreview: senderName,
                sendTime,
                isUnread: conv.isNew,
                hasDrafts: conv.hasDrafts,
                hasAttachments: conv.hasAttachments,
                preventReply: conv.preventReply,
                labels: (conv.labels ?? []) as import('@prisma/client').Prisma.InputJsonValue,
                rawPayload: conv as unknown as import('@prisma/client').Prisma.InputJsonValue,
                lastFetchedAt: new Date(),
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
                  rawPayload: msg as unknown as import('@prisma/client').Prisma.InputJsonValue,
                },
                update: {
                  senderName: msg.senderName,
                  subject: msg.subject,
                  sendTime: new Date(msg.sendTime),
                  isNew: msg.isNew,
                  preventReply: msg.preventReply,
                  sentViaEmail: msg.sentViaEmail,
                  sentViaSms: msg.sentViaSms,
                  rawPayload: msg as unknown as import('@prisma/client').Prisma.InputJsonValue,
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
        `Mail inbox sync (conn=${conn?.id ?? 'shared'}): pages=${pageCount} fetched=${fetchedCount} upserted=${upsertCount}`,
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
