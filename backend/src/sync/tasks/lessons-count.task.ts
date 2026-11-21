import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  orderConnectionsForStudent,
  stampOwnershipIfChanged,
  studentScopeForContext,
} from '../connection-fanout';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import { currentSchoolYearFor } from '../../common/school-year/school-year.scope';

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
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
    });
    // One value feeds both the login year and the row stamp.
    const requestedYear = context.schoolYear;
    const sourcePrefix = context.sourcePrefix ?? '';

    const useSharedSession = !context.connectionId && connections.length === 0;

    // The shared session is process-global and carries no per-year identity,
    // so it would answer with the current year while this run stamps another.
    // The backfill always passes a connectionId and never reaches here; this
    // refuses the combination rather than writing mislabelled rows.
    if (useSharedSession && requestedYear !== undefined) {
      const message = `${LessonsCountTask.SOURCE}: refusing year ${requestedYear} on the shared-session path; a historical year needs an explicit connectionId`;
      this.logger.warn(message);
      return {
        status: 'failed',
        summary: { fetchedCount: 0, createdCount: 0, updatedCount: 0, failedCount: 1 },
        errorMessages: [message],
      };
    }
    const students = await this.prisma.student.findMany({
      where: studentScopeForContext(context),
    });
    let totalFetchedCount = 0;
    let totalUpdatedCount = 0;
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
      const source = `${sourcePrefix}${LessonsCountTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let updatedCount = 0;

      try {
        let items: MashovLessonsCount[];
        const referer = `https://web.mashov.info/students/main/students/${student.studentGuid}/behaveCounter`;
        if (useSharedSession) {
          items = await this.mashovClient.get<MashovLessonsCount[]>(
            `/api/students/${student.studentGuid}/lessonsCount`,
            { headers: { 'Referer': referer } },
          );
        } else {
          items = [];
          let answered = false;
          for (const conn of ordered) {
            try {
              const password = this.encryptionService.decrypt(conn.encryptedPassword);
              const connYear = requestedYear ?? conn.schoolYear;
              items = await this.mashovClient.getForConnection<MashovLessonsCount[]>(
                `/api/students/${student.studentGuid}/lessonsCount`,
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
            } catch { /* try next connection */ }
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
            const existing = await this.prisma.subjectEnrollment.findUnique({
              where: {
                studentGuid_schoolYear_groupId: {
                  schoolYear,
                  studentGuid: item.studentGuid,
                  groupId: item.groupId,
                },
              },
            });

            if (existing) {
              await this.prisma.subjectEnrollment.update({
                where: {
                  studentGuid_schoolYear_groupId: {
                  schoolYear,
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
