import {
  Controller,
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
};

@Controller('sync')
export class SyncController {
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

    const connection = await this.prisma.householdConnection.findFirst({
      where: { userId, active: true },
      orderBy: { lastLoginAt: 'desc' },
    });

    if (!connection) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: 'No active connection found for this user',
          details: [],
        },
      });
    }

    return this.syncService.refreshAll({ connectionId: connection.id });
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

    const connection = await this.prisma.householdConnection.findFirst({
      where: { userId, active: true },
      orderBy: { lastLoginAt: 'desc' },
    });

    if (!connection) {
      return { ...IDLE_STATUS, phase: 'idle' };
    }

    const read = await this.refreshProgress.read(connection.id);

    if (!read.ok) {
      // `unavailable` keeps the client polling rather than returning a 500:
      // Redis being down is not the user's problem, and the frontend's other
      // two exits (the trigger resolving, the hard cap) still work.
      return { ...IDLE_STATUS, phase: read.reason === 'missing' ? 'idle' : 'unknown' };
    }

    const { envelope } = read;
    const phase = this.resolvePhase(envelope);

    return {
      done: phase !== 'running',
      sourcesCompleted: envelope.tasksSettled,
      sourcesTotal: envelope.tasksTotal,
      phase,
      refreshId: envelope.refreshId,
      startedAt: envelope.startedAt,
      endedAt: envelope.endedAt,
      tasksTotal: envelope.tasksTotal,
      tasksSettled: envelope.tasksSettled,
      tasksFailed: envelope.tasksFailed,
      currentTask: envelope.currentTask,
      tasks: envelope.tasks,
    };
  }

  private resolvePhase(envelope: RefreshEnvelope): SyncStatusPhase {
    if (envelope.phase !== 'running') return envelope.phase;
    // A backend that died mid-refresh never writes a terminal phase. The
    // staleness clock releases every waiting client at once.
    return this.refreshProgress.isStale(envelope) ? 'stale' : 'running';
  }
}
