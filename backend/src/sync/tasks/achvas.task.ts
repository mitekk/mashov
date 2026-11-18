import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';

interface MashovAchva {
  code: number;
  name: string;
  hidden: boolean;
  achvaType: number;
  commonBehaveId: number;
  onDuplicateLesson: boolean;
  onLastBehave: boolean;
  aval: number;
  displayOrder: number;
  teacherId: number;
  justifiable: boolean;
  hideFromStudents: boolean;
  preventPush: boolean;
  showInBehave: boolean;
}

@Injectable()
export class AchvasTask {
  private readonly logger = new Logger(AchvasTask.name);
  public static readonly SOURCE = 'achvas';

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

  /**
   * One run per distinct school, not one run for everybody.
   *
   * The old comment called these "global reference data" and fetched them once
   * from whichever connection answered first. They are not global:
   * apis/get-api-achvas.md carries `teacherId` and `commonBehaveId`, the codes
   * are school-local, and `justifiable` is the school's own policy on whether
   * an absence excuses itself. With one row per code,
   * BehaviorClassifierService answered "is this absence justifiable" from
   * whichever school synced last -- so a child at school B could have an
   * absence labelled justifiable because school A says code 11 is.
   *
   * Keyed by schoolCode rather than by connection because the taxonomy is
   * school-level: two parents at one school must not duplicate it.
   */
  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const connections = await this.prisma.householdConnection.findMany({
      where: {
        userId: { not: null },
        active: true,
        ...(context.connectionId ? { id: context.connectionId } : {}),
      },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
    });

    // One connection per school. Two accounts at the same school would fetch
    // the identical taxonomy twice and race on the same rows.
    const bySchool = new Map<number, (typeof connections)[number]>();
    for (const conn of connections) {
      if (!bySchool.has(conn.schoolCode)) bySchool.set(conn.schoolCode, conn);
    }

    const useSharedSession = !context.connectionId && bySchool.size === 0;
    const targets: Array<(typeof connections)[number] | null> = useSharedSession
      ? [null]
      : [...bySchool.values()];

    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let totalFailedCount = 0;
    const allErrorMessages: string[] = [];

    for (const conn of targets) {
      // Suffixed per school so one school's failure does not read as the
      // other's, the same reason mail_inbox suffixes per connection.
      const source = conn ? `${AchvasTask.SOURCE}:${conn.schoolCode}` : AchvasTask.SOURCE;
      const syncRun = await this.syncRunService.openRun(source, conn?.id ?? context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;
      let failedCount = 0;
      const errorMessages: string[] = [];

      // 0 is the sentinel the schema defaults to and the ownership backfill
      // rewrites; the shared session genuinely does not know its school here.
      const schoolCode = conn?.schoolCode ?? 0;

      try {
        const achvas = conn
          ? await this.mashovClient.getForConnection<MashovAchva[]>(
              '/api/achvas',
              conn.id,
              conn.schoolCode,
              conn.schoolYear,
              conn.username,
              this.encryptionService.decrypt(conn.encryptedPassword),
            )
          : await this.mashovClient.get<MashovAchva[]>('/api/achvas');

        fetchedCount = achvas.length;

        for (const achva of achvas) {
          try {
            await this.prisma.behaviorTypeReference.upsert({
              where: { schoolCode_code: { schoolCode, code: achva.code } },
              create: {
                schoolCode,
                code: achva.code,
                name: achva.name,
                displayOrder: achva.displayOrder,
                justifiable: achva.justifiable,
                hidden: achva.hidden,
                showInBehave: achva.showInBehave,
                hideFromStudents: achva.hideFromStudents,
                rawPayload: achva as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
              update: {
                name: achva.name,
                displayOrder: achva.displayOrder,
                justifiable: achva.justifiable,
                hidden: achva.hidden,
                showInBehave: achva.showInBehave,
                hideFromStudents: achva.hideFromStudents,
                rawPayload: achva as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
            });
            upsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(
              `Failed to upsert achva code ${achva.code} for semel ${schoolCode}: ${msg}`,
            );
            failedCount++;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        }

        await this.syncRunService.closeRun(syncRun.id, 'success', {
          fetchedCount,
          updatedCount: upsertCount,
        });
        this.logger.debug(
          `Achvas sync (semel=${schoolCode}): fetched=${fetchedCount} upserted=${upsertCount}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Achvas sync failed (semel=${schoolCode}): ${msg}`);
        await this.syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: msg });
        failedCount += 1;
        errorMessages.push(msg);
      }

      totalFetchedCount += fetchedCount;
      totalUpsertCount += upsertCount;
      totalFailedCount += failedCount;
      allErrorMessages.push(...errorMessages);
    }

    return {
      status: totalFailedCount > 0 ? 'failed' : 'success',
      summary: {
        fetchedCount: totalFetchedCount,
        createdCount: 0,
        updatedCount: totalUpsertCount,
        failedCount: totalFailedCount,
      },
      errorMessages: allErrorMessages.slice(0, 10),
    };
  }
}
