import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';

interface MashovUserDetails {
  semel: number;
  userId: string;
  detailsState: number;
  email: string;
  emailSet: string;
  emailVerified: string;
  cellphone: string;
  cellphoneSet: string;
  cellphoneVerified: string;
  lastRecovery: string;
  lastReset: string;
}

@Injectable()
export class UserDetailsTask {
  private readonly logger = new Logger(UserDetailsTask.name);
  public static readonly SOURCE = 'user_details';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  @Cron('0 6 * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  /**
   * One profile per Mashov account, not one per household.
   *
   * `/api/user/details` is per account and `ParentProfile.upstreamUserId` is a
   * per-school user id, so a two-school parent legitimately has two rows --
   * two rows is the correct steady state, not a duplicate. This used to fetch
   * for whichever connection `findFirst` returned, so the second school's
   * contact details were simply never read.
   */
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
    const connectionList: Array<(typeof connections)[number] | null> = useSharedSession
      ? [null]
      : connections;

    let totalFetchedCount = 0;
    let totalCreatedCount = 0;
    let totalUpdatedCount = 0;
    let totalFailedCount = 0;
    const allErrorMessages: string[] = [];

    for (const conn of connectionList) {
      const source = conn
        ? `${UserDetailsTask.SOURCE}:${conn.id}`
        : UserDetailsTask.SOURCE;
      const syncRun = await this.syncRunService.openRun(
        source,
        conn?.id ?? context.connectionId,
      );
      let createdCount = 0;
      let updatedCount = 0;

      try {
        const details = conn
          ? await this.mashovClient.getForConnection<MashovUserDetails>(
              '/api/user/details',
              conn.id,
              conn.schoolCode,
              conn.schoolYear,
              conn.username,
              this.encryptionService.decrypt(conn.encryptedPassword),
              { headers: { Referer: 'https://web.mashov.info/students/main/settings' } },
            )
          : await this.mashovClient.get<MashovUserDetails>(
              '/api/user/details',
              { headers: { Referer: 'https://web.mashov.info/students/main/settings' } },
            );

        const profileFields = {
          email: details.email,
          cellphone: details.cellphone,
          detailsState: details.detailsState,
          rawPayload: details as unknown as import('@prisma/client').Prisma.InputJsonValue,
          // Stamped so SettingsService can return the profile for a given
          // school instead of picking between two rows with findFirst.
          ...(conn ? { householdConnectionId: conn.id } : {}),
        };

        const existing = await this.prisma.parentProfile.findUnique({
          where: { upstreamUserId: details.userId },
        });

        if (existing) {
          await this.prisma.parentProfile.update({
            where: { upstreamUserId: details.userId },
            data: profileFields,
          });
          updatedCount = 1;
        } else {
          await this.prisma.parentProfile.create({
            data: { upstreamUserId: details.userId, ...profileFields },
          });
          createdCount = 1;
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', { fetchedCount: 1 });
        this.logger.debug(
          `User details sync (conn=${conn?.id ?? 'shared'}): userId=${details.userId}`,
        );
        totalFetchedCount += 1;
        totalCreatedCount += createdCount;
        totalUpdatedCount += updatedCount;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`User details sync failed (conn=${conn?.id ?? 'shared'}): ${msg}`);
        await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
        totalFailedCount += 1;
        allErrorMessages.push(msg);
      }
    }

    return {
      status: totalFailedCount > 0 ? 'failed' : 'success',
      summary: {
        fetchedCount: totalFetchedCount,
        createdCount: totalCreatedCount,
        updatedCount: totalUpdatedCount,
        failedCount: totalFailedCount,
      },
      errorMessages: allErrorMessages.slice(0, 10),
    };
  }
}
