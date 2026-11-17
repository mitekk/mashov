import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { BehaviorClassifierService } from '../behavior-classifier.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import { currentSchoolYearFor } from '../../common/school-year/school-year.scope';

interface MashovOutBehaviorItem {
  studentGuid: string;
  eventCode: number;
  justified: number;
  lessonId: number;
  reporterGuid: string;
  timestamp: string;
  groupId: number;
  lessonType: number;
  lesson: number;
  lessonDate: string;
  lessonReporter: string;
  achvaCode: number;
  achvaName: string;
  achvaAval: number;
  justificationId: number;
  justification: string;
  reporter: string;
  subject: string;
  remark?: string;
}

@Injectable()
export class OutBehaveTask {
  private readonly logger = new Logger(OutBehaveTask.name);
  public static readonly SOURCE = 'out_behave';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly behaviorClassifier: BehaviorClassifierService,
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async execute(context: SyncExecutionContext = {}): Promise<SyncTaskRunResult> {
    const featureEnabled = this.configService.get<string>('FEATURE_OUT_BEHAVE') === 'true';
    if (!featureEnabled) {
      this.logger.debug('OutBehave feature flag is disabled, skipping');
      return {
        status: 'success',
        summary: {
          fetchedCount: 0,
          createdCount: 0,
          updatedCount: 0,
          failedCount: 0,
        },
        errorMessages: [],
      };
    }

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
      const message = `${OutBehaveTask.SOURCE}: refusing year ${requestedYear} on the shared-session path; a historical year needs an explicit connectionId`;
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
      let schoolYear = requestedYear ?? connections[0]?.schoolYear ?? fallbackSchoolYear;
      const source = `${sourcePrefix}${OutBehaveTask.SOURCE}:${student.studentGuid}`;
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        let items: MashovOutBehaviorItem[];
        if (useSharedSession) {
          items = await this.mashovClient.get<MashovOutBehaviorItem[]>(
            `/api/students/${student.studentGuid}/outBehave`,
          );
        } else {
          items = [];
          let answered = false;
          for (const conn of connections) {
            try {
              const password = this.encryptionService.decrypt(conn.encryptedPassword);
              const connYear = requestedYear ?? conn.schoolYear;
              items = await this.mashovClient.getForConnection<MashovOutBehaviorItem[]>(
                `/api/students/${student.studentGuid}/outBehave`,
                conn.id, conn.schoolCode, connYear, conn.username, password,
              );
              schoolYear = connYear;
              answered = true;
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
            const classification = this.behaviorClassifier.classify(item.eventCode);
            const justifiable = await this.behaviorClassifier.isJustifiable(item.achvaCode);
            const remark = item.remark && item.remark !== 'ללא הערות' ? item.remark : null;
            const justification =
              item.justification && item.justification !== 'ללא הערות'
                ? item.justification
                : null;

            await this.prisma.behaviorItem.upsert({
              where: {
                studentGuid_schoolYear_lessonId_eventCode: {
                  schoolYear,
                  studentGuid: item.studentGuid,
                  lessonId: item.lessonId,
                  eventCode: item.eventCode,
                },
              },
              create: {
                schoolYear,
                studentGuid: item.studentGuid,
                lessonId: item.lessonId,
                groupId: item.groupId,
                eventCode: item.eventCode,
                achvaCode: item.achvaCode,
                achvaName: item.achvaName,
                classification: classification.bucket,
                justifiable,
                lessonDate: new Date(item.lessonDate),
                lesson: item.lesson,
                subject: item.subject,
                reporter: item.reporter,
                remark,
                justification,
                eventAt: new Date(item.timestamp),
                rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
              update: {
                schoolYear,
                achvaName: item.achvaName,
                classification: classification.bucket,
                justifiable,
                remark,
                justification,
                rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
              },
            });
            upsertCount++;
            totalUpsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert outBehave item: ${msg}`);
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
        this.logger.error(`OutBehave sync failed for ${student.studentGuid}: ${msg}`);
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
