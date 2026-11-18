import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService, PER_STUDENT_SOURCES } from '../sync/freshness.service';
import type { SyncRunSnapshot } from '../sync/freshness.service';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
  ) {}

  /**
   * Source health for one caller's connection.
   *
   * This read was unscoped: any signed-in user got every household's sources,
   * and because per-student source keys are `<name>:<studentGuid>`, that
   * handed them other families' child identifiers. The connection now filters
   * both `sync_run` reads.
   *
   * The per-student source keys are derived from the caller's own snapshot
   * rather than from `student.findMany`. That matters more than the query
   * filter: `getAllSourceHealth` emits one `<source>:<guid>` row per guid it is
   * handed *whether or not any run exists*, so passing every active child
   * listed every household's child identifiers — with `status: 'never_synced'`
   * — no matter how the sync_run reads were scoped.
   *
   * Known residual, and the reason this is a narrowing rather than a fix:
   * `Student` carries no household column, so per-student tasks iterate every
   * child in the database and stamp those runs with whichever connection
   * triggered the refresh (and cron runs are stamped with none). A caller whose
   * refresh has run can therefore still see a guid that is not theirs. Closing
   * that needs `Student` scoped to a household — a schema change with its own
   * ADR. What is gone is the unconditional enumeration, which leaked every
   * child in the database to every user regardless of sync activity.
   */
  async getSourceHealth(householdConnectionId: string | null) {
    if (!householdConnectionId) {
      return {
        sources: [],
        overallState: 'stale' as const,
        lastFullSyncAt: null,
        contentFreshness: null,
      };
    }

    // One load of the sync_run maps, shared by both reads below. Fetching them
    // per call meant four round trips for this one response.
    const snapshot = await this.freshnessService.loadSyncRuns(householdConnectionId);
    const studentGuids = this.studentGuidsIn(snapshot);

    const [sources, freshness] = await Promise.all([
      this.freshnessService.getAllSourceHealth(studentGuids, snapshot),
      this.freshnessService.computeFreshness(snapshot),
    ]);

    return {
      sources,
      overallState: freshness.state,
      lastFullSyncAt: freshness.lastSyncAt,
      // The age of the content, not of the sync — the only field here that
      // would have caught the frozen school year.
      contentFreshness: freshness.contentFreshness,
    };
  }

  /**
   * The students a snapshot actually mentions, read back out of its run keys.
   *
   * Only an exact `<perStudentSource>:<guid>` shape counts. `mail_counts:<connId>`
   * and `schoolActivities:<userId>` carry a colon too but no student, and a
   * `history:<year>:…` backfill key is not a live source at all.
   */
  private studentGuidsIn(snapshot: SyncRunSnapshot): string[] {
    const guids = new Set<string>();

    for (const key of [...snapshot.allRuns.keys(), ...snapshot.successRuns.keys()]) {
      const separator = key.indexOf(':');
      if (separator === -1) continue;

      const base = key.slice(0, separator);
      if (!(PER_STUDENT_SOURCES as readonly string[]).includes(base)) continue;

      const guid = key.slice(separator + 1);
      if (guid.length > 0 && !guid.includes(':')) guids.add(guid);
    }

    return [...guids];
  }

  async getProfile() {
    const [profile, household] = await Promise.all([
      this.prisma.parentProfile.findFirst(),
      this.prisma.householdConnection.findFirst({
        where: { active: true },
        orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
      }),
    ]);

    if (!profile) return null;

    return {
      upstreamUserId: profile.upstreamUserId,
      displayName: profile.displayName ?? '',
      email: profile.email ?? '',
      cellphone: profile.cellphone ?? '',
      schoolName: household?.schoolName ?? '',
      schoolYear: household?.schoolYear ?? new Date().getFullYear(),
      schoolCode: household?.schoolCode ?? 0,
      detailsState: profile.detailsState,
      updatedAt: profile.updatedAt.toISOString(),
    };
  }
}
