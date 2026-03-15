import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import type { SyncTaskRunResult } from '../sync.types';

interface MashovLessonsCount {
  studentGuid: string;
  groupId: number;
  lessonsCount: number;
  weeklyHours: number;
}

@Injectable()
export class LessonsCountTask {
  private readonly logger = new Logger(LessonsCountTask.name);
  public static readonly SOURCE = 'lessons_count';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
  ) {}

  @Cron('0 6 * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  async execute(): Promise<SyncTaskRunResult> {
    const students = await this.prisma.student.findMany({ where: { isActive: true } });
    let totalFetchedCount = 0;
    let totalUpdatedCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    for (const student of students) {
      const source = `${LessonsCountTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source);
      let fetchedCount = 0;
      let updatedCount = 0;

      try {
        const items = await this.mashovClient.get<MashovLessonsCount[]>(
          `/api/students/${student.studentGuid}/lessonsCount`,
          {
            headers: {
              'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/behaveCounter`,
            },
          },
        );

        fetchedCount = items.length;
        totalFetchedCount += fetchedCount;

        for (const item of items) {
          try {
            const existing = await this.prisma.subjectEnrollment.findUnique({
              where: {
                studentGuid_groupId: {
                  studentGuid: item.studentGuid,
                  groupId: item.groupId,
                },
              },
            });

            if (existing) {
              await this.prisma.subjectEnrollment.update({
                where: {
                  studentGuid_groupId: {
                    studentGuid: item.studentGuid,
                    groupId: item.groupId,
                  },
                },
                data: {
                  lessonsCount: item.lessonsCount,
                  weeklyHours: item.weeklyHours,
                },
              });
              updatedCount++;
              totalUpdatedCount++;
            }
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to update lessonsCount for group ${item.groupId}: ${msg}`);
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount,
          updatedCount,
        });
        this.logger.debug(`LessonsCount sync ${student.fullName}: fetched=${fetchedCount} updated=${updatedCount}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`LessonsCount sync failed for ${student.studentGuid}: ${msg}`);
        await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
        failedCount++;
        if (errorMessages.length < 10) errorMessages.push(msg);
      }
    }

    return {
      status: failedCount > 0 ? 'failed' : 'success',
      summary: {
        fetchedCount: totalFetchedCount,
        createdCount: 0,
        updatedCount: totalUpdatedCount,
        failedCount,
      },
      errorMessages,
    };
  }
}
