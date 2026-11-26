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

/**
 * One item of `GET /api/students/{studentGuid}/grades`.
 *
 * `id` and `gradingEventId` are identical in every observed row; only the
 * latter is read. `rate` and `gradeRate` are `0.0` in every observed row --
 * the school weights nothing -- so neither is stored and the subject average
 * the client computes is a plain mean. See `model GradeItem`.
 */
interface MashovGrade {
  year: number;
  studentGuid: string;
  gradingEventId: number;
  grade: number;
  rate: number;
  timestamp: string;
  teacherName: string;
  groupId: number;
  groupName: string;
  subjectName: string;
  eventDate: string;
  id: number;
  gradingPeriod: number;
  gradingEvent: string;
  gradeRate: number;
  gradeTypeId: number;
  gradeType: string;
}

@Injectable()
export class GradesTask {
  private readonly logger = new Logger(GradesTask.name);
  public static readonly SOURCE = 'grades';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: {
        userId: { not: null },
        active: true,
        ...(context.connectionId ? { id: context.connectionId } : {}),
      },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
    });
    if (connections.length === 0) {
      return context.connectionId
        ? reportNoConnectionTarget(
            this.syncRunService,
            this.logger,
            GradesTask.SOURCE,
            context.connectionId,
          )
        : skipNoConnections(this.logger, GradesTask.SOURCE);
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

    // The last fallback, for a child no connection lists (the deliberate
    // unlinked-child edge in `connection-fanout.ts`): it resolves the SAME
    // stored year the year-scoped reads use, so writes and reads cannot drift
    // when the schools API runs ahead of the calendar.
    const fallbackSchoolYear = await currentSchoolYearFor(this.prisma);

    for (const student of students) {
      // Owner first: with two schools this saves a guaranteed 403 per student
      // per run.
      const ordered = orderConnectionsForStudent(student, connections);
      // Seeded from the OWNER's year, not the table's first row: this value
      // survives if every call fails, and labelling a child's rows with
      // another school's year is how reads and writes drift apart.
      let schoolYear = requestedYear ?? ordered[0]?.schoolYear ?? fallbackSchoolYear;
      const source = `${sourcePrefix}${GradesTask.SOURCE}:${student.studentGuid}`;
      const path = `/api/students/${student.studentGuid}/grades`;
      const headers = {
        'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/regularGrades`,
      };
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        let items: MashovGrade[] = [];
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
            items = await this.mashovClient.getForConnection<MashovGrade[]>(
              path,
              conn.id,
              conn.schoolCode,
              connYear,
              conn.username,
              password,
              { headers },
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
              // An empty 200 is not proof the child is in this account --
              // and a child with no grades yet legitimately returns one.
              Array.isArray(items) && items.length > 0,
            );
            break;
          } catch (connErr) {
            const connMsg = connErr instanceof Error ? connErr.message : String(connErr);
            connFailures.push(connMsg);
            this.logger.warn(`Grades: connection ${conn.id} failed for ${student.studentGuid}: ${connMsg}`);
          }
        }
        // Every connection failed, or the child is listed by none. Reporting
        // success here would hide a broken live sync behind a green run. The
        // per-student catch below records the failure.
        if (!answered) {
          throw new Error(
            `every connection failed for ${student.studentGuid} (tried ${connections.length}): ${connFailures.join('; ')}`,
          );
        }

        fetchedCount = items.length;
        totalFetchedCount += fetchedCount;

        for (const item of items) {
          try {
            const eventDate = new Date(item.eventDate);
            const enteredAt = new Date(item.timestamp);

            const fields = {
              grade: item.grade,
              gradingPeriod: item.gradingPeriod,
              gradeTypeId: item.gradeTypeId,
              gradeType: item.gradeType,
              gradingEvent: item.gradingEvent,
              groupId: item.groupId,
              groupName: item.groupName,
              subjectName: item.subjectName,
              teacherName: item.teacherName,
              eventDate,
              enteredAt,
              rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
            };

            await this.prisma.gradeItem.upsert({
              where: {
                studentGuid_schoolYear_gradingEventId: {
                  schoolYear,
                  studentGuid: item.studentGuid,
                  gradingEventId: item.gradingEventId,
                },
              },
              create: {
                schoolYear,
                studentGuid: item.studentGuid,
                gradingEventId: item.gradingEventId,
                ...fields,
              },
              update: {
                schoolYear,
                ...fields,
              },
            });
            upsertCount++;
            totalUpsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert grade item: ${msg}`);
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount,
          updatedCount: upsertCount,
        });
        this.logger.debug(`Grades sync ${student.fullName}: fetched=${fetchedCount} upserted=${upsertCount}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Grades sync failed for ${student.studentGuid}: ${msg}`);
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
