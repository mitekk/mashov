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

  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const conn = context.connectionId
      ? await this.prisma.householdConnection.findFirst({
          where: { id: context.connectionId, userId: { not: null }, active: true },
        })
      : await this.prisma.householdConnection.findFirst({
          where: { userId: { not: null }, active: true },
        });
    const syncRun = await this.syncRunService.openRun(
      UserDetailsTask.SOURCE,
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
            { headers: { 'Referer': 'https://web.mashov.info/students/main/settings' } },
          )
        : await this.mashovClient.get<MashovUserDetails>(
            '/api/user/details',
            { headers: { 'Referer': 'https://web.mashov.info/students/main/settings' } },
          );

      const existing = await this.prisma.parentProfile.findUnique({
        where: { upstreamUserId: details.userId },
      });

      if (existing) {
        await this.prisma.parentProfile.update({
          where: { upstreamUserId: details.userId },
          data: {
            email: details.email,
            cellphone: details.cellphone,
            detailsState: details.detailsState,
            rawPayload: details as unknown as import('@prisma/client').Prisma.InputJsonValue,
          },
        });
        updatedCount = 1;
      } else {
        await this.prisma.parentProfile.create({
          data: {
            upstreamUserId: details.userId,
            email: details.email,
            cellphone: details.cellphone,
            detailsState: details.detailsState,
            rawPayload: details as unknown as import('@prisma/client').Prisma.InputJsonValue,
          },
        });
        createdCount = 1;
      }

      await this.syncRunService.closeRun(syncRun.id, 'success', { fetchedCount: 1 });
      this.logger.debug(`User details sync: userId=${details.userId}`);
      return {
        status: 'success',
        summary: {
          fetchedCount: 1,
          createdCount,
          updatedCount,
          failedCount: 0,
        },
        errorMessages: [],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`User details sync failed: ${msg}`);
      await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
      return {
        status: 'failed',
        summary: {
          fetchedCount: 0,
          createdCount,
          updatedCount,
          failedCount: 1,
        },
        errorMessages: [msg],
      };
    }
  }
}
