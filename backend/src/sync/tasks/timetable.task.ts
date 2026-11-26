import { Injectable, Logger } from '@nestjs/common';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  orderConnectionsForStudent,
  reportNoConnectionTarget,
  skipNoConnections,
  stampOwnershipIfChanged,
  studentScopeForContext,
} from '../connection-fanout';
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

  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: {
        userId: { not: null },
        active: true,
        ...(context.connectionId ? { id: context.connectionId } : {}),
      },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
    });

    // Before the student query, which has nothing to iterate without a
    // connection to ask. A named connection that resolves to nothing is a
    // reportable failure; no connections at all is the empty deployment.
    if (connections.length === 0) {
      return context.connectionId
        ? reportNoConnectionTarget(
            this.syncRunService,
            this.logger,
            TimetableTask.SOURCE,
            context.connectionId,
          )
        : skipNoConnections(this.logger, TimetableTask.SOURCE);
    }
    // One value feeds both the login year and the row stamp.
    const requestedYear = context.schoolYear;
    const sourcePrefix = context.sourcePrefix ?? '';

    const students = await this.prisma.student.findMany({
      where: studentScopeForContext(context),
    });
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
      // Owner first. With one school this is the same single connection it
      // always was; with two it saves a guaranteed 403 per student per run.
      const ordered = orderConnectionsForStudent(student, connections);
      // Seeded from the OWNER's year, not the table's first row: this value
      // survives if every call fails, and labelling a child's rows with
      // another school's year is how reads and writes drift apart.
      let schoolYear = requestedYear ?? ordered[0]?.schoolYear ?? fallbackSchoolYear;
      const source = `${sourcePrefix}${TimetableTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;
      // Per-RUN, not the task-scoped `failedCount`: that one is shared
      // across every student, so reusing it here would close this run
      // `failed` because some OTHER student's item failed.
      let itemFailures = 0;
      const itemErrors: string[] = [];

      try {
        let items: MashovTimetableItem[] = [];
        const referer = `https://web.mashov.info/students/main/students/${student.studentGuid}/timetable`;

        let answered = false;

        // Collected so the thrown error carries WHY. This is the only fetch

        // path now, so a bare "every connection failed" would strand the real

        // cause in a per-connection warn line and hand /more an error with no

        // diagnosis in it.

        const connFailures: string[] = [];
        for (const conn of ordered) {
          try {
            const password = this.encryptionService.decrypt(conn.encryptedPassword);
            const connYear = requestedYear ?? conn.schoolYear;
            items = await this.mashovClient.getForConnection<MashovTimetableItem[]>(
              `/api/students/${student.studentGuid}/timetable`,
              conn.id, conn.schoolCode, connYear, conn.username, password,
              { headers: { 'Referer': referer } },
            );
            schoolYear = connYear;
            answered = true;
            // A success on a non-owner re-stamps, so a child who moved
            // school stops costing a failed call on every later run.
            await stampOwnershipIfChanged(
              this.prisma,
              student,
              conn,
              this.logger,
              // An empty 200 is not proof the child is in this account.
              Array.isArray(items) && items.length > 0,
            );
            break;
          } catch (connErr) {
            connFailures.push(connErr instanceof Error ? connErr.message : String(connErr));
          }
        }
        // Every connection failed. Reporting success here would let the
        // history backfill record a year permanently complete having
        // fetched nothing, and would hide a broken live sync behind a
        // green run. The per-student catch below records the failure.
        if (!answered) {
          throw new Error(
            `every connection failed for ${student.studentGuid} (tried ${connections.length}): ${connFailures.join('; ')}`,
          );
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
            itemFailures++;
            itemErrors.push(msg);
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        await this.syncRunService.closeItemRun(syncRun.id, {
          fetchedCount,
          updatedCount: upsertCount,
          itemFailures,
          itemErrors,
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
