import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SyncRun } from '@prisma/client';

/**
 * "1 of 40 items could not be persisted: …", bounded.
 *
 * `n of m` is the diagnosis `source-health` shows the parent's row; without it
 * the page says `failed` and nothing more. The distinct messages are capped
 * because one broken payload shape fails every item, and the column would
 * otherwise carry five hundred copies of the same sentence.
 */
function describeItemFailures(
  failures: number,
  fetched: number,
  messages: readonly string[] = [],
): string {
  const headline = `${failures} of ${fetched} items could not be persisted`;
  const distinct = [...new Set(messages)].slice(0, 3);
  if (distinct.length === 0) return headline;

  const detail = distinct.join('; ').slice(0, 300);
  return `${headline}: ${detail}`;
}

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

  /**
   * Close a run whose body persisted items one at a time, deriving the status
   * from whether any of them failed.
   *
   * ## Why this exists
   *
   * Every per-item task's upsert loop catches a per-item error, counts it and
   * carries on -- which is right, since one malformed row must not cost the
   * other thirty-nine. The run was then closed `'success'` regardless. So a
   * student whose grades ALL failed to persist got a success run carrying
   * `fetchedCount: 40, updatedCount: 0`, and because
   * `getLatestSuccessfulRuns` filters `status = 'success'`, that row satisfied
   * the sync-on-read TTL gate: the section stayed empty for the whole TTL
   * while `source-health` reported `fresh`. That is the same end state as the
   * per-student freshness bug (#60) reached by a different route, and it is
   * invisible on the one page that answers "is syncing working".
   *
   * Only the task's *returned* status was derived correctly; the persisted row
   * was not. One helper so the thirteen tasks that share the loop cannot drift
   * apart about it again.
   *
   * ## Why `failed` and not `partial`
   *
   * `closeRun` accepts `'partial'`, but no task has ever written it to
   * `sync_run`, and `FreshnessService.getAllSourceHealth` picks its
   * `latestFailure` on `status === 'failed'` alone. A `partial` row is
   * therefore neither a success nor a failure to the reader: a source whose
   * only run was `partial` would report `never_synced` with a null error --
   * trading one silent failure for another. `failed` needs no reader surgery,
   * carries `lastErrorMessage` to the settings page, and stays out of
   * `getLatestSuccessfulRuns` so the TTL gate is correctly left unsatisfied
   * and the source retries inside the backoff window instead of waiting out
   * its whole TTL. `connection-fanout.ts` records the same reasoning for
   * choosing `failed` over inventing a `skipped`.
   *
   * The counts are written either way: a run that persisted 39 of 40 should
   * still say so, and `failed` is about whether the source can be trusted to
   * be complete, not about whether anything happened.
   */
  async closeItemRun(
    id: string,
    options: {
      fetchedCount: number;
      createdCount?: number;
      updatedCount?: number;
      upstreamCount?: number;
      localCount?: number;
      /** How many items the loop could not persist. */
      itemFailures: number;
      /** Why, as collected by the loop. Capped before it reaches the column. */
      itemErrors?: readonly string[];
    },
  ): Promise<SyncRun> {
    const { itemFailures, itemErrors, ...counts } = options;
    if (itemFailures <= 0) return this.closeRun(id, 'success', counts);

    return this.closeRun(id, 'failed', {
      ...counts,
      errorMessage: describeItemFailures(itemFailures, counts.fetchedCount, itemErrors),
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
