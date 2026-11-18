import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  orderConnectionsForStudent,
  stampOwnershipIfChanged,
} from '../connection-fanout';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import { currentSchoolYearFor } from '../../common/school-year/school-year.scope';

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
      const message = `${GroupsTask.SOURCE}: refusing year ${requestedYear} on the shared-session path; a historical year needs an explicit connectionId`;
      this.logger.warn(message);
      return {
        status: 'failed',
        summary: { fetchedCount: 0, createdCount: 0, updatedCount: 0, failedCount: 1 },
        errorMessages: [message],
      };
    }

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
      // Owner first. With one school this is the same single connection it
      // always was; with two it saves a guaranteed 403 per student per run.
      const ordered = orderConnectionsForStudent(student, connections);
      // Seeded from the OWNER's year, not the table's first row: this value
      // survives if every call fails, and labelling a child's rows with
      // another school's year is how reads and writes drift apart.
      let schoolYear = requestedYear ?? ordered[0]?.schoolYear ?? fallbackSchoolYear;
      const source = `${sourcePrefix}${GroupsTask.SOURCE}:${student.studentGuid}`;
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
          let answered = false;
          for (const conn of ordered) {
            try {
              const password = this.encryptionService.decrypt(conn.encryptedPassword);
              const connYear = requestedYear ?? conn.schoolYear;
              groups = await this.mashovClient.getForConnection<MashovGroup[]>(
                `/api/students/${student.studentGuid}/groups`,
                conn.id,
                conn.schoolCode,
                connYear,
                conn.username,
                password,
                {
                  headers: {
                    'Referer': `https://web.mashov.info/students/main/students/${student.studentGuid}/behaveCounter`,
                  },
                },
              );
              schoolYear = connYear;
              answered = true;
              // A success on a non-owner re-stamps, so a child who moved
              // school stops costing a failed call on every later run.
              await stampOwnershipIfChanged(this.prisma, student, conn, this.logger);
              break;
            } catch (connErr) {
              const connMsg = connErr instanceof Error ? connErr.message : String(connErr);
              this.logger.warn(`Groups: connection ${conn.id} failed for ${student.studentGuid}: ${connMsg}`);
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
