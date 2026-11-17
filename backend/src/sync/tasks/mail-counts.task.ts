import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import { MailInboxTask } from './mail-inbox.task';

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

  /**
   * The three populations that can make the local unread count disagree with Mashov's.
   * `orphans` is derived from the last successful inbox run rather than a fixed
   * interval: both of that task's walks refresh lastFetchedAt on every row upstream
   * still returns, so anything older is a conversation upstream has stopped returning.
   */
  private async describeDrift(connectionId?: string): Promise<{
    archived: number;
    orphans: number | 'unknown';
    locallyOverridden: number;
  }> {
    const lastInboxRun = await this.prisma.syncRun.findFirst({
      // The exact source this connection's walk writes, not a prefix match: under two
      // connections a prefix would pick up the other one's run, and then every row of
      // this mailbox reads as an orphan. It would also match a future
      // `mail_inbox_<something>` source.
      where: {
        source: connectionId ? `${MailInboxTask.SOURCE}:${connectionId}` : MailInboxTask.SOURCE,
        status: 'success',
      },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });

    const [archived, orphans, locallyOverridden] = await Promise.all([
      this.prisma.mailConversation.count({
        where: { labels: { array_contains: ['archived'] } },
      }),
      lastInboxRun
        ? this.prisma.mailConversation.count({
            where: {
              isUnread: true,
              NOT: { labels: { array_contains: ['archived'] } },
              lastFetchedAt: { lt: lastInboxRun.startedAt },
            },
          })
        : Promise.resolve<number | 'unknown'>('unknown'),
      this.prisma.mailConversation.count({
        where: { locallyReadThroughAt: { not: null } },
      }),
    ]);

    return { archived, orphans, locallyOverridden };
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

        // Deliberately 'success', never 'partial', even when the two numbers disagree:
        // FreshnessService derives source health from the latest *successful* run, so a
        // permanently-partial mail_counts would read as stale forever and conflate
        // "the numbers disagree" with "the cron is dead".
        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount: 1,
          upstreamCount: unreadCount,
          localCount: localUnreadCount,
        });

        const label = `conn=${conn?.id ?? 'shared'}`;
        if (unreadCount === localUnreadCount) {
          this.logger.debug(
            `Mail counts sync (${label}): upstream=${unreadCount} local=${localUnreadCount}`,
          );
        } else {
          // Drift means the badge is lying to the user, so it is a warning, and it
          // carries the breakdown that tells an operator which cause is live. The extra
          // queries run only when drifting.
          const breakdown = await this.describeDrift(conn?.id);
          this.logger.warn(
            `Mail counts drift (${label}): upstream=${unreadCount} local=${localUnreadCount} ` +
              `archived=${breakdown.archived} orphans=${breakdown.orphans} ` +
              `locallyOverridden=${breakdown.locallyOverridden}`,
          );
        }
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
