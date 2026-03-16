import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import type { SyncTaskRunResult } from '../sync.types';

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
  ) {}

  // Weekly on Sunday at 3 AM — timetable rarely changes
  @Cron('0 3 * * 0')
  async run(): Promise<void> {
    await this.execute();
  }

  async execute(): Promise<SyncTaskRunResult> {
    const students = await this.prisma.student.findMany({ where: { isActive: true } });
    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    for (const student of students) {
      const source = `${TimetableTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        const items = await this.mashovClient.get<MashovTimetableItem[]>(
          `/api/students/${student.studentGuid}/timetable`,
          {
            headers: {
              'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/timetable`,
            },
          },
        );

        fetchedCount = items.length;
        totalFetchedCount += fetchedCount;

        for (const item of items) {
          try {
            const { groupId, day, lesson, roomNum, weeks } = item.timeTable;
            const { groupName, subjectName, groupTeachers } = item.groupDetails;

            await this.prisma.timetableEntry.upsert({
              where: {
                studentGuid_day_lesson: {
                  studentGuid: student.studentGuid,
                  day,
                  lesson,
                },
              },
              create: {
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
