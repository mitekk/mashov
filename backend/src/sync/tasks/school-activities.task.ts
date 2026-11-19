import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import sanitizeHtml = require('sanitize-html');
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import { reportNoConnectionTarget } from '../connection-fanout';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';

/** `apis/get-api-schoolActivities-permitted.md`. */
interface MashovSchoolActivity {
  id: number;
  createTime?: string | null;
  activityStartDate: string;
  activityEndDate?: string | null;
  activityType?: number;
  title?: string | null;
  description?: string | null;
  endAnswerDate: string;
  isAnswered?: boolean;
}

/**
 * Syncs the consent forms awaiting a parent's answer.
 *
 * Household-scoped, unlike every other sync task here: the endpoint takes no
 * studentGuid, and `isAnswered` is the answer of whoever's session asked. So
 * this iterates **connections**, not students, and keys its rows on the
 * connection's `userId`. A connection with no `userId` is skipped rather than
 * stored against nobody -- a row whose owner is unknown cannot answer "has
 * this parent signed it yet", which is the only question the digest asks of it.
 */
@Injectable()
export class SchoolActivitiesTask {
  private readonly logger = new Logger(SchoolActivitiesTask.name);
  public static readonly SOURCE = 'schoolActivities';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  // Twice a day is plenty: a consent deadline is days away, never minutes.
  @Cron('23 5,17 * * *')
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

    // R11: a named connection with no usable target. This task has no
    // shared-session fallback at all, so the loop below simply would not run
    // -- no run, nothing fetched, `success` with every count zero.
    if (context.connectionId && connections.length === 0) {
      return reportNoConnectionTarget(
        this.syncRunService,
        this.logger,
        SchoolActivitiesTask.SOURCE,
        context.connectionId,
      );
    }

    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    for (const conn of connections) {
      const userId = conn.userId;
      if (!userId) continue;

      const source = `${SchoolActivitiesTask.SOURCE}:${userId}`;
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        const password = this.encryptionService.decrypt(conn.encryptedPassword);
        const items = await this.mashovClient.getForConnection<MashovSchoolActivity[]>(
          '/api/schoolActivities/permitted',
          conn.id,
          conn.schoolCode,
          conn.schoolYear,
          conn.username,
          password,
          { headers: { Referer: 'https://web.mashov.info/students/main/schoolActivities' } },
        );

        const rows = Array.isArray(items) ? items : [];
        fetchedCount = rows.length;
        totalFetchedCount += fetchedCount;

        for (const item of rows) {
          try {
            const activityStartDate = new Date(item.activityStartDate);
            const endAnswerDate = new Date(item.endAnswerDate);
            if (Number.isNaN(activityStartDate.getTime()) || Number.isNaN(endAnswerDate.getTime())) {
              throw new Error(`unparseable activity dates on activity ${item.id}`);
            }
            const activityEndDate = item.activityEndDate
              ? new Date(item.activityEndDate)
              : activityStartDate;
            const createTime = item.createTime ? new Date(item.createTime) : null;

            // The consent letter is rich HTML. Stripped to text here so nothing
            // downstream has to deal with markup; the digest never sends it to
            // the model either way, because it names staff and other children.
            const descriptionText = item.description
              ? sanitizeHtml(item.description, { allowedTags: [], allowedAttributes: {} }).trim()
              : null;

            const data = {
              schoolYear: conn.schoolYear,
              activityType: item.activityType ?? 0,
              title: (item.title ?? '').trim(),
              descriptionText,
              activityStartDate,
              activityEndDate: Number.isNaN(activityEndDate.getTime())
                ? activityStartDate
                : activityEndDate,
              endAnswerDate,
              isAnswered: item.isAnswered ?? false,
              createTime: createTime && !Number.isNaN(createTime.getTime()) ? createTime : null,
              rawPayload: item as unknown as import('@prisma/client').Prisma.InputJsonValue,
            };

            // The connection belongs in the key: activityId is a per-school
            // counter -- literally 1 in the captured payload -- and userId is
            // the merged household, so without it one school's consent request
            // overwrites the other's. The digest reports consent deadlines, so
            // the parent would simply never be told about one of them.
            await this.prisma.schoolActivity.upsert({
              where: {
                userId_householdConnectionId_schoolYear_activityId: {
                  userId,
                  householdConnectionId: conn.id,
                  schoolYear: conn.schoolYear,
                  activityId: item.id,
                },
              },
              create: {
                userId,
                householdConnectionId: conn.id,
                activityId: item.id,
                ...data,
              },
              update: { ...data, householdConnectionId: conn.id },
            });
            upsertCount++;
            totalUpsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(`Failed to upsert school activity: ${msg}`);
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
        this.logger.error(`School activities sync failed for connection ${conn.id}: ${msg}`);
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
