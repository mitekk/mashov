import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

/**
 * The lifecycle of one manual refresh, as the refresh itself reports it.
 *
 * `GET /sync/status` used to *guess* completion: it counted distinct
 * successful `sync_run.source` values inside a 30-minute window and compared
 * that against a hardcoded 16. Nothing made 16 reachable — source keys are
 * per-student and per-connection, so the real count scales with the household;
 * a failed source never enters the count at all; and feature-flagged tasks
 * open no run. One failure parked the first-login screen one short of the
 * target forever. With two children the same arithmetic tripped `done` early.
 *
 * Redis rather than a `sync_run` row because this is ephemeral UI state with
 * no audit value, while every `sync_run` reader is keyed on `source`: a
 * `'refresh'` source would leak into `FreshnessService.getAllSourceHealth`,
 * `getLatestSuccessfulRuns` and the retention "keep latest per source" rule —
 * the same scar the `history:` exclusion left behind (see ADR-0025).
 */
export type RefreshPhase = 'running' | 'success' | 'partial' | 'failed';

export interface RefreshTaskProgress {
  task: string;
  status: 'running' | 'success' | 'failed';
}

export interface RefreshEnvelope {
  refreshId: string;
  connectionId: string;
  phase: RefreshPhase;
  startedAt: string;
  endedAt: string | null;
  /** Staleness clock, bumped on every write — a dead backend stops moving it. */
  updatedAt: string;
  /** Derived from the wired task list, never a literal. */
  tasksTotal: number;
  tasksSettled: number;
  tasksFailed: number;
  /** Last task to start — drives the UI label. */
  currentTask: string | null;
  tasks: RefreshTaskProgress[];
}

export type RefreshReadResult =
  | { ok: true; envelope: RefreshEnvelope }
  | { ok: false; reason: 'missing' | 'unavailable' };

export const REFRESH_KEY_PREFIX = 'sync:refresh:';

/**
 * A running envelope outlives the slowest plausible refresh (the proxy gives
 * `POST /sync/refresh` a 90s budget) with room for a retry behind it.
 */
export const RUNNING_TTL_SECONDS = 900;

/**
 * A terminal envelope sticks around so a reload *after* completion still sees
 * `done` rather than falling back to `idle` and starting another refresh.
 */
export const TERMINAL_TTL_SECONDS = 600;

/**
 * A `running` envelope whose `updatedAt` is older than this is abandoned —
 * the backend that owned it restarted or died mid-refresh. Treating it as
 * terminal releases every client at once, which is what a per-client timeout
 * cannot do.
 */
export const STALE_RUNNING_MS = 5 * 60_000;

/**
 * How often a running refresh re-writes its envelope even when no task has
 * started or settled.
 *
 * Progress writes alone are not enough to prove liveness: all fifteen parallel
 * tasks start in the same tick, so a single slow task can leave the envelope
 * untouched for as long as it runs. Past `STALE_RUNNING_MS` that looks exactly
 * like a dead backend and every client is told the refresh is over. The
 * heartbeat is what separates "slow" from "gone", so it must stay comfortably
 * below the staleness threshold.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000;

const REFRESH_PHASES: readonly string[] = ['running', 'success', 'partial', 'failed'];

function isRefreshEnvelope(value: unknown): value is RefreshEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.refreshId === 'string' &&
    typeof candidate.connectionId === 'string' &&
    // The enum, not merely `typeof === 'string'`. Anything outside it is not
    // `running`, so `resolvePhase` would pass it through as a terminal phase --
    // reporting `done: true` and handing the client a phase its own type says
    // cannot exist.
    typeof candidate.phase === 'string' &&
    REFRESH_PHASES.includes(candidate.phase) &&
    typeof candidate.tasksTotal === 'number' &&
    typeof candidate.tasksSettled === 'number' &&
    Array.isArray(candidate.tasks)
  );
}

@Injectable()
export class RefreshProgressService {
  private readonly logger = new Logger(RefreshProgressService.name);

  constructor(private readonly redis: RedisService) {}

  private key(connectionId: string): string {
    return `${REFRESH_KEY_PREFIX}${connectionId}`;
  }

  open(connectionId: string, tasksTotal: number): RefreshEnvelope {
    const now = new Date().toISOString();
    return {
      refreshId: randomUUID(),
      connectionId,
      phase: 'running',
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      tasksTotal,
      tasksSettled: 0,
      tasksFailed: 0,
      currentTask: null,
      tasks: [],
    };
  }

  /**
   * Single `SET` with a phase-dependent expiry. Swallows and logs Redis
   * failures on purpose: progress reporting must never be able to fail the
   * refresh it is reporting on.
   */
  async write(envelope: RefreshEnvelope): Promise<void> {
    envelope.updatedAt = new Date().toISOString();
    const ttl = envelope.phase === 'running' ? RUNNING_TTL_SECONDS : TERMINAL_TTL_SECONDS;

    try {
      await this.redis.set(this.key(envelope.connectionId), JSON.stringify(envelope), ttl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not persist refresh progress for connection=${envelope.connectionId}: ${message}`,
      );
    }
  }

  async read(connectionId: string): Promise<RefreshReadResult> {
    let raw: string | null;
    try {
      raw = await this.redis.get(this.key(connectionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not read refresh progress for connection=${connectionId}: ${message}`);
      return { ok: false, reason: 'unavailable' };
    }

    if (!raw) return { ok: false, reason: 'missing' };

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRefreshEnvelope(parsed)) return { ok: false, reason: 'missing' };
      return { ok: true, envelope: parsed };
    } catch {
      // A malformed value is indistinguishable from no value for the caller:
      // either way there is no refresh to report on.
      return { ok: false, reason: 'missing' };
    }
  }

  isStale(envelope: RefreshEnvelope, now: Date = new Date()): boolean {
    const updatedAt = Date.parse(envelope.updatedAt);
    if (Number.isNaN(updatedAt)) return true;
    return now.getTime() - updatedAt > STALE_RUNNING_MS;
  }
}
