import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService } from '../sync/freshness.service';

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
   * Known residual, and the reason this is a narrowing rather than a fix:
   * `Student` carries no household column, so the per-student tasks iterate
   * every child in the database and stamp those runs with whichever connection
   * triggered the refresh. Until `Student` is scoped, a caller's own rows can
   * still name a child who is not theirs. That is a schema change with its own
   * ADR; this stops the read itself from fanning out across households.
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

    const studentGuids = (
      await this.prisma.student.findMany({
        where: { isActive: true },
        select: { studentGuid: true },
      })
    ).map((student) => student.studentGuid);

    // One load of the sync_run maps, shared by both reads below. Fetching them
    // per call meant four round trips for this one response.
    const snapshot = await this.freshnessService.loadSyncRuns(householdConnectionId);

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
