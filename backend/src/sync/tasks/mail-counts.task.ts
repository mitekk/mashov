import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';

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
    return this.execute();
  }

  async execute(): Promise<void> {
    const syncRun = await this.syncRunService.openRun(MailCountsTask.SOURCE);

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
          data: { cachedUnreadCount: unreadCount },
        });
      }

      await this.syncRunService.closeRun(syncRun.id, 'success', { fetchedCount: 1 });
      this.logger.debug(`Mail counts sync: unreadConversations=${unreadCount}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Mail counts sync failed: ${msg}`);
      await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
    }
  }
}
