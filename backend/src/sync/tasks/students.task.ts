import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { MashovSessionService } from '../../session/mashov-session.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';

/**
 * Re-fetches the children roster.
 *
 * Children exist only on the `POST /api/login` response — there is no roster
 * endpoint — so the only way to notice that a child moved up a grade is to log
 * in again and re-read `accessToken.children[]`. Until this task existed there
 * was no such path, which is why `classCode`/`classNum` stayed on the 2025/26
 * class while all 13 other crons reported success.
 *
 * Every other task iterates `prisma.student.findMany`, so this one has to land
 * before them — see `SyncService.runManualRefresh`.
 */
@Injectable()
export class StudentsTask {
  private readonly logger = new Logger(StudentsTask.name);
  public static readonly SOURCE = 'students';

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly sessionService: MashovSessionService,
  ) {}

  @Cron('*/30 * * * *')
  async run(): Promise<void> {
    await this.execute();
  }

  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: {
        active: true,
        ...(context.connectionId ? { id: context.connectionId } : {}),
      },
    });

    let created = 0;
    let updated = 0;
    let deactivated = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    for (const connection of connections) {
      const syncRun = await this.syncRunService.openRun(
        StudentsTask.SOURCE,
        connection.id,
      );

      try {
        const result = await this.sessionService.refreshRosterForConnection(
          connection.id,
        );

        created += result.created;
        updated += result.updated;
        deactivated += result.deactivated;

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount: result.created + result.updated,
          createdCount: result.created,
          updatedCount: result.updated,
        });

        this.logger.debug(
          `Roster sync ${connection.id} (year=${result.year}): created=${result.created} updated=${result.updated} deactivated=${result.deactivated}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Roster sync failed for connection ${connection.id}: ${msg}`);
        await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
        failedCount += 1;
        if (errorMessages.length < 10) errorMessages.push(msg);
      }
    }

    return {
      status: failedCount > 0 ? 'failed' : 'success',
      summary: {
        fetchedCount: created + updated + deactivated,
        createdCount: created,
        updatedCount: updated,
        failedCount,
      },
      errorMessages,
    };
  }
}
