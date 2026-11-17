import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import { calendarSchoolYear } from '../../common/school-year/school-year.service';

interface MashovGroup {
  groupId: number;
  groupName: string;
  subjectName: string;
  groupTeachers: Array<{ teacherGuid: string; teacherName: string }>;
  groupInactiveTeachers: Array<{ teacherGuid: string; teacherName: string }>;
}

@Injectable()
export class GroupsTask {
  private readonly logger = new Logger(GroupsTask.name);
  public static readonly SOURCE = 'groups';

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
    const connections = await this.prisma.householdConnection.findMany({
      where: {
        userId: { not: null },
        active: true,
        ...(context.connectionId ? { id: context.connectionId } : {}),
      },
    });
    const useSharedSession = !context.connectionId && connections.length === 0;

    const students = await this.prisma.student.findMany({ where: { isActive: true } });
    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    // The year the row belongs to. Scoped per student because the connection
    // that answers is picked per student below; the calendar is the fallback
    // for the legacy shared-session path, which has no connection at all.
    const fallbackSchoolYear = calendarSchoolYear(new Date());

    for (const student of students) {
      let schoolYear = connections[0]?.schoolYear ?? fallbackSchoolYear;
      const source = `${GroupsTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        let groups: MashovGroup[];

        if (useSharedSession) {
          groups = await this.mashovClient.get<MashovGroup[]>(
            `/api/students/${student.studentGuid}/groups`,
            {
              headers: {
                'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/behaveCounter`,
              },
            },
          );
        } else {
          groups = [];
          for (const conn of connections) {
            try {
              const password = this.encryptionService.decrypt(conn.encryptedPassword);
              groups = await this.mashovClient.getForConnection<MashovGroup[]>(
                `/api/students/${student.studentGuid}/groups`,
                conn.id,
                conn.schoolCode,
                conn.schoolYear,
                conn.username,
                password,
                {
                  headers: {
                    'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/behaveCounter`,
                  },
                },
              );
              schoolYear = conn.schoolYear;
              break;
            } catch (connErr) {
              const connMsg = connErr instanceof Error ? connErr.message : String(connErr);
              this.logger.warn(`Groups: connection ${conn.id} failed for ${student.studentGuid}: ${connMsg}`);
            }
          }
        }

        fetchedCount = groups.length;
        totalFetchedCount += fetchedCount;

        for (const group of groups) {
          try {
            await this.prisma.subjectEnrollment.upsert({
              where: {
                studentGuid_schoolYear_groupId: {
                  schoolYear,
                  studentGuid: student.studentGuid,
                  groupId: group.groupId,
                },
              },
              create: {
                schoolYear,
                studentGuid: student.studentGuid,
                groupId: group.groupId,
                groupName: group.groupName,
                subjectName: group.subjectName,
                teachers: group.groupTeachers as unknown as import('@prisma/client').Prisma.InputJsonValue,
                inactiveTeachers: group.groupInactiveTeachers as unknown as import('@prisma/client').Prisma.InputJsonValue,
                rawPayload: group as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
              update: {
                schoolYear,
                groupName: group.groupName,
                subjectName: group.subjectName,
                teachers: group.groupTeachers as unknown as import('@prisma/client').Prisma.InputJsonValue,
                inactiveTeachers: group.groupInactiveTeachers as unknown as import('@prisma/client').Prisma.InputJsonValue,
                rawPayload: group as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
            });
            upsertCount++;
            totalUpsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert group ${group.groupId}: ${msg}`);
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount,
          updatedCount: upsertCount,
        });
        this.logger.debug(`Groups sync ${student.fullName}: fetched=${fetchedCount} upserted=${upsertCount}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Groups sync failed for ${student.studentGuid}: ${msg}`);
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
