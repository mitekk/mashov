import type { Request } from 'express';
import { SyncController } from './sync.controller';
import type { SyncService } from './sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import { RefreshProgressService, STALE_RUNNING_MS } from './refresh-progress.service';
import type { RefreshEnvelope, RefreshReadResult } from './refresh-progress.service';
import type { RedisService } from '../redis/redis.service';

/**
 * The real staleness rule, not a copy of it.
 *
 * A reimplemented `isStale` in this mock would keep passing if the production
 * comparison were inverted — the test would be checking the copy.
 */
const realProgressService = new RefreshProgressService({
  get: jest.fn(),
  set: jest.fn(),
} as unknown as RedisService);

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
  // Any access at all fails, not a hand-picked list of five method names: a
  // regression reaching the table through $queryRaw, or through a method
  // nobody thought to enumerate, has to be caught too.
  const syncRunAccesses: string[] = [];
  const syncRun = new Proxy(
    {},
    {
      get(_target, property) {
        syncRunAccesses.push(String(property));
        throw new Error(`getStatus must not touch prisma.syncRun (read .${String(property)})`);
      },
    },
  );
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
    isStale: jest.fn((envelope: RefreshEnvelope, now?: Date) =>
      realProgressService.isStale(envelope, now),
    ),
  } as unknown as RefreshProgressService;

  return {
    controller: new SyncController(syncService, prisma, refreshProgress),
    syncRunAccesses,
    refreshProgress,
  };
}

const REQUEST = { user: { userId: 'user-1' } } as unknown as Request;

describe('SyncController', () => {
  describe('getStatus', () => {
    it('reports done when the refresh envelope reached a terminal state even though a source failed', async () => {
      // The production report. A source — `groups:<guid>` — fails every time
      // upstream refuses it, so the old controller, counting successful
      // sources against a hardcoded 16, parked the first-login screen one
      // short forever. A failed source is per-source health; it is not a
      // reason to trap the user on a spinner with no exit.
      //
      // The counts here are display data. `tasksTotal` is the wired task
      // count and does not vary by household — that independence is the whole
      // point — so the controller must report whatever the envelope holds
      // rather than compare it to anything.
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
      const { controller, syncRunAccesses } = makeController({
        ok: true,
        envelope: makeEnvelope(),
      });

      await expect(controller.getStatus(REQUEST)).resolves.toBeDefined();

      expect(syncRunAccesses).toEqual([]);
    });

    it('reports running and not done while tasks are still settling', async () => {
      // The other half of the old bug: with two children the real source count
      // exceeds 16, so the old arithmetic tripped `done` while a third of the
      // refresh was still in flight. Settled-vs-total is now the only test.
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
