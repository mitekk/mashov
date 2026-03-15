import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import type { SyncTaskRunResult } from '../sync.types';

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
  ) {}

  @Cron('*/5 * * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  async execute(): Promise<SyncTaskRunResult> {
    const syncRun = await this.syncRunService.openRun(MailCountsTask.SOURCE);
    let updatedCount = 0;

    try {
      const data = await this.mashovClient.get<MailCountsResponse>(
        '/api/mail/counts?$select=unreadConversations',
      );

      const unreadCount = data?.unreadConversations ?? 0;

      // Store the unread count in the household connection
      const household = await this.prisma.householdConnection.findFirst({
        where: { active: true },
      });
      if (household) {
        await this.prisma.householdConnection.update({
          where: { id: household.id },
          data: { cachedNewCount: unreadCount },
        });
        updatedCount = 1;
      }

      await this.syncRunService.closeRun(syncRun.id, 'success', { fetchedCount: 1 });
      this.logger.debug(`Mail counts sync: unreadConversations=${unreadCount}`);
      return {
        status: 'success',
        summary: {
          fetchedCount: 1,
          createdCount: 0,
          updatedCount,
          failedCount: 0,
        },
        errorMessages: [],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Mail counts sync failed: ${msg}`);
      await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
      return {
        status: 'failed',
        summary: {
          fetchedCount: 0,
          createdCount: 0,
          updatedCount,
          failedCount: 1,
        },
        errorMessages: [msg],
      };
    }
  }
}
