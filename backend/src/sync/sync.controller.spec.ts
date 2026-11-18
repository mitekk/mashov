import type { Request } from 'express';
import { SyncController } from './sync.controller';
import type { SyncService } from './sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import { STALE_RUNNING_MS } from './refresh-progress.service';
import type {
  RefreshEnvelope,
  RefreshProgressService,
  RefreshReadResult,
} from './refresh-progress.service';

function makeEnvelope(overrides: Partial<RefreshEnvelope> = {}): RefreshEnvelope {
  const now = new Date().toISOString();
  return {
    refreshId: 'refresh-1',
    connectionId: 'conn-1',
    phase: 'running',
    startedAt: now,
    endedAt: null,
    updatedAt: now,
    tasksTotal: 16,
    tasksSettled: 0,
    tasksFailed: 0,
    currentTask: null,
    tasks: [],
    ...overrides,
  };
}

function makeController(
  read: RefreshReadResult,
  options: { connection?: { id: string } | null } = {},
) {
  const syncRun = {
    groupBy: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
  };
  const prisma = {
    householdConnection: {
      findFirst: jest
        .fn()
        .mockResolvedValue(options.connection === undefined ? { id: 'conn-1' } : options.connection),
    },
    syncRun,
  } as unknown as PrismaService;

  const syncService = { refreshAll: jest.fn() } as unknown as SyncService;
  const refreshProgress = {
    read: jest.fn().mockResolvedValue(read),
    isStale: jest.fn((envelope: RefreshEnvelope, now: Date = new Date()) => {
      const updatedAt = Date.parse(envelope.updatedAt);
      if (Number.isNaN(updatedAt)) return true;
      return now.getTime() - updatedAt > STALE_RUNNING_MS;
    }),
  } as unknown as RefreshProgressService;

  return {
    controller: new SyncController(syncService, prisma, refreshProgress),
    syncRun,
    refreshProgress,
  };
}

const REQUEST = { user: { userId: 'user-1' } } as unknown as Request;

describe('SyncController', () => {
  describe('getStatus', () => {
    it('reports done when the refresh envelope reached a terminal state even though a source failed', async () => {
      // The production report. A household with four children has 21 sources,
      // one of which (`groups:<guid>`) fails every time upstream refuses it.
      // The old controller counted successful sources against a hardcoded 16
      // and parked the first-login screen one short, forever. A failed source
      // is per-source health — it is not a reason to trap the user on a
      // spinner with no exit.
      const { controller } = makeController({
        ok: true,
        envelope: makeEnvelope({
          phase: 'partial',
          tasksTotal: 21,
          tasksSettled: 21,
          tasksFailed: 1,
          endedAt: new Date().toISOString(),
        }),
      });

      const result = await controller.getStatus(REQUEST);

      expect(result.done).toBe(true);
      expect(result.phase).toBe('partial');
      expect(result.sourcesCompleted).toBe(21);
      expect(result.sourcesTotal).toBe(21);
      expect(result.tasksFailed).toBe(1);
    });

    it('does not query sync_run', async () => {
      // Guard against the whole bug class: completion is the refresh's own
      // report, so no count of rows in an unbounded audit table can mean
      // "finished" again — not a stale cron success inside a time window,
      // not a history backfill, not a per-student source key.
      const { controller, syncRun } = makeController({
        ok: true,
        envelope: makeEnvelope(),
      });

      await controller.getStatus(REQUEST);

      for (const [name, fn] of Object.entries(syncRun)) {
        expect(fn as jest.Mock).not.toHaveBeenCalled();
        expect(name).toEqual(expect.any(String));
      }
    });

    it('reports running and not done while tasks are still settling', async () => {
      // Two children: 29 real sources. The old arithmetic tripped `done` at 16
      // while a third of the refresh was still in flight.
      const { controller } = makeController({
        ok: true,
        envelope: makeEnvelope({
          phase: 'running',
          tasksTotal: 29,
          tasksSettled: 20,
          currentTask: 'homework',
        }),
      });

      const result = await controller.getStatus(REQUEST);

      expect(result.done).toBe(false);
      expect(result.phase).toBe('running');
      expect(result.sourcesCompleted).toBe(20);
      expect(result.sourcesTotal).toBe(29);
      expect(result.currentTask).toBe('homework');
    });

    it('reports success and done when every task succeeded', async () => {
      const { controller } = makeController({
        ok: true,
        envelope: makeEnvelope({
          phase: 'success',
          tasksTotal: 16,
          tasksSettled: 16,
          endedAt: new Date().toISOString(),
        }),
      });

      const result = await controller.getStatus(REQUEST);

      expect(result).toMatchObject({ done: true, phase: 'success', sourcesCompleted: 16 });
    });

    it('reports done when the refresh threw outside a task', async () => {
      const { controller } = makeController({
        ok: true,
        envelope: makeEnvelope({ phase: 'failed', endedAt: new Date().toISOString() }),
      });

      const result = await controller.getStatus(REQUEST);

      expect(result).toMatchObject({ done: true, phase: 'failed' });
    });

    it('reports stale and done when a running envelope stopped being updated', async () => {
      // A backend killed mid-refresh never writes a terminal phase. The
      // staleness clock releases every client at once, which no per-client
      // timeout can do.
      const { controller } = makeController({
        ok: true,
        envelope: makeEnvelope({
          phase: 'running',
          updatedAt: new Date(Date.now() - STALE_RUNNING_MS - 1_000).toISOString(),
        }),
      });

      const result = await controller.getStatus(REQUEST);

      expect(result.done).toBe(true);
      expect(result.phase).toBe('stale');
    });

    it('reports idle and not done when no refresh is in flight', async () => {
      const { controller } = makeController({ ok: false, reason: 'missing' });

      const result = await controller.getStatus(REQUEST);

      expect(result.done).toBe(false);
      expect(result.phase).toBe('idle');
      expect(result.sourcesCompleted).toBe(0);
      expect(result.sourcesTotal).toBe(0);
      expect(result.refreshId).toBeNull();
      expect(result.tasks).toEqual([]);
    });

    it('reports idle and not done when the user has no active connection', async () => {
      const { controller, refreshProgress } = makeController(
        { ok: false, reason: 'missing' },
        { connection: null },
      );

      const result = await controller.getStatus(REQUEST);

      expect(result).toMatchObject({ done: false, phase: 'idle' });
      expect(refreshProgress.read).not.toHaveBeenCalled();
    });

    it('reports unknown without throwing when Redis is unreachable', async () => {
      const { controller } = makeController({ ok: false, reason: 'unavailable' });

      const result = await controller.getStatus(REQUEST);

      expect(result.phase).toBe('unknown');
      expect(result.done).toBe(false);
    });

    it('keeps the legacy payload keys and their types', async () => {
      // Old clients and every existing e2e mock read these three fields.
      const { controller } = makeController({
        ok: true,
        envelope: makeEnvelope({ tasksTotal: 16, tasksSettled: 3 }),
      });

      const result = await controller.getStatus(REQUEST);

      expect(typeof result.done).toBe('boolean');
      expect(typeof result.sourcesCompleted).toBe('number');
      expect(typeof result.sourcesTotal).toBe('number');
    });
  });
});
