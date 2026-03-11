import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import * as crypto from 'crypto';

interface MashovHomework {
  lessonId: number;
  lessonDate: string;
  lesson: number;
  homework: string;
  groupId: number;
  remark: string;
  studentGuid: string;
  subjectName: string;
  files?: Array<{ fileId: string; fileName: string }>;
}

@Injectable()
export class HomeworkTask {
  private readonly logger = new Logger(HomeworkTask.name);
  public static readonly SOURCE = 'homework';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
  ) {}

  @Cron('*/12 * * * *')
  async run(): Promise<void> {
    return this.execute();
  }

  async execute(): Promise<void> {
    const students = await this.prisma.student.findMany({ where: { isActive: true } });

    for (const student of students) {
      const source = `${HomeworkTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        const items = await this.mashovClient.get<MashovHomework[]>(
          `/api/students/${student.studentGuid}/homework`,
          {
            headers: {
              'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/homework`,
            },
          },
        );

        fetchedCount = items.length;

        for (const item of items) {
          try {
            const lessonDate = new Date(item.lessonDate);
            const files = item.files ?? [];
            const remark = item.remark && item.remark !== 'ללא הערות' ? item.remark : null;

            let whereClause: { studentGuid_lessonId: { studentGuid: string; lessonId: number } };
            let lessonId: number;

            if (item.lessonId) {
              lessonId = item.lessonId;
              whereClause = {
                studentGuid_lessonId: {
                  studentGuid: item.studentGuid,
                  lessonId: item.lessonId,
                },
              };
            } else {
              // Fallback: generate deterministic lessonId from hash
              const hashInput = `${item.studentGuid}:${item.groupId}:${item.lessonDate}:${item.lesson}:${item.homework}`;
              const hash = crypto.createHash('sha256').update(hashInput).digest('hex');
              lessonId = parseInt(hash.substring(0, 8), 16);
              whereClause = {
                studentGuid_lessonId: {
                  studentGuid: item.studentGuid,
                  lessonId,
                },
              };
            }

            await this.prisma.homeworkItem.upsert({
              where: whereClause,
              create: {
                studentGuid: item.studentGuid,
                lessonId,
                groupId: item.groupId,
                lessonDate,
                lesson: item.lesson,
                subjectName: item.subjectName,
                homeworkText: item.homework,
                remark,
                files: files as unknown as import('@prisma/client').Prisma.InputJsonValue,
                rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
              update: {
                groupId: item.groupId,
                lessonDate,
                lesson: item.lesson,
                subjectName: item.subjectName,
                homeworkText: item.homework,
                remark,
                files: files as unknown as import('@prisma/client').Prisma.InputJsonValue,
                rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
            });
            upsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert homework item for ${student.studentGuid}: ${msg}`);
          }
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount,
          updatedCount: upsertCount,
        });
        this.logger.debug(`Homework sync ${student.fullName}: fetched=${fetchedCount} upserted=${upsertCount}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Homework sync failed for ${student.studentGuid}: ${msg}`);
        await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
      }
    }
  }
}
