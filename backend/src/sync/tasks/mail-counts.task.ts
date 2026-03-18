import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';

interface MailCountsResponse {
  unreadConversations: number;
}

@Injectable()
export class MailCountsTask {
  private readonly logger = new Logger(MailCountsTask.name);
  public static readonly SOURCE = 'mail_counts';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  @Cron('*/5 * * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: {
        userId: { not: null },
        active: true,
        ...(context.connectionId ? { id: context.connectionId } : {}),
      },
    });
    const useSharedSession = !context.connectionId && connections.length === 0;
    const connectionList = useSharedSession ? [null] : connections;

    let totalUpdatedCount = 0;
    let totalFailedCount = 0;
    const allErrorMessages: string[] = [];

    for (const conn of connectionList) {
      const source = conn ? `${MailCountsTask.SOURCE}:${conn.id}` : MailCountsTask.SOURCE;
      const syncRun = await this.syncRunService.openRun(source, conn?.id ?? context.connectionId);
      let updatedCount = 0;

      try {
        let data: MailCountsResponse;

        if (conn) {
          const password = this.encryptionService.decrypt(conn.encryptedPassword);
          data = await this.mashovClient.getForConnection<MailCountsResponse>(
            '/api/mail/counts?$select=unreadConversations',
            conn.id,
            conn.schoolCode,
            conn.schoolYear,
            conn.username,
            password,
          );
        } else {
          data = await this.mashovClient.get<MailCountsResponse>(
            '/api/mail/counts?$select=unreadConversations',
          );
        }

        const unreadCount = data?.unreadConversations ?? 0;

        // Compute local unread count excluding archived — upstream counts unread across all
        // folders (including archive), which would inflate the badge. Use local DB as source of truth.
        const localUnreadCount = await this.prisma.mailConversation.count({
          where: {
            isUnread: true,
            NOT: { labels: { array_contains: ['archived'] } },
          },
        });

        // Update cachedNewCount on this specific connection (or the first active one for shared session)
        const target = conn ?? await this.prisma.householdConnection.findFirst({ where: { active: true } });
        if (target) {
          await this.prisma.householdConnection.update({
            where: { id: target.id },
            data: { cachedNewCount: localUnreadCount },
          });
          updatedCount = 1;
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', { fetchedCount: 1 });
        this.logger.debug(`Mail counts sync (conn=${conn?.id ?? 'shared'}): upstream=${unreadCount} local=${localUnreadCount}`);
        totalUpdatedCount += updatedCount;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Mail counts sync failed (conn=${conn?.id ?? 'shared'}): ${msg}`);
        await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
        totalFailedCount++;
        allErrorMessages.push(msg);
      }
    }

    return {
      status: totalFailedCount > 0 ? 'failed' : 'success',
      summary: {
        fetchedCount: connectionList.length,
        createdCount: 0,
        updatedCount: totalUpdatedCount,
        failedCount: totalFailedCount,
      },
      errorMessages: allErrorMessages,
    };
  }
}
