import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import { currentSchoolYearFor } from '../../common/school-year/school-year.scope';

interface MashovTeacher {
  teacherGuid: string;
  teacherName: string;
}

interface MashovTimetableItem {
  timeTable: {
    groupId: number;
    day: number;
    lesson: number;
    roomNum: string;
    weeks: number;
  };
  groupDetails: {
    groupId: number;
    groupName: string;
    subjectName: string;
    groupTeachers: MashovTeacher[];
    groupInactiveTeachers: MashovTeacher[];
  };
}

@Injectable()
export class TimetableTask {
  private readonly logger = new Logger(TimetableTask.name);
  public static readonly SOURCE = 'timetable';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  // Weekly on Sunday at 3 AM — timetable rarely changes
  @Cron('0 3 * * 0')
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
    const useSharedSession = !context.connectionId && connections.length === 0;
    const students = await this.prisma.student.findMany({ where: { isActive: true } });
    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    // The year the row belongs to. Scoped per student because the connection
    // that answers is picked per student below; a stored year is the fallback
    // for the shared-session path, which has no user-owned connection: it
    // resolves the SAME stored year the year-scoped reads use, so writes and
    // reads cannot drift apart when the schools API runs ahead of the calendar.
    const fallbackSchoolYear = await currentSchoolYearFor(this.prisma);

    for (const student of students) {
      let schoolYear = connections[0]?.schoolYear ?? fallbackSchoolYear;
      const source = `${TimetableTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        let items: MashovTimetableItem[];
        const referer = `https://web.mashov.info/students/main/students/${student.studentGuid}/timetable`;
        if (useSharedSession) {
          items = await this.mashovClient.get<MashovTimetableItem[]>(
            `/api/students/${student.studentGuid}/timetable`,
            { headers: { 'Referer': referer } },
          );
        } else {
          items = [];
          for (const conn of connections) {
            try {
              const password = this.encryptionService.decrypt(conn.encryptedPassword);
              items = await this.mashovClient.getForConnection<MashovTimetableItem[]>(
                `/api/students/${student.studentGuid}/timetable`,
                conn.id, conn.schoolCode, conn.schoolYear, conn.username, password,
                { headers: { 'Referer': referer } },
              );
              schoolYear = conn.schoolYear;
              break;
            } catch { /* try next connection */ }
          }
        }

        fetchedCount = items.length;
        totalFetchedCount += fetchedCount;

        for (const item of items) {
          try {
            const { groupId, day, lesson, roomNum, weeks } = item.timeTable;
            const { groupName, subjectName, groupTeachers } = item.groupDetails;

            await this.prisma.timetableEntry.upsert({
              where: {
                studentGuid_schoolYear_day_lesson: {
                  schoolYear,
                  studentGuid: student.studentGuid,
                  day,
                  lesson,
                },
              },
              create: {
                schoolYear,
                studentGuid: student.studentGuid,
                groupId,
                day,
                lesson,
                roomNum: roomNum ?? '',
                weeks: weeks ?? -1,
                groupName,
                subjectName,
                teachers: groupTeachers as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
              update: {
                schoolYear,
                groupId,
                roomNum: roomNum ?? '',
                weeks: weeks ?? -1,
                groupName,
                subjectName,
                teachers: groupTeachers as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
            });
            upsertCount++;
            totalUpsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert timetable entry for ${student.studentGuid}: ${msg}`);
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount,
          updatedCount: upsertCount,
        });
        this.logger.debug(`Timetable sync ${student.fullName}: fetched=${fetchedCount} upserted=${upsertCount}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Timetable sync failed for ${student.studentGuid}: ${msg}`);
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
