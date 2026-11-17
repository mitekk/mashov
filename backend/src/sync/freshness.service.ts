import { Injectable } from '@nestjs/common';
import { SyncRun } from '@prisma/client';
import { SyncRunService } from './sync-run.service';
import { PrismaService } from '../prisma/prisma.service';
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
   * Measures the age of the *content*, not of the sync.
   *
   * This is the check that catches a dead school year. The source thresholds
   * above only ever asked "did a sync run recently", so for five months they
   * answered "fresh" while every GET returned data from a school year that had
   * ended — the crons were succeeding at fetching the wrong year.
   */
  async computeContentFreshness(): Promise<ContentFreshness> {
    const connection = await this.prisma.householdConnection.findFirst({
      where: { active: true },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
      select: { schoolCode: true, schoolYear: true },
    });

    const observedSchoolYear = connection?.schoolYear ?? 0;
    const expectedSchoolYear = connection
      ? (await this.schoolYearService.resolveForSchool(connection.schoolCode)).year
      : calendarSchoolYear(new Date());

    const studentGuids = (
      await this.prisma.student.findMany({
        where: { isActive: true },
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

    const askingForTheWrongYear = observedSchoolYear < expectedSchoolYear;
    const nothingFromThisYearYet =
      newestContent < yearStart && Date.now() > graceEndsAt;

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

  async computeFreshness(): Promise<{
    state: FreshnessState;
    lastSyncAt: string | null;
    staleSources: string[];
    contentFreshness: ContentFreshness;
  }> {
    const successRuns = await this.syncRunService.getLatestSuccessfulRuns();
    const allRuns = await this.syncRunService.getAllSourceHealth();
    const contentFreshness = await this.computeContentFreshness();
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

  async getAllSourceHealth(studentGuids: string[]): Promise<SourceHealth[]> {
    const allRuns = await this.syncRunService.getAllSourceHealth();
    const successRuns = await this.syncRunService.getLatestSuccessfulRuns();
    const now = new Date();
    const results: SourceHealth[] = [];

    for (const threshold of SOURCE_THRESHOLDS) {
      for (const baseSource of threshold.sources) {
        // Add global sources + per-student sources
        const sources = [baseSource];

        // Add per-student variants if applicable
        if (['homework', 'behavior', 'groups', 'lessons_count', 'message_board'].includes(baseSource)) {
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
