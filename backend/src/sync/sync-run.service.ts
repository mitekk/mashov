import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SyncRun } from '@prisma/client';

@Injectable()
export class SyncRunService {
  constructor(private readonly prisma: PrismaService) {}

  async openRun(source: string, householdConnectionId?: string): Promise<SyncRun> {
    return this.prisma.syncRun.create({
      data: {
        source,
        status: 'running',
        startedAt: new Date(),
        householdConnectionId: householdConnectionId ?? null,
      },
    });
  }

  async closeRun(
    id: string,
    status: 'success' | 'failed' | 'partial',
    options?: {
      fetchedCount?: number;
      createdCount?: number;
      updatedCount?: number;
      // mail_counts only: Mashov's unreadConversations against our own derived count,
      // so their drift is queryable without container logs.
      upstreamCount?: number;
      localCount?: number;
      errorMessage?: string;
    },
  ): Promise<SyncRun> {
    return this.prisma.syncRun.update({
      where: { id },
      data: {
        status,
        endedAt: new Date(),
        ...options,
      },
    });
  }

  async getLatestSuccessfulRun(source: string): Promise<SyncRun | null> {
    return this.prisma.syncRun.findFirst({
      where: { source, status: 'success' },
      orderBy: { endedAt: 'desc' },
    });
  }

  async getLatestRun(source: string): Promise<SyncRun | null> {
    return this.prisma.syncRun.findFirst({
      where: { source },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * The latest run per source, resolved in the database.
   *
   * This and `getLatestSuccessfulRuns` below used to `findMany()` the entire
   * table and dedupe in JS. `sync_run` has no upper bound -- the crons in
   * ./tasks open roughly 1,600 rows a day between them, several of those per
   * student -- and `SettingsService.getSourceHealth` triggered four such loads
   * per request. That is what pushed `GET /api/v1/settings/source-health` past
   * the frontend proxy's 15s budget and, by blocking the event loop while it
   * materialised every row, dragged neighbouring requests over it too.
   *
   * `DISTINCT ON` returns one row per source, so the result set is now the
   * number of sources rather than the size of the table.
   *
   * `householdConnectionId` scopes the read to one caller. Without it
   * `GET /api/v1/settings/source-health` handed every signed-in user every
   * household's sources — and per-student source keys embed the student GUID,
   * so that leaked other families' child identifiers. The unscoped form stays
   * for the dashboard-wide freshness read, which is deliberately global.
   *
   * A scoped read deliberately keeps rows with a NULL connection. Every
   * `@Cron` entrypoint calls `execute()` with no context, so `openRun` stores
   * `householdConnectionId = null` for all of them: excluding those would
   * report `never_synced` for a dozen sources whose crons are succeeding every
   * twelve minutes, turning the one page that answers "is syncing working"
   * into a page that always says no.
   */
  async getAllSourceHealth(householdConnectionId?: string): Promise<Map<string, SyncRun>> {
    const runs = householdConnectionId
      ? await this.prisma.$queryRaw<SyncRun[]>`
          SELECT DISTINCT ON (source) *
          FROM sync_run
          WHERE ("householdConnectionId" = ${householdConnectionId}
                 OR "householdConnectionId" IS NULL)
          ORDER BY source, "startedAt" DESC
        `
      : await this.prisma.$queryRaw<SyncRun[]>`
          SELECT DISTINCT ON (source) *
          FROM sync_run
          ORDER BY source, "startedAt" DESC
        `;
    return new Map(runs.map((run) => [run.source, run]));
  }

  /**
   * `NULLS LAST` is deliberate, and a behaviour fix rather than a port.
   *
   * Postgres sorts DESC with NULLS FIRST, so the old `orderBy: { endedAt:
   * 'desc' }` preferred a `success` row whose `endedAt` was still null -- and
   * every consumer then skipped it (`if (!run?.endedAt) continue`), reporting
   * the source as never synced while a perfectly good older run sat behind it.
   */
  async getLatestSuccessfulRuns(householdConnectionId?: string): Promise<Map<string, SyncRun>> {
    const runs = householdConnectionId
      ? await this.prisma.$queryRaw<SyncRun[]>`
          SELECT DISTINCT ON (source) *
          FROM sync_run
          WHERE status = 'success'
            AND ("householdConnectionId" = ${householdConnectionId}
                 OR "householdConnectionId" IS NULL)
          ORDER BY source, "endedAt" DESC NULLS LAST
        `
      : await this.prisma.$queryRaw<SyncRun[]>`
          SELECT DISTINCT ON (source) *
          FROM sync_run
          WHERE status = 'success'
          ORDER BY source, "endedAt" DESC NULLS LAST
        `;
    return new Map(runs.map((run) => [run.source, run]));
  }
}
