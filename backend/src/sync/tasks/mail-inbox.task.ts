import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
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
  ) {}

  @Cron('*/7 * * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  async execute(): Promise<SyncTaskRunResult> {
    const syncRun = await this.syncRunService.openRun(MailInboxTask.SOURCE);
    let fetchedCount = 0;
    let upsertCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    try {
      const conversations = await this.mashovClient.get<MashovConversation[]>(
        '/api/mail/inbox/conversations?skip=0&take=50',
        {
          headers: { 'Referer': 'https://web.mashov.info/students/main/mailbox/folder/inbox' },
        },
      );

      fetchedCount = conversations.length;

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
              isNew: conv.isNew,
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
              isNew: conv.isNew,
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

      await this.syncRunService.closeRun(syncRun.id, 'success', {
        fetchedCount,
        updatedCount: upsertCount,
      });
      this.logger.debug(`Mail inbox sync: fetched=${fetchedCount} upserted=${upsertCount}`);
      return {
        status: failedCount > 0 ? 'failed' : 'success',
        summary: {
          fetchedCount,
          createdCount: 0,
          updatedCount: upsertCount,
          failedCount,
        },
        errorMessages,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Mail inbox sync failed: ${msg}`);
      await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
      return {
        status: 'failed',
        summary: {
          fetchedCount,
          createdCount: 0,
          updatedCount: upsertCount,
          failedCount: failedCount + 1,
        },
        errorMessages: [...errorMessages, msg],
      };
    }
  }
}
