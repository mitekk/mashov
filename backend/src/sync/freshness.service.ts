import { Injectable } from '@nestjs/common';
import { Prisma, SyncRun } from '@prisma/client';
import { SyncRunService } from './sync-run.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  connectionStudentWhere,
  visibleStudentWhere,
} from '../common/student-links';
import {
  calendarSchoolYear,
  SchoolYearService,
} from '../common/school-year/school-year.service';

export type FreshnessState = 'fresh' | 'syncing' | 'stale' | 'degraded';

interface SourceThreshold {
  sources: string[];
  staleThresholdMinutes: number;
}

// Freshness thresholds from PRD FR-13
const SOURCE_THRESHOLDS: SourceThreshold[] = [
  {
    sources: ['notifications', 'mail_counts', 'mail_inbox'],
    staleThresholdMinutes: 15,
  },
  {
    sources: ['homework', 'behavior'],
    staleThresholdMinutes: 24 * 60, // 24 hours
  },
  {
    sources: ['achvas', 'groups', 'lessons_count', 'user_details', 'message_board'],
    staleThresholdMinutes: 7 * 24 * 60, // 7 days
  },
  {
    // Global, not per-student: the roster is what tells us which students exist.
    sources: ['students'],
    staleThresholdMinutes: 24 * 60,
  },
];

/**
 * The sources whose run keys carry a `:<studentGuid>` suffix.
 *
 * Exported because `SettingsService` has to recognise the same keys in order
 * to work out which students a caller's snapshot actually mentions — two
 * copies of this list would drift and silently stop reporting a source.
 */
export const PER_STUDENT_SOURCES = [
  'homework',
  'behavior',
  'groups',
  'lessons_count',
  'message_board',
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long after 1 September an empty year is still unremarkable.
 *
 * The year-start date test is what catches a dead school year, but in the first
 * weeks of a *correct* new year the newest item is legitimately still from last
 * June — teachers have not posted anything yet. Without this grace period a
 * healthy system reports `stale_year` every September, which is when operators
 * are watching the signal most closely. The `observedSchoolYear < expected`
 * test is unaffected and still fires immediately: asking for the wrong year is
 * a fault whatever the date.
 */
const NEW_YEAR_GRACE_DAYS = 45;

export type ContentFreshnessStatus = 'current' | 'stale_year' | 'no_content';

export interface ContentFreshness {
  expectedSchoolYear: number;
  observedSchoolYear: number;
  newestContentAt: string | null;
  contentAgeDays: number | null;
  status: ContentFreshnessStatus;
}

/**
 * The two per-source maps every freshness read needs.
 *
 * Exists so one HTTP request loads them once. `getSourceHealth` used to call
 * `getAllSourceHealth` and `computeFreshness` in parallel, and the latter
 * fetched both maps again -- four database round trips, each formerly a full
 * scan of an unbounded table, for one response.
 */
export interface SyncRunSnapshot {
  allRuns: Map<string, SyncRun>;
  successRuns: Map<string, SyncRun>;
}

export interface SourceHealth {
  source: string;
  status: 'fresh' | 'stale' | 'failed' | 'never_synced';
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorMessage: string | null;
  fetchedCount: number | null;
  staleThresholdMinutes: number;
}

@Injectable()
export class FreshnessService {
  constructor(
    private readonly syncRunService: SyncRunService,
    private readonly prisma: PrismaService,
    private readonly schoolYearService: SchoolYearService,
  ) {}

  /**
   * Loads both per-source maps once, for callers that need more than one read.
   *
   * `householdConnectionId` scopes the snapshot to one caller's connection;
   * omitting it keeps the global view the dashboard freshness read wants.
   */
  async loadSyncRuns(householdConnectionId?: string): Promise<SyncRunSnapshot> {
    const [allRuns, successRuns] = await Promise.all([
      this.syncRunService.getAllSourceHealth(householdConnectionId),
      this.syncRunService.getLatestSuccessfulRuns(householdConnectionId),
    ]);
    return { allRuns, successRuns };
  }

  /**
   * Measures the age of the *content*, not of the sync.
   *
   * This is the check that catches a dead school year. The source thresholds
   * above only ever asked "did a sync run recently", so for five months they
   * answered "fresh" while every GET returned data from a school year that had
   * ended — the crons were succeeding at fetching the wrong year.
   */
  async computeContentFreshness(userId?: string): Promise<ContentFreshness> {
    // Computed per connection and reported at its WORST. A second school with
    // no data yet would otherwise read as a frozen year for the whole
    // household -- and conversely, reading only the most recent connection
    // would hide a genuinely stale school behind a healthy one.
    //
    // Scoped to the CALLER's connections (R4). Unscoped, the worst verdict
    // was taken across every household in the table, so an unrelated family
    // linking a school this morning -- nothing synced yet, so `no_content` --
    // degraded every other household's freshness card. A caller-less read
    // keeps the global view the crons and the digest want, the N1 precedent.
    const connections = await this.prisma.householdConnection.findMany({
      where: { active: true, ...(userId ? { userId } : {}) },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
      select: { id: true, schoolCode: true, schoolYear: true },
    });

    if (connections.length === 0) {
      // No connection to measure a school year against, so the verdict comes
      // from the calendar. A signed-in caller still gets their own children:
      // without the predicate this branch aggregated the whole table too.
      return this.contentFreshnessForConnection(
        null,
        userId ? await visibleStudentWhere(this.prisma, userId) : {},
      );
    }

    const perConnection = await Promise.all(
      connections.map((connection) =>
        this.contentFreshnessForConnection(
          connection,
          connectionStudentWhere(connection.id),
        ),
      ),
    );
    return this.worstContentFreshness(perConnection);
  }

  /**
   * The worst of several per-school verdicts.
   *
   * `stale_year` beats `no_content` beats `current`: a school asking for a
   * dead year is a fault, while a school with nothing yet is merely quiet, and
   * one healthy school must not mask either. `newestContentAt` is the newest
   * across the household, because that is what "when did anything last happen"
   * means to a parent.
   */
  private worstContentFreshness(results: ContentFreshness[]): ContentFreshness {
    const rank: Record<ContentFreshnessStatus, number> = {
      current: 0,
      no_content: 1,
      stale_year: 2,
    };
    const worst = results.reduce((a, b) => (rank[b.status] > rank[a.status] ? b : a));

    const newest = results
      .map((result) => result.newestContentAt)
      .filter((value): value is string => value !== null)
      .sort()
      .reverse()[0] ?? null;

    const ages = results
      .map((result) => result.contentAgeDays)
      .filter((value): value is number => value !== null);

    return {
      ...worst,
      newestContentAt: newest,
      contentAgeDays: ages.length > 0 ? Math.min(...ages) : null,
    };
  }

  /**
   * One school's verdict, over the children a caller may see through it.
   *
   * The student predicate is an ARGUMENT rather than something built here
   * from `connection.id`. `Student.householdConnectionId` is the routing
   * stamp: it says whose credentials fetched the child, and per ADR-0031 that
   * is whichever of two parents at one school synced last, by design. It
   * cannot answer who may see the child, and when it was used for that the
   * other parent's query matched nothing -- no value equals NULL and no value
   * equals somebody else's id -- so their verdict was `no_content`, which
   * `worstContentFreshness` ranks above `current` and which therefore
   * degraded the whole card. The visibility edge is the answer, and the
   * callers pass it.
   */
  private async contentFreshnessForConnection(
    connection: { id: string; schoolCode: number; schoolYear: number } | null,
    studentWhere: Prisma.StudentWhereInput,
  ): Promise<ContentFreshness> {
    const observedSchoolYear = connection?.schoolYear ?? 0;
    const expectedSchoolYear = connection
      ? (await this.schoolYearService.resolveForSchool(connection.schoolCode)).year
      : calendarSchoolYear(new Date());

    const studentGuids = (
      await this.prisma.student.findMany({
        // Scoped to the children this connection lists, so one school's
        // silence is not measured against the other school's content -- by
        // the visibility edge, which admits a child both parents list and a
        // child nobody lists yet, as everywhere else on this branch.
        where: { isActive: true, ...studentWhere },
        select: { studentGuid: true },
      })
    ).map((student) => student.studentGuid);

    const [homework, behavior] = await Promise.all([
      this.prisma.homeworkItem.aggregate({
        where: { studentGuid: { in: studentGuids } },
        _max: { lessonDate: true },
      }),
      this.prisma.behaviorItem.aggregate({
        where: { studentGuid: { in: studentGuids } },
        _max: { eventAt: true },
      }),
    ]);

    const candidates = [homework._max.lessonDate, behavior._max.eventAt].filter(
      (value): value is Date => value instanceof Date,
    );
    const newestContent = candidates.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    if (!newestContent) {
      return {
        expectedSchoolYear,
        observedSchoolYear,
        newestContentAt: null,
        contentAgeDays: null,
        status: 'no_content',
      };
    }

    // A Mashov year named N runs Sep (N-1) to Jun N, so nothing inside the
    // current year can predate 1 September of the year before it.
    const yearStart = new Date(Date.UTC(expectedSchoolYear - 1, 8, 1));
    const graceEndsAt = yearStart.getTime() + NEW_YEAR_GRACE_DAYS * MS_PER_DAY;

    // Inside the grace window a lagging connection year is the CORRECT state,
    // not a fault: `resolveForSchool` jumps on 1 September while Mashov may not
    // open the year for weeks, and reconciliation deliberately keeps the
    // connection on the old year until it does. Degrading the whole dashboard
    // every September is exactly the false positive the grace exists to avoid.
    const withinNewYearGrace = Date.now() <= graceEndsAt;

    const askingForTheWrongYear =
      observedSchoolYear < expectedSchoolYear && !withinNewYearGrace;
    const nothingFromThisYearYet =
      newestContent < yearStart && !withinNewYearGrace;

    const status: ContentFreshnessStatus =
      askingForTheWrongYear || nothingFromThisYearYet ? 'stale_year' : 'current';

    return {
      expectedSchoolYear,
      observedSchoolYear,
      newestContentAt: newestContent.toISOString(),
      contentAgeDays: Math.floor((Date.now() - newestContent.getTime()) / MS_PER_DAY),
      status,
    };
  }

  /**
   * `userId` comes FIRST, deliberately: every caller-less spec call stays
   * `computeFreshness()`, and the snapshot stays an optional second argument
   * for the one caller that has already loaded it.
   */
  async computeFreshness(
    userId?: string,
    snapshot?: SyncRunSnapshot,
  ): Promise<{
    state: FreshnessState;
    lastSyncAt: string | null;
    staleSources: string[];
    contentFreshness: ContentFreshness;
  }> {
    const { successRuns, allRuns } = snapshot ?? (await this.loadSyncRuns());
    const contentFreshness = await this.computeContentFreshness(userId);
    const now = new Date();

    const staleSources: string[] = [];
    let hasAnyRun = false;
    let hasFailure = false;
    let latestSyncAt: Date | null = null;

    for (const threshold of SOURCE_THRESHOLDS) {
      for (const baseSource of threshold.sources) {
        // Check both per-source and per-child sources
        const matchingKeys = Array.from(successRuns.keys()).filter(
          (key) => key === baseSource || key.startsWith(`${baseSource}:`),
        );

        if (matchingKeys.length === 0) {
          // Check if there was any failed attempt
          const failedKey = Array.from(allRuns.keys()).find(
            (key) => key === baseSource || key.startsWith(`${baseSource}:`),
          );
          if (failedKey) {
            hasFailure = true;
            staleSources.push(baseSource);
          }
          continue;
        }

        hasAnyRun = true;

        // Use the most recent successful run across all matching keys (best-wins).
        // A source is only stale if even its freshest run exceeded the threshold.
        // This prevents old shared-session or superseded-connection entries from
        // keeping a source permanently stale after a successful per-connection sync.
        let mostRecentEndedAt: Date | null = null;
        for (const key of matchingKeys) {
          const run = successRuns.get(key);
          if (!run?.endedAt) continue;

          const endedAt = new Date(run.endedAt);
          if (latestSyncAt === null || endedAt > latestSyncAt) {
            latestSyncAt = endedAt;
          }
          if (mostRecentEndedAt === null || endedAt > mostRecentEndedAt) {
            mostRecentEndedAt = endedAt;
          }

          const failedRun = allRuns.get(key);
          if (failedRun?.status === 'failed') {
            hasFailure = true;
          }
        }

        if (mostRecentEndedAt !== null) {
          const ageMinutes = (now.getTime() - mostRecentEndedAt.getTime()) / 60000;
          if (ageMinutes > threshold.staleThresholdMinutes) {
            staleSources.push(baseSource);
          }
        }
      }
    }

    let state: FreshnessState;
    if (!hasAnyRun && !hasFailure) {
      state = 'stale'; // Never synced yet
    } else if (hasFailure && staleSources.length > 2) {
      state = 'degraded';
    } else if (staleSources.length > 0) {
      state = 'stale';
    } else {
      state = 'fresh';
    }

    // A stale year outranks every source threshold: the syncs are fine, the
    // data is wrong, and "fresh" is the most misleading thing we could say.
    if (contentFreshness.status === 'stale_year') {
      state = 'degraded';
    }

    return {
      state,
      lastSyncAt: latestSyncAt?.toISOString() ?? null,
      staleSources,
      contentFreshness,
    };
  }

  async getAllSourceHealth(
    studentGuids: string[],
    snapshot?: SyncRunSnapshot,
  ): Promise<SourceHealth[]> {
    const { allRuns, successRuns } = snapshot ?? (await this.loadSyncRuns());
    const now = new Date();
    const results: SourceHealth[] = [];

    for (const threshold of SOURCE_THRESHOLDS) {
      for (const baseSource of threshold.sources) {
        // Add global sources + per-student sources
        const sources = [baseSource];

        // Add per-student variants if applicable
        if ((PER_STUDENT_SOURCES as readonly string[]).includes(baseSource)) {
          for (const guid of studentGuids) {
            sources.push(`${baseSource}:${guid}`);
          }
        }

        for (const source of sources) {
          const latestRun = allRuns.get(source);

          // Look for the most recent success across the exact key AND any variant keys
          // (e.g. mail_counts:{conn.id}) so per-connection entries are not missed.
          const variantSuccessKeys = Array.from(successRuns.keys()).filter(
            (k) => k === source || k.startsWith(`${source}:`),
          );
          let latestSuccess: SyncRun | undefined;
          for (const k of variantSuccessKeys) {
            const r = successRuns.get(k);
            if (r?.endedAt && (!latestSuccess?.endedAt || r.endedAt > latestSuccess.endedAt)) {
              latestSuccess = r;
            }
          }

          let status: SourceHealth['status'] = 'never_synced';

          if (latestSuccess?.endedAt) {
            const ageMinutes =
              (now.getTime() - new Date(latestSuccess.endedAt).getTime()) / 60000;
            status = ageMinutes <= threshold.staleThresholdMinutes ? 'fresh' : 'stale';
          } else if (latestRun?.status === 'failed') {
            status = 'failed';
          }

          results.push({
            source,
            status,
            lastSuccessAt: latestSuccess?.endedAt?.toISOString() ?? null,
            lastAttemptAt: latestRun?.startedAt?.toISOString() ?? null,
            lastErrorMessage: latestRun?.errorMessage ?? null,
            fetchedCount: latestSuccess?.fetchedCount ?? null,
            staleThresholdMinutes: threshold.staleThresholdMinutes,
          });
        }
      }
    }

    return results;
  }
}
