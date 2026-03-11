import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';

interface MashovAchva {
  code: number;
  name: string;
  hidden: boolean;
  achvaType: number;
  commonBehaveId: number;
  onDuplicateLesson: boolean;
  onLastBehave: boolean;
  aval: number;
  displayOrder: number;
  teacherId: number;
  justifiable: boolean;
  hideFromStudents: boolean;
  preventPush: boolean;
  showInBehave: boolean;
}

@Injectable()
export class AchvasTask {
  private readonly logger = new Logger(AchvasTask.name);
  public static readonly SOURCE = 'achvas';

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
    const syncRun = await this.syncRunService.openRun(AchvasTask.SOURCE);
    let fetchedCount = 0;
    let upsertCount = 0;

    try {
      const achvas = await this.mashovClient.get<MashovAchva[]>('/api/achvas');

      fetchedCount = achvas.length;

      for (const achva of achvas) {
        try {
          await this.prisma.behaviorTypeReference.upsert({
            where: { code: achva.code },
            create: {
              code: achva.code,
              name: achva.name,
              displayOrder: achva.displayOrder,
              justifiable: achva.justifiable,
              hidden: achva.hidden,
              showInBehave: achva.showInBehave,
              hideFromStudents: achva.hideFromStudents,
              rawPayload: achva as unknown as import('@prisma/client').Prisma.InputJsonValue,
            },
            update: {
              name: achva.name,
              displayOrder: achva.displayOrder,
              justifiable: achva.justifiable,
              hidden: achva.hidden,
              showInBehave: achva.showInBehave,
              hideFromStudents: achva.hideFromStudents,
              rawPayload: achva as unknown as import('@prisma/client').Prisma.InputJsonValue,
            },
          });
          upsertCount++;
        } catch (itemErr) {
          const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
          this.logger.warn(`Failed to upsert achva code ${achva.code}: ${msg}`);
        }
      }

      await this.syncRunService.closeRun(syncRun.id, 'success', {
        fetchedCount,
        updatedCount: upsertCount,
      });
      this.logger.debug(`Achvas sync: fetched=${fetchedCount} upserted=${upsertCount}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Achvas sync failed: ${msg}`);
      await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
    }
  }
}
