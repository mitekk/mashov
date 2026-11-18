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
import { calendarSchoolYear } from '../../common/school-year/school-year.service';

/** `apis/get-api-students-id-studentReleases.md`. */
interface MashovStudentRelease {
  id: number;
  studentGuid: string;
  /** The parent who filed it. Read, never stored: see the model doc. */
  contactGuid?: string;
  releaseDate: string;
  startHour: string;
  remark?: string | null;
  status?: number;
  isDeleted?: boolean;
  requestEditTime?: string | null;
}

/**
 * Syncs the early-release requests a parent filed, so the digest can remind
 * them on the day.
 *
 * The digest cannot fetch this itself: it reads local Postgres only and must
 * never touch the Mashov residential egress hop (ADR-0023, ADR-0026). So the
 * sync layer owns the fetch, exactly as it does for homework and behaviour,
 * and the digest reads the table.
 */
@Injectable()
export class ReleasesTask {
  private readonly logger = new Logger(ReleasesTask.name);
  public static readonly SOURCE = 'releases';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  // Hourly. A release filed this morning for this afternoon has to be in the
  // database before the digest run that would remind anyone about it.
  @Cron('7 * * * *')
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
    const fallbackSchoolYear = calendarSchoolYear(new Date());

    for (const student of students) {
      const ordered = orderConnectionsForStudent(student, connections);
      let schoolYear = ordered[0]?.schoolYear ?? fallbackSchoolYear;
      const source = `${ReleasesTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        const referer = 'https://web.mashov.info/students/main/studentsReleaseRequests';
        let items: MashovStudentRelease[] = [];

        for (const conn of ordered) {
          try {
            const password = this.encryptionService.decrypt(conn.encryptedPassword);
            items = await this.mashovClient.getForConnection<MashovStudentRelease[]>(
              `/api/students/${student.studentGuid}/studentReleases`,
              conn.id,
              conn.schoolCode,
              conn.schoolYear,
              conn.username,
              password,
              { headers: { Referer: referer } },
            );
            schoolYear = conn.schoolYear;
            await stampOwnershipIfChanged(this.prisma, student, conn, this.logger);
            break;
          } catch {
            /* try the next connection */
          }
        }

        const rows = Array.isArray(items) ? items : [];
        fetchedCount = rows.length;
        totalFetchedCount += fetchedCount;

        for (const item of rows) {
          try {
            // Naive upstream timestamp: "2026-01-23T00:00:00" becomes UTC
            // midnight, which is the only date representation the digest uses.
            const releaseDate = new Date(item.releaseDate);
            if (Number.isNaN(releaseDate.getTime())) {
              throw new Error(`unparseable releaseDate "${item.releaseDate}"`);
            }
            const requestEditTime = item.requestEditTime ? new Date(item.requestEditTime) : null;

            const data = {
              schoolYear,
              releaseDate,
              startHour: item.startHour ?? '',
              remark: item.remark ?? null,
              status: item.status ?? 0,
              isDeleted: item.isDeleted ?? false,
              requestEditTime:
                requestEditTime && !Number.isNaN(requestEditTime.getTime()) ? requestEditTime : null,
              rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
            };

            await this.prisma.studentRelease.upsert({
              where: {
                studentGuid_schoolYear_releaseId: {
                  studentGuid: student.studentGuid,
                  schoolYear,
                  releaseId: item.id,
                },
              },
              create: { studentGuid: student.studentGuid, releaseId: item.id, ...data },
              update: data,
            });
            upsertCount++;
            totalUpsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert release for ${student.studentGuid}: ${msg}`);
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount,
          updatedCount: upsertCount,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Releases sync failed for ${student.studentGuid}: ${msg}`);
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
