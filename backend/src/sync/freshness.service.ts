import { Injectable } from '@nestjs/common';
import { SyncRunService } from './sync-run.service';

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
];

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
  constructor(private readonly syncRunService: SyncRunService) {}

  async computeFreshness(): Promise<{
    state: FreshnessState;
    lastSyncAt: string | null;
    staleSources: string[];
  }> {
    const successRuns = await this.syncRunService.getLatestSuccessfulRuns();
    const allRuns = await this.syncRunService.getAllSourceHealth();
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

        for (const key of matchingKeys) {
          const run = successRuns.get(key);
          if (!run?.endedAt) continue;

          const endedAt = new Date(run.endedAt);
          if (latestSyncAt === null || endedAt > latestSyncAt) {
            latestSyncAt = endedAt;
          }

          const ageMinutes = (now.getTime() - endedAt.getTime()) / 60000;
          if (ageMinutes > threshold.staleThresholdMinutes) {
            if (!staleSources.includes(baseSource)) {
              staleSources.push(baseSource);
            }
          }

          const failedRun = allRuns.get(key);
          if (failedRun?.status === 'failed') {
            hasFailure = true;
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

    return {
      state,
      lastSyncAt: latestSyncAt?.toISOString() ?? null,
      staleSources,
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
          const latestSuccess = successRuns.get(source);

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
