import {
  Controller,
  Logger,
  Post,
  Get,
  HttpCode,
  HttpStatus,
  Req,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { SyncService } from './sync.service';
import type { ManualSyncRefreshResponse, ManualSyncStatus } from './sync.types';
import { PrismaService } from '../prisma/prisma.service';
import { RefreshProgressService } from './refresh-progress.service';
import type { RefreshEnvelope, RefreshTaskProgress } from './refresh-progress.service';

/**
 * What the client is told about the refresh it is waiting on.
 *
 * `idle` — nothing in flight. `stale` — a `running` envelope that stopped
 * being updated, so whoever owned it is gone. `unknown` — Redis could not be
 * read, which is explicitly not an error: the client keeps polling.
 */
export type SyncStatusPhase =
  | 'idle'
  | 'running'
  | 'stale'
  | 'success'
  | 'partial'
  | 'failed'
  | 'unknown';

/** One school's own progress, so the UI can say which is still syncing. */
export interface SyncStatusSchool {
  schoolId: string;
  semel: number;
  schoolName: string | null;
  phase: SyncStatusPhase;
  tasksTotal: number;
  tasksSettled: number;
  tasksFailed: number;
  currentTask: string | null;
}

export interface SyncStatusResponse {
  /** Legacy keys, same names and types as before, for old clients. */
  done: boolean;
  sourcesCompleted: number;
  sourcesTotal: number;
  phase: SyncStatusPhase;
  refreshId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  tasksTotal: number;
  tasksSettled: number;
  tasksFailed: number;
  currentTask: string | null;
  tasks: RefreshTaskProgress[];
  /**
   * Per-school breakdown. One entry per active connection, so the first-login
   * screen can name the school it is waiting on rather than showing a bar that
   * stalls for no visible reason.
   */
  schools: SyncStatusSchool[];
}

const IDLE_STATUS: Omit<SyncStatusResponse, 'phase'> = {
  done: false,
  sourcesCompleted: 0,
  sourcesTotal: 0,
  refreshId: null,
  startedAt: null,
  endedAt: null,
  tasksTotal: 0,
  tasksSettled: 0,
  tasksFailed: 0,
  currentTask: null,
  tasks: [],
  schools: [],
};

/** Worst-wins, so one school still running keeps the household running. */
const PHASE_RANK: Record<SyncStatusPhase, number> = {
  idle: 0,
  success: 1,
  unknown: 2,
  partial: 3,
  stale: 4,
  failed: 5,
  running: 6,
};

@Controller('sync')
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(
    private readonly syncService: SyncService,
    private readonly prisma: PrismaService,
    private readonly refreshProgress: RefreshProgressService,
  ) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async refresh(@Req() req: Request) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }

    const connections = await this.resolveConnections(userId, req);

    // Sequential, concurrency 1. Two simultaneous Mashov logins from one
    // household is asking for a rate limit, and `refreshAll` already dedupes
    // per connection so there is nothing to gain from overlapping them.
    //
    // Caught per connection: one school's hard failure used to 500 the whole
    // endpoint and throw the other school's successful refresh away, which is
    // why the `?? 'failed'` below was unreachable.
    const results: Array<ManualSyncRefreshResponse | null> = [];
    let firstError: unknown;
    for (const connection of connections) {
      try {
        results.push(await this.syncService.refreshAll({ connectionId: connection.id }));
      } catch (error) {
        firstError ??= error;
        results.push(null);
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Refresh of connection ${connection.id} threw: ${message}`);
      }
    }

    const settled = results.filter((result): result is ManualSyncRefreshResponse => !!result);
    // A refresh that achieved nothing stays a 500, or `SyncingPageClient`'s
    // `default:` branch stops reporting a failed trigger.
    if (settled.length === 0) throw firstError;

    const schools = connections.map((connection, index) => ({
      schoolId: connection.id,
      semel: connection.schoolCode,
      schoolName: connection.schoolName,
      status: (results[index]?.status ?? 'failed') as ManualSyncStatus,
    }));

    // Every legacy field described the FIRST connection only: `status`,
    // `tasks`, the per-task counts. A household where A succeeded and B came
    // back `partial` was told `success`.
    //
    // Worst-wins over the per-school statuses, reduced with the same
    // `PHASE_RANK` `getStatus` uses rather than a second ranking table. The
    // span is earliest start to latest end -- the refresh as the parent
    // experienced it, matching `getStatus`'s choice over its envelopes. With
    // one school all of this is byte-identical to before, so existing clients
    // and the six e2e MOCK constants keep working; `schools` is additive.
    const startedAt = settled
      .map((result) => result.startedAt)
      .reduce((earliest, value) => (value < earliest ? value : earliest));
    const endedAt = settled
      .map((result) => result.endedAt)
      .reduce((latest, value) => (value > latest ? value : latest));

    return {
      status: schools
        .map((school) => school.status)
        .reduce((worst, status) => (PHASE_RANK[status] > PHASE_RANK[worst] ? status : worst)),
      startedAt,
      endedAt,
      durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
      tasks: settled.flatMap((result) => result.tasks),
      schools,
    };
  }

  /**
   * The connections a request is about: one when `schoolId` names it, else all
   * of the user's active ones.
   *
   * A `schoolId` belonging to another household is a 404, not a 403 -- a 403
   * would confirm the id exists.
   */
  private async resolveConnections(userId: string, req: Request) {
    const schoolId = typeof req.query?.schoolId === 'string' ? req.query.schoolId : undefined;

    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, active: true, ...(schoolId ? { id: schoolId } : {}) },
      orderBy: { lastLoginAt: 'desc' },
      select: { id: true, schoolCode: true, schoolName: true },
    });

    if (connections.length === 0) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: schoolId
            ? 'No such school is connected to this account'
            : 'No active connection found for this user',
          details: [],
        },
      });
    }

    return connections;
  }

  /**
   * Completion as the refresh itself reports it, never as a count of rows.
   *
   * This used to group `sync_run` by `source`, keep the successes from the
   * last 30 minutes, and call it done at 16. Source keys are per-student and
   * per-connection, so 16 was only ever right for one child with every source
   * succeeding: a single failed source parked the first-login screen one short
   * of a target it could never reach, and two children tripped `done` while a
   * third of the refresh was still running. It no longer reads `sync_run` at
   * all — which retires the `history:` exclusion and the 30-minute window with
   * it.
   */
  @Get('status')
  async getStatus(@Req() req: Request): Promise<SyncStatusResponse> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }

    const schoolId = typeof req.query?.schoolId === 'string' ? req.query.schoolId : undefined;

    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, active: true, ...(schoolId ? { id: schoolId } : {}) },
      orderBy: { lastLoginAt: 'desc' },
      select: { id: true, schoolCode: true, schoolName: true },
    });

    if (connections.length === 0) {
      // Still `idle` rather than 404 for the no-connection case, which is what
      // the first-login screen polls before a connection exists. A named
      // schoolId that resolves to nothing is the one 404.
      if (schoolId) {
        throw new NotFoundException({
          error: {
            code: 'NOT_FOUND',
            message: 'No such school is connected to this account',
            details: [],
          },
        });
      }
      return { ...IDLE_STATUS, phase: 'idle' };
    }

    const reads = await Promise.all(
      connections.map(async (connection) => ({
        connection,
        read: await this.refreshProgress.read(connection.id),
      })),
    );

    const schools: SyncStatusSchool[] = reads.map(({ connection, read }) => {
      if (!read.ok) {
        return {
          schoolId: connection.id,
          semel: connection.schoolCode,
          schoolName: connection.schoolName,
          phase: read.reason === 'missing' ? ('idle' as const) : ('unknown' as const),
          tasksTotal: 0,
          tasksSettled: 0,
          tasksFailed: 0,
          currentTask: null,
        };
      }
      return {
        schoolId: connection.id,
        semel: connection.schoolCode,
        schoolName: connection.schoolName,
        phase: this.resolvePhase(read.envelope),
        tasksTotal: read.envelope.tasksTotal,
        tasksSettled: read.envelope.tasksSettled,
        tasksFailed: read.envelope.tasksFailed,
        currentTask: read.envelope.currentTask,
      };
    });

    const envelopes = reads
      .map(({ read }) => (read.ok ? read.envelope : null))
      .filter((envelope): envelope is RefreshEnvelope => envelope !== null);

    if (envelopes.length === 0) {
      // Every read failed. `unavailable` keeps the client polling rather than
      // returning a 500: Redis being down is not the user's problem, and the
      // frontend's other two exits (the trigger resolving, the hard cap) still
      // work.
      const anyUnavailable = reads.some(
        ({ read }) => !read.ok && read.reason !== 'missing',
      );
      return {
        ...IDLE_STATUS,
        phase: anyUnavailable ? 'unknown' : 'idle',
        schools,
      };
    }

    // Worst-wins: `done` only once EVERY school has stopped running. One
    // school finishing first must not release the first-login screen while the
    // other is still fetching, which is what a per-connection read did.
    const phase = schools
      .map((school) => school.phase)
      .reduce((a, b) => (PHASE_RANK[b] > PHASE_RANK[a] ? b : a));

    const sum = (pick: (envelope: RefreshEnvelope) => number) =>
      envelopes.reduce((total, envelope) => total + pick(envelope), 0);

    // The newest start and the latest end across the household: the refresh as
    // the user experiences it, not as one connection saw it.
    const startedAt = envelopes.map((envelope) => envelope.startedAt).sort()[0] ?? null;
    const endedAts = envelopes.map((envelope) => envelope.endedAt);
    const endedAt = endedAts.includes(null)
      ? null
      : (endedAts.filter((value): value is string => value !== null).sort().reverse()[0] ?? null);

    const tasksTotal = sum((envelope) => envelope.tasksTotal);
    const tasksSettled = sum((envelope) => envelope.tasksSettled);

    return {
      done: phase !== 'running',
      sourcesCompleted: tasksSettled,
      sourcesTotal: tasksTotal,
      phase,
      // One id is all a client can use; the per-school breakdown carries the
      // rest.
      refreshId: envelopes[0].refreshId,
      startedAt,
      endedAt,
      tasksTotal,
      tasksSettled,
      tasksFailed: sum((envelope) => envelope.tasksFailed),
      currentTask:
        schools.find((school) => school.phase === 'running')?.currentTask ??
        envelopes[0].currentTask,
      tasks: envelopes.flatMap((envelope) => envelope.tasks),
      schools,
    };
  }

  private resolvePhase(envelope: RefreshEnvelope): SyncStatusPhase {
    if (envelope.phase !== 'running') return envelope.phase;
    // A backend that died mid-refresh never writes a terminal phase. The
    // staleness clock releases every waiting client at once.
    return this.refreshProgress.isStale(envelope) ? 'stale' : 'running';
  }
}
