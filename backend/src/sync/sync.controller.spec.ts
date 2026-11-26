import type { Request } from 'express';
import { SyncController } from './sync.controller';
import type { SyncService } from './sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import { RefreshProgressService, STALE_RUNNING_MS } from './refresh-progress.service';
import type { RefreshEnvelope, RefreshReadResult } from './refresh-progress.service';
import type { RedisService } from '../redis/redis.service';
import type { ManualSyncRefreshResponse, ManualSyncTaskResult } from './sync.types';

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
  read: RefreshReadResult | ((connectionId: string) => RefreshReadResult),
  options: {
    connection?: { id: string } | null;
    connections?: Array<{ id: string; schoolCode: number; schoolName: string | null }>;
  } = {},
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
  // The status read lists every active connection now, rather than resolving
  // one: `done` must mean every school has stopped, not whichever school
  // findFirst happened to return.
  const connections =
    options.connections ??
    (options.connection === undefined
      ? [{ id: 'conn-1', schoolCode: 540175, schoolName: 'School' }]
      : options.connection === null
        ? []
        : [{ schoolCode: 540175, schoolName: 'School', ...options.connection }]);

  const prisma = {
    householdConnection: {
      findFirst: jest.fn().mockResolvedValue(connections[0] ?? null),
      findMany: jest.fn().mockResolvedValue(connections),
    },
    syncRun,
  } as unknown as PrismaService;

  const syncService = { refreshAll: jest.fn() } as unknown as SyncService;
  const refreshProgress = {
    read: jest.fn((connectionId: string) =>
      Promise.resolve(typeof read === 'function' ? read(connectionId) : read),
    ),
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

describe('SyncController across two schools', () => {
  const TWO = [
    { id: 'conn-a', schoolCode: 540175, schoolName: 'אורט רמון' },
    { id: 'conn-b', schoolCode: 999999, schoolName: 'תיכון רמון' },
  ];

  describe('getStatus', () => {
    it('is not done while either school is still running', async () => {
      // The decisive case. A per-connection read reported `done` as soon as
      // whichever connection it picked finished, releasing the first-login
      // screen while the other school was still fetching -- so the parent
      // landed on a home page missing half their children.
      const { controller } = makeController(
        (connectionId) => ({
          ok: true,
          envelope: makeEnvelope({
            connectionId,
            phase: connectionId === 'conn-a' ? 'success' : 'running',
            endedAt: connectionId === 'conn-a' ? new Date().toISOString() : null,
            tasksTotal: 17,
            tasksSettled: connectionId === 'conn-a' ? 17 : 4,
          }),
        }),
        { connections: TWO },
      );

      const status = await controller.getStatus(REQUEST);

      expect(status.done).toBe(false);
      expect(status.phase).toBe('running');
    });

    it('is done once every school has stopped', async () => {
      const endedAt = new Date().toISOString();
      const { controller } = makeController(
        (connectionId) => ({
          ok: true,
          envelope: makeEnvelope({
            connectionId,
            phase: 'success',
            endedAt,
            tasksTotal: 17,
            tasksSettled: 17,
          }),
        }),
        { connections: TWO },
      );

      const status = await controller.getStatus(REQUEST);

      expect(status.done).toBe(true);
      expect(status.phase).toBe('success');
    });

    it('sums the task counts across schools', async () => {
      const { controller } = makeController(
        (connectionId) => ({
          ok: true,
          envelope: makeEnvelope({
            connectionId,
            phase: 'success',
            endedAt: new Date().toISOString(),
            tasksTotal: 17,
            tasksSettled: 17,
            tasksFailed: connectionId === 'conn-b' ? 2 : 0,
          }),
        }),
        { connections: TWO },
      );

      const status = await controller.getStatus(REQUEST);

      expect(status.tasksTotal).toBe(34);
      expect(status.tasksSettled).toBe(34);
      expect(status.tasksFailed).toBe(2);
      // The legacy keys stay in step with them, for clients that read those.
      expect(status.sourcesTotal).toBe(34);
      expect(status.sourcesCompleted).toBe(34);
    });

    it('reports a partial school rather than letting a healthy one mask it', async () => {
      const { controller } = makeController(
        (connectionId) => ({
          ok: true,
          envelope: makeEnvelope({
            connectionId,
            phase: connectionId === 'conn-a' ? 'success' : 'partial',
            endedAt: new Date().toISOString(),
          }),
        }),
        { connections: TWO },
      );

      await expect(controller.getStatus(REQUEST)).resolves.toMatchObject({
        done: true,
        phase: 'partial',
      });
    });

    it('breaks the progress down per school so the UI can name the one it waits on', async () => {
      const { controller } = makeController(
        (connectionId) => ({
          ok: true,
          envelope: makeEnvelope({
            connectionId,
            phase: connectionId === 'conn-a' ? 'success' : 'running',
            tasksTotal: 17,
            tasksSettled: connectionId === 'conn-a' ? 17 : 4,
            currentTask: connectionId === 'conn-a' ? null : 'homework',
          }),
        }),
        { connections: TWO },
      );

      const status = await controller.getStatus(REQUEST);

      expect(status.schools).toEqual([
        {
          schoolId: 'conn-a',
          semel: 540175,
          schoolName: 'אורט רמון',
          phase: 'success',
          tasksTotal: 17,
          tasksSettled: 17,
          tasksFailed: 0,
          currentTask: null,
        },
        {
          schoolId: 'conn-b',
          semel: 999999,
          schoolName: 'תיכון רמון',
          phase: 'running',
          tasksTotal: 17,
          tasksSettled: 4,
          tasksFailed: 0,
          currentTask: 'homework',
        },
      ]);
      // And the headline task is the running school's, not the finished one's.
      expect(status.currentTask).toBe('homework');
    });

    it('keeps polling when one school has an envelope and the other does not', async () => {
      // A school linked a moment ago has opened no envelope yet. Treating its
      // missing read as a terminal state would report the household done.
      const { controller } = makeController(
        (connectionId) =>
          connectionId === 'conn-a'
            ? { ok: true, envelope: makeEnvelope({ connectionId, phase: 'running' }) }
            : { ok: false, reason: 'missing' },
        { connections: TWO },
      );

      await expect(controller.getStatus(REQUEST)).resolves.toMatchObject({
        done: false,
        phase: 'running',
      });
    });

    it('404s on a schoolId belonging to another household', async () => {
      // 404 rather than 403: a 403 would confirm the id exists.
      const { controller } = makeController({ ok: false, reason: 'missing' }, {
        connections: [],
      });
      const request = {
        user: { userId: 'user-1' },
        query: { schoolId: 'conn-someone-else' },
      } as unknown as Request;

      await expect(controller.getStatus(request)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('still reports idle, not 404, when the user has no connection at all', async () => {
      // This is what the first-login screen polls before a connection exists.
      const { controller } = makeController({ ok: false, reason: 'missing' }, {
        connections: [],
      });

      await expect(controller.getStatus(REQUEST)).resolves.toMatchObject({
        phase: 'idle',
        done: false,
      });
    });
  });

  describe('refresh', () => {
    it('refreshes every school sequentially', async () => {
      const order: string[] = [];
      const refreshAll = jest.fn(async ({ connectionId }: { connectionId: string }) => {
        order.push(`start:${connectionId}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(`end:${connectionId}`);
        return { status: 'success', tasks: [] };
      });
      const { controller } = makeControllerWithService(refreshAll, TWO);

      await controller.refresh(REQUEST);

      // Concurrency 1: two simultaneous Mashov logins from one household is
      // asking for a rate limit.
      expect(order).toEqual([
        'start:conn-a',
        'end:conn-a',
        'start:conn-b',
        'end:conn-b',
      ]);
    });

    it('refreshes only the named school when given a schoolId', async () => {
      const refreshAll = jest.fn().mockResolvedValue({ status: 'success', tasks: [] });
      const { controller } = makeControllerWithService(refreshAll, [TWO[1]]);
      const request = {
        user: { userId: 'user-1' },
        query: { schoolId: 'conn-b' },
      } as unknown as Request;

      await controller.refresh(request);

      expect(refreshAll).toHaveBeenCalledTimes(1);
      expect(refreshAll).toHaveBeenCalledWith({ connectionId: 'conn-b', taskSet: 'login', respectTtl: false });
    });

    it('404s on a foreign schoolId', async () => {
      const refreshAll = jest.fn();
      const { controller } = makeControllerWithService(refreshAll, []);
      const request = {
        user: { userId: 'user-1' },
        query: { schoolId: 'conn-someone-else' },
      } as unknown as Request;

      await expect(controller.refresh(request)).rejects.toMatchObject({ status: 404 });
      expect(refreshAll).not.toHaveBeenCalled();
    });
  });

  /**
   * R12. The endpoint used to return `{ ...results[0], schools }`, so `status`,
   * `tasks` and every per-task count described school A alone. A household
   * where A succeeds and B comes back `partial` was told `success`.
   */
  describe('refresh across two schools, aggregated', () => {
    it('reports partial when either school is partial', async () => {
      const refreshAll = jest.fn(async ({ connectionId }: { connectionId: string }) =>
        connectionId === 'conn-a'
          ? makeRefresh({ status: 'success', tasks: [makeTask('homework', 'success')] })
          : makeRefresh({ status: 'partial', tasks: [makeTask('homework', 'failed')] }),
      );
      const { controller } = makeControllerWithService(refreshAll, TWO);

      const response = await controller.refresh(REQUEST);

      expect(response.status).toBe('partial');
    });

    it("carries both schools' tasks, not just the first school's", async () => {
      // `/more`'s refresh button reported a clean sync off A's task list while
      // B's failures were simply absent from the response.
      const refreshAll = jest.fn(async ({ connectionId }: { connectionId: string }) =>
        connectionId === 'conn-a'
          ? makeRefresh({ status: 'success', tasks: [makeTask('homework', 'success')] })
          : makeRefresh({ status: 'partial', tasks: [makeTask('mailInbox', 'failed')] }),
      );
      const { controller } = makeControllerWithService(refreshAll, TWO);

      const response = await controller.refresh(REQUEST);

      expect(response.tasks.map((task) => [task.task, task.status])).toEqual([
        ['homework', 'success'],
        ['mailInbox', 'failed'],
      ]);
    });

    it('spans the refresh as the parent experienced it', async () => {
      // Earliest start, latest end, and the difference -- the same choice
      // `getStatus` makes over its per-school envelopes.
      const refreshAll = jest.fn(async ({ connectionId }: { connectionId: string }) =>
        connectionId === 'conn-a'
          ? makeRefresh({
              startedAt: '2026-11-19T09:00:00.000Z',
              endedAt: '2026-11-19T09:00:10.000Z',
            })
          : makeRefresh({
              startedAt: '2026-11-19T09:00:10.000Z',
              endedAt: '2026-11-19T09:00:25.000Z',
            }),
      );
      const { controller } = makeControllerWithService(refreshAll, TWO);

      const response = await controller.refresh(REQUEST);

      expect(response.startedAt).toBe('2026-11-19T09:00:00.000Z');
      expect(response.endedAt).toBe('2026-11-19T09:00:25.000Z');
      expect(response.durationMs).toBe(25_000);
    });

    it("does not discard a working school's result when the other throws", async () => {
      // The worst form of it: one school throwing made the whole endpoint 500
      // and threw the other school's successful refresh away -- which is why
      // `results[index]?.status ?? 'failed'` was unreachable.
      const refreshAll = jest.fn(async ({ connectionId }: { connectionId: string }) => {
        if (connectionId === 'conn-b') throw new Error('login refused');
        return makeRefresh({ status: 'success', tasks: [makeTask('homework', 'success')] });
      });
      const { controller } = makeControllerWithService(refreshAll, TWO);

      const response = await controller.refresh(REQUEST);

      expect(response.status).toBe('failed');
      expect(response.tasks.map((task) => task.task)).toEqual(['homework']);
      expect(response.schools).toEqual([
        { schoolId: 'conn-a', semel: 540175, schoolName: 'אורט רמון', status: 'success' },
        { schoolId: 'conn-b', semel: 999999, schoolName: 'תיכון רמון', status: 'failed' },
      ]);
    });

    it('still rejects when every school throws', async () => {
      // A refresh that achieved nothing must stay a 500, or
      // `SyncingPageClient`'s `default:` branch stops reporting a failed
      // trigger.
      const refreshAll = jest.fn().mockRejectedValue(new Error('login refused'));
      const { controller } = makeControllerWithService(refreshAll, TWO);

      await expect(controller.refresh(REQUEST)).rejects.toThrow('login refused');
    });

    it('leaves the single-school response exactly as it was', async () => {
      // Byte-identical to today for one school, so the six e2e MOCK constants
      // and old clients keep working.
      const single = makeRefresh({ status: 'success', tasks: [makeTask('homework', 'success')] });
      const refreshAll = jest.fn().mockResolvedValue(single);
      const { controller } = makeControllerWithService(refreshAll, [TWO[0]]);

      const response = await controller.refresh(REQUEST);

      expect(response).toEqual({
        ...single,
        schools: [
          { schoolId: 'conn-a', semel: 540175, schoolName: 'אורט רמון', status: 'success' },
        ],
      });
    });
  });
});

function makeTask(
  task: string,
  status: 'success' | 'failed',
): ManualSyncTaskResult {
  return {
    task,
    status,
    summary: {
      fetchedCount: 1,
      createdCount: 1,
      updatedCount: 0,
      failedCount: status === 'failed' ? 1 : 0,
    },
    errorMessages: status === 'failed' ? ['403'] : [],
    startedAt: '2026-11-19T09:00:00.000Z',
    endedAt: '2026-11-19T09:00:01.000Z',
    durationMs: 1_000,
  };
}

function makeRefresh(
  overrides: Partial<ManualSyncRefreshResponse> = {},
): ManualSyncRefreshResponse {
  return {
    status: 'success',
    startedAt: '2026-11-19T09:00:00.000Z',
    endedAt: '2026-11-19T09:00:10.000Z',
    durationMs: 10_000,
    tasks: [],
    ...overrides,
  };
}

function makeControllerWithService(
  refreshAll: jest.Mock,
  connections: Array<{ id: string; schoolCode: number; schoolName: string | null }>,
) {
  const prisma = {
    householdConnection: {
      findFirst: jest.fn().mockResolvedValue(connections[0] ?? null),
      findMany: jest.fn().mockResolvedValue(connections),
    },
  } as unknown as PrismaService;
  const refreshProgress = {
    read: jest.fn().mockResolvedValue({ ok: false, reason: 'missing' }),
    isStale: jest.fn().mockReturnValue(false),
  } as unknown as RefreshProgressService;

  return {
    controller: new SyncController(
      { refreshAll } as unknown as SyncService,
      prisma,
      refreshProgress,
    ),
  };
}
