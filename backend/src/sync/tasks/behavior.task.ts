import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { BehaviorClassifierService } from '../behavior-classifier.service';

interface MashovBehaviorItem {
  studentGuid: string;
  eventCode: number;
  justified: number;
  lessonId: number;
  reporterGuid: string;
  timestamp: string;
  groupId: number;
  lessonType: number;
  lesson: number;
  lessonDate: string;
  lessonReporter: string;
  achvaCode: number;
  achvaName: string;
  achvaAval: number;
  justificationId: number;
  justification: string;
  reporter: string;
  subject: string;
  remark?: string;
}

@Injectable()
export class BehaviorTask {
  private readonly logger = new Logger(BehaviorTask.name);
  public static readonly SOURCE = 'behavior';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly behaviorClassifier: BehaviorClassifierService,
  ) {}

  @Cron('*/12 * * * *')
  async run(): Promise<void> {
    return this.execute();
  }

  async execute(): Promise<void> {
    const students = await this.prisma.student.findMany({ where: { isActive: true } });

    for (const student of students) {
      const source = `${BehaviorTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        const items = await this.mashovClient.get<MashovBehaviorItem[]>(
          `/api/students/${student.studentGuid}/behave`,
          {
            headers: {
              'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/behave`,
            },
          },
        );

        fetchedCount = items.length;

        for (const item of items) {
          try {
            const classification = this.behaviorClassifier.classify(item.eventCode);
            const justifiable = await this.behaviorClassifier.isJustifiable(item.achvaCode);

            const remark = item.remark && item.remark !== 'ללא הערות' ? item.remark : null;
            const justification =
              item.justification && item.justification !== 'ללא הערות'
                ? item.justification
                : null;

            const eventAt = new Date(item.timestamp);
            const lessonDate = new Date(item.lessonDate);

            await this.prisma.behaviorItem.upsert({
              where: {
                studentGuid_lessonId_eventCode: {
                  studentGuid: item.studentGuid,
                  lessonId: item.lessonId,
                  eventCode: item.eventCode,
                },
              },
              create: {
                studentGuid: item.studentGuid,
                lessonId: item.lessonId,
                groupId: item.groupId,
                eventCode: item.eventCode,
                achvaCode: item.achvaCode,
                achvaName: item.achvaName,
                classification: classification.bucket,
                justifiable,
                lessonDate,
                lesson: item.lesson,
                subject: item.subject,
                reporter: item.reporter,
                remark,
                justification,
                eventAt,
                isNew: true,
                isArchived: false,
                rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
              update: {
                groupId: item.groupId,
                achvaName: item.achvaName,
                classification: classification.bucket,
                justifiable,
                lessonDate,
                lesson: item.lesson,
                subject: item.subject,
                reporter: item.reporter,
                remark,
                justification,
                eventAt,
                // Do NOT overwrite isNew/isArchived on updates
                rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
            });
            upsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert behavior item: ${msg}`);
          }
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount,
          updatedCount: upsertCount,
        });
        this.logger.debug(`Behavior sync ${student.fullName}: fetched=${fetchedCount} upserted=${upsertCount}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Behavior sync failed for ${student.studentGuid}: ${msg}`);
        await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
      }
    }
  }
}
