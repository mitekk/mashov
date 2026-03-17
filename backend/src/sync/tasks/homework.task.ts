import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
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
    private readonly encryptionService: EncryptionService,
  ) {}

  @Cron('*/12 * * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: {
        userId: { not: null },
        active: true,
        ...(context.connectionId ? { id: context.connectionId } : {}),
      },
    });

    const students = await this.prisma.student.findMany({ where: { isActive: true } });
    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    // Fall back to single shared session when no user-owned connections exist
    const useSharedSession = !context.connectionId && connections.length === 0;

    for (const student of students) {
      const source = `${HomeworkTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        let items: MashovHomework[];

        if (useSharedSession) {
          items = await this.mashovClient.get<MashovHomework[]>(
            `/api/students/${student.studentGuid}/homework`,
            {
              headers: {
                'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/homework`,
              },
            },
          );
        } else {
          // Try each connection; use the first successful response
          items = [];
          for (const conn of connections) {
            try {
              const password = this.encryptionService.decrypt(conn.encryptedPassword);
              items = await this.mashovClient.getForConnection<MashovHomework[]>(
                `/api/students/${student.studentGuid}/homework`,
                conn.id,
                conn.schoolCode,
                conn.schoolYear,
                conn.username,
                password,
                {
                  headers: {
                    'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/homework`,
                  },
                },
              );
              break;
            } catch (connErr) {
              const connMsg = connErr instanceof Error ? connErr.message : String(connErr);
              this.logger.warn(`Homework: connection ${conn.id} failed for ${student.studentGuid}: ${connMsg}`);
            }
          }
        }

        fetchedCount = items.length;
        totalFetchedCount += fetchedCount;

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
            totalUpsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert homework item for ${student.studentGuid}: ${msg}`);
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
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
        failedCount++;
        if (errorMessages.length < 10) errorMessages.push(msg);
      }
    }

    return {
      status: failedCount > 0 ? 'failed' : 'success',
      summary: {
        fetchedCount: totalFetchedCount,
        createdCount: 0,
        updatedCount: totalUpsertCount,
        failedCount,
      },
      errorMessages,
    };
  }
}
