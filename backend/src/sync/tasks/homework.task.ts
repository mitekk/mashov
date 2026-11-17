import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import * as crypto from 'crypto';
import { currentSchoolYearFor } from '../../common/school-year/school-year.scope';

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
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
    });

    const students = await this.prisma.student.findMany({ where: { isActive: true } });
    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    // Fall back to single shared session when no user-owned connections exist
    // One value feeds both the login year and the row stamp.
    const requestedYear = context.schoolYear;
    const sourcePrefix = context.sourcePrefix ?? '';

    const useSharedSession = !context.connectionId && connections.length === 0;

    // The shared session is process-global and carries no per-year identity,
    // so it would answer with the current year while this run stamps another.
    // The backfill always passes a connectionId and never reaches here; this
    // refuses the combination rather than writing mislabelled rows.
    if (useSharedSession && requestedYear !== undefined) {
      const message = `${HomeworkTask.SOURCE}: refusing year ${requestedYear} on the shared-session path; a historical year needs an explicit connectionId`;
      this.logger.warn(message);
      return {
        status: 'failed',
        summary: { fetchedCount: 0, createdCount: 0, updatedCount: 0, failedCount: 1 },
        errorMessages: [message],
      };
    }

    // The year the row belongs to. Scoped per student because the connection
    // that answers is picked per student below; a stored year is the fallback
    // for the shared-session path, which has no user-owned connection: it
    // resolves the SAME stored year the year-scoped reads use, so writes and
    // reads cannot drift apart when the schools API runs ahead of the calendar.
    const fallbackSchoolYear = await currentSchoolYearFor(this.prisma);

    for (const student of students) {
      let schoolYear = requestedYear ?? connections[0]?.schoolYear ?? fallbackSchoolYear;
      const source = `${sourcePrefix}${HomeworkTask.SOURCE}:${student.studentGuid}`;
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
          let answered = false;
          for (const conn of connections) {
            try {
              const password = this.encryptionService.decrypt(conn.encryptedPassword);
              const connYear = requestedYear ?? conn.schoolYear;
              items = await this.mashovClient.getForConnection<MashovHomework[]>(
                `/api/students/${student.studentGuid}/homework`,
                conn.id,
                conn.schoolCode,
                connYear,
                conn.username,
                password,
                {
                  headers: {
                    'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/homework`,
                  },
                },
              );
              schoolYear = connYear;
              answered = true;
              break;
            } catch (connErr) {
              const connMsg = connErr instanceof Error ? connErr.message : String(connErr);
              this.logger.warn(`Homework: connection ${conn.id} failed for ${student.studentGuid}: ${connMsg}`);
            }
          }
          // Every connection failed. Reporting success here would let the
          // history backfill record a year permanently complete having
          // fetched nothing, and would hide a broken live sync behind a
          // green run. The per-student catch below records the failure.
          if (!answered) {
            throw new Error(
              `every connection failed for ${student.studentGuid} (tried ${connections.length})`,
            );
          }
        }

        fetchedCount = items.length;
        totalFetchedCount += fetchedCount;

        for (const item of items) {
          try {
            const lessonDate = new Date(item.lessonDate);
            const files = item.files ?? [];
            const remark = item.remark && item.remark !== 'ללא הערות' ? item.remark : null;

            let whereClause: {
              studentGuid_schoolYear_lessonId: {
                studentGuid: string;
                schoolYear: number;
                lessonId: number;
              };
            };
            let lessonId: number;

            if (item.lessonId) {
              lessonId = item.lessonId;
              whereClause = {
                studentGuid_schoolYear_lessonId: {
                  schoolYear,
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
                studentGuid_schoolYear_lessonId: {
                  schoolYear,
                  studentGuid: item.studentGuid,
                  lessonId,
                },
              };
            }

            await this.prisma.homeworkItem.upsert({
              where: whereClause,
              create: {
                schoolYear,
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
                schoolYear,
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
