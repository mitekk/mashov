import { Injectable, Logger } from '@nestjs/common';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { reportNoConnectionTarget, skipNoConnections } from '../connection-fanout';
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

    // No usable target: the loop below would not run at all -- no run,
    // nothing fetched, `success` with every count zero. A named connection
    // that resolves to nothing is a reportable failure; no connections at all
    // is the empty deployment.
    if (connections.length === 0) {
      return context.connectionId
        ? reportNoConnectionTarget(
            this.syncRunService,
            this.logger,
            UserDetailsTask.SOURCE,
            context.connectionId,
          )
        : skipNoConnections(this.logger, UserDetailsTask.SOURCE);
    }

    let totalFetchedCount = 0;
    let totalCreatedCount = 0;
    let totalUpdatedCount = 0;
    let totalFailedCount = 0;
    const allErrorMessages: string[] = [];

    for (const conn of connections) {
      const source = `${UserDetailsTask.SOURCE}:${conn.id}`;
      const syncRun = await this.syncRunService.openRun(source, conn.id);
      let createdCount = 0;
      let updatedCount = 0;

      try {
        const details = await this.mashovClient.getForConnection<MashovUserDetails>(
          '/api/user/details',
          conn.id,
          conn.schoolCode,
          conn.schoolYear,
          conn.username,
          this.encryptionService.decrypt(conn.encryptedPassword),
          { headers: { Referer: 'https://web.mashov.info/students/main/settings' } },
        );

        const profileFields = {
          email: details.email,
          cellphone: details.cellphone,
          detailsState: details.detailsState,
          rawPayload: details as unknown as import('@prisma/client').Prisma.InputJsonValue,
          // Stamped so SettingsService can return the profile for a given
          // school instead of picking between two rows with findFirst.
          householdConnectionId: conn.id,
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
          `User details sync (conn=${conn.id}): userId=${details.userId}`,
        );
        totalFetchedCount += 1;
        totalCreatedCount += createdCount;
        totalUpdatedCount += updatedCount;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`User details sync failed (conn=${conn.id}): ${msg}`);
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
