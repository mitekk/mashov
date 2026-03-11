import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';

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
  ) {}

  @Cron('0 6 * * *')
  async run(): Promise<void> {
    return this.execute();
  }

  async execute(): Promise<void> {
    const syncRun = await this.syncRunService.openRun(UserDetailsTask.SOURCE);

    try {
      const details = await this.mashovClient.get<MashovUserDetails>(
        '/api/user/details',
        {
          headers: { 'Referer': 'https://web.mashov.info/students/main/settings' },
        },
      );

      // Get school name from household connection
      const household = await this.prisma.householdConnection.findFirst({
        where: { active: true },
      });

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
      } else {
        const displayName = household?.upstreamUserId === details.userId
          ? undefined
          : undefined;

        await this.prisma.parentProfile.create({
          data: {
            upstreamUserId: details.userId,
            email: details.email,
            cellphone: details.cellphone,
            detailsState: details.detailsState,
            rawPayload: details as unknown as import('@prisma/client').Prisma.InputJsonValue,
          },
        });
      }

      await this.syncRunService.closeRun(syncRun.id, 'success', { fetchedCount: 1 });
      this.logger.debug(`User details sync: userId=${details.userId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`User details sync failed: ${msg}`);
      await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
    }
  }
}
