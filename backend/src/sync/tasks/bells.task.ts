import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MashovHttpClient } from '../../session/mashov-http.client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRunService } from '../sync-run.service';
import { EncryptionService } from '../../session/encryption.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import { normalizeClock } from '../../common/bells/derive-breaks';

/**
 * One row of `GET /api/bells`, as documented in `apis/get-api-bells.md`.
 *
 * Every field is optional in practice: the endpoint is undocumented and its
 * shape is taken from an open-source client, never verified against the live
 * API. `normalizeItem` therefore validates rather than trusts.
 */
interface MashovBellItem {
  lessonNumber?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

/** One unit of work: a school on a year, and a connection that can ask. */
interface SchoolTarget {
  key: string;
  schoolCode: number;
  schoolYear: number;
  connectionId: string;
  username: string;
  encryptedPassword: string;
}

/**
 * Whether the upstream answered "no such thing".
 *
 * `MashovHttpClient` flattens axios errors into plain `Error`s whose message
 * carries the status (`describeFailure`), so there is no status to read off an
 * error object. Matching the message is the available signal, and the cost of
 * a miss is one `failed` run rather than a silent wrong answer.
 */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && /\bstatus 404\b/.test(error.message);
}

@Injectable()
export class BellsTask {
  private readonly logger = new Logger(BellsTask.name);
  public static readonly SOURCE = 'bells';

  constructor(
    private readonly mashovClient: MashovHttpClient,
    private readonly prisma: PrismaService,
    private readonly syncRunService: SyncRunService,
    private readonly encryptionService: EncryptionService,
  ) {}

  // Weekly on Sunday at 3 AM — a bell schedule changes once a year at most.
  @Cron('0 3 * * 0')
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

    const targets = this.dedupeBySchool(connections, context.schoolYear);
    const sourcePrefix = context.sourcePrefix ?? '';

    let totalFetchedCount = 0;
    let totalUpsertCount = 0;
    let failedCount = 0;
    const errorMessages: string[] = [];

    for (const target of targets) {
      const source = `${sourcePrefix}${BellsTask.SOURCE}:${target.schoolCode}`;
      const syncRun = await this.syncRunService.openRun(source, context.connectionId);
      let fetchedCount = 0;
      let upsertCount = 0;

      try {
        const items = await this.fetch(target);

        // A 404 or an empty array is NOT a failure. `GET /api/bells` has never
        // been verified against the live API and may simply not exist for this
        // school; the read path answers from the bundled default schedule when
        // there are no rows, so a no-op here is a working feature rather than
        // a broken sync (ADR-0037). Only a transport or auth failure is real,
        // and those land in the catch below.
        if (items === null || items.length === 0) {
          this.logger.warn(
            `Bells sync: school ${target.schoolCode} served ${
              items === null ? 'a 404' : 'no periods'
            }; falling back to the default schedule`,
          );
          await this.syncRunService.closeRun(syncRun.id, 'success', { fetchedCount: 0 });
          continue;
        }

        fetchedCount = items.length;
        totalFetchedCount += fetchedCount;

        for (const item of items) {
          const period = this.normalizeItem(item);
          if (!period) {
            // A malformed row is one period missing its times, not a broken
            // run: the other seven still belong in the grid.
            this.logger.warn(
              `Bells sync: skipping unusable period for school ${target.schoolCode}: ${JSON.stringify(item)}`,
            );
            continue;
          }

          try {
            await this.prisma.bellSchedule.upsert({
              where: {
                schoolCode_schoolYear_lesson: {
                  schoolCode: target.schoolCode,
                  schoolYear: target.schoolYear,
                  lesson: period.lesson,
                },
              },
              create: {
                schoolCode: target.schoolCode,
                schoolYear: target.schoolYear,
                lesson: period.lesson,
                startTime: period.startTime,
                endTime: period.endTime,
              },
              update: {
                startTime: period.startTime,
                endTime: period.endTime,
              },
            });
            upsertCount++;
            totalUpsertCount++;
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            this.logger.warn(
              `Failed to upsert bell period ${period.lesson} for school ${target.schoolCode}: ${msg}`,
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
          `Bells sync school ${target.schoolCode}: fetched=${fetchedCount} upserted=${upsertCount}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Bells sync failed for school ${target.schoolCode}: ${msg}`);
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

  /**
   * One target per (school, year), not per connection.
   *
   * The resource is school-wide, so two parents' connections at the same
   * school — or one parent's two children there — describe the same rows. The
   * connections arrive freshest-login first, so the first one for a school is
   * the one likeliest to still authenticate.
   */
  private dedupeBySchool(
    connections: Array<{
      id: string;
      schoolCode: number;
      schoolYear: number | null;
      username: string;
      encryptedPassword: string;
    }>,
    requestedYear: number | undefined,
  ): SchoolTarget[] {
    const byKey = new Map<string, SchoolTarget>();

    for (const connection of connections) {
      // One value feeds both the login year and the row stamp, for the reason
      // spelled out on `SyncExecutionContext.schoolYear`.
      const schoolYear = requestedYear ?? connection.schoolYear ?? 0;
      if (!connection.schoolCode || schoolYear <= 0) continue;

      const key = `${connection.schoolCode}:${schoolYear}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        schoolCode: connection.schoolCode,
        schoolYear,
        connectionId: connection.id,
        username: connection.username,
        encryptedPassword: connection.encryptedPassword,
      });
    }

    return [...byKey.values()];
  }

  /** The school's periods, or `null` when the endpoint answered 404. */
  private async fetch(target: SchoolTarget): Promise<MashovBellItem[] | null> {
    const password = this.encryptionService.decrypt(target.encryptedPassword);
    try {
      const items = await this.mashovClient.getForConnection<MashovBellItem[]>(
        '/api/bells',
        target.connectionId,
        target.schoolCode,
        target.schoolYear,
        target.username,
        password,
        { headers: { 'Referer': 'https://web.mashov.info/students/main/dashboard' } },
      );
      return Array.isArray(items) ? items : [];
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** A validated period, or `null` for a row this task cannot use. */
  private normalizeItem(
    item: MashovBellItem,
  ): { lesson: number; startTime: string; endTime: string } | null {
    const lesson = Number(item?.lessonNumber);
    if (!Number.isInteger(lesson) || lesson <= 0) return null;

    const startTime = normalizeClock(item?.startTime);
    const endTime = normalizeClock(item?.endTime);
    if (!startTime || !endTime) return null;

    return { lesson, startTime, endTime };
  }
}
