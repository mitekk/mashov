import { RefreshProgressService } from './refresh-progress.service';
import {
  REFRESH_KEY_PREFIX,
  RUNNING_TTL_SECONDS,
  STALE_RUNNING_MS,
  TERMINAL_TTL_SECONDS,
} from './refresh-progress.service';
import type { RedisService } from '../redis/redis.service';
import type { RefreshEnvelope } from './refresh-progress.service';

function makeRedis(overrides: Partial<Record<'get' | 'set' | 'del', jest.Mock>> = {}) {
  return {
    get: overrides.get ?? jest.fn().mockResolvedValue(null),
    set: overrides.set ?? jest.fn().mockResolvedValue(undefined),
    del: overrides.del ?? jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(redis: ReturnType<typeof makeRedis>) {
  return new RefreshProgressService(redis as unknown as RedisService);
}

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

describe('RefreshProgressService', () => {
  describe('open', () => {
    it('builds a running envelope keyed on the connection', () => {
      const service = makeService(makeRedis());

      const envelope = service.open('conn-1', 21);

      expect(envelope.connectionId).toBe('conn-1');
      expect(envelope.phase).toBe('running');
      expect(envelope.tasksTotal).toBe(21);
      expect(envelope.tasksSettled).toBe(0);
      expect(envelope.tasksFailed).toBe(0);
      expect(envelope.endedAt).toBeNull();
      expect(envelope.refreshId).toEqual(expect.any(String));
      expect(envelope.refreshId.length).toBeGreaterThan(0);
    });
  });

  describe('write', () => {
    it('stores the envelope under sync:refresh:<connectionId>', async () => {
      const redis = makeRedis();
      const service = makeService(redis);
      const envelope = makeEnvelope();

      await service.write(envelope);

      const [key, value] = redis.set.mock.calls[0];
      expect(key).toBe(`${REFRESH_KEY_PREFIX}conn-1`);
      expect(JSON.parse(value)).toEqual(envelope);
    });

    it('uses the running TTL while the refresh is running', async () => {
      const redis = makeRedis();
      const service = makeService(redis);

      await service.write(makeEnvelope({ phase: 'running' }));

      expect(redis.set.mock.calls[0][2]).toBe(RUNNING_TTL_SECONDS);
    });

    it.each(['success', 'partial', 'failed'] as const)(
      'uses the terminal TTL once the refresh is %s',
      async (phase) => {
        const redis = makeRedis();
        const service = makeService(redis);

        await service.write(makeEnvelope({ phase }));

        expect(redis.set.mock.calls[0][2]).toBe(TERMINAL_TTL_SECONDS);
      },
    );

    it('bumps updatedAt on every write', async () => {
      const redis = makeRedis();
      const service = makeService(redis);
      const envelope = makeEnvelope({ updatedAt: '2020-01-01T00:00:00.000Z' });

      await service.write(envelope);

      const stored = JSON.parse(redis.set.mock.calls[0][1]) as RefreshEnvelope;
      expect(stored.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
      expect(Date.parse(stored.updatedAt)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
    });

    it('swallows a Redis failure so Redis can never fail a refresh', async () => {
      const redis = makeRedis({ set: jest.fn().mockRejectedValue(new Error('redis down')) });
      const service = makeService(redis);

      await expect(service.write(makeEnvelope())).resolves.toBeUndefined();
    });
  });

  describe('read', () => {
    it('returns the stored envelope', async () => {
      const envelope = makeEnvelope({ phase: 'success', tasksSettled: 16 });
      const redis = makeRedis({ get: jest.fn().mockResolvedValue(JSON.stringify(envelope)) });
      const service = makeService(redis);

      const result = await service.read('conn-1');

      expect(redis.get).toHaveBeenCalledWith(`${REFRESH_KEY_PREFIX}conn-1`);
      expect(result).toEqual({ ok: true, envelope });
    });

    it('reports missing when no envelope is stored', async () => {
      const service = makeService(makeRedis({ get: jest.fn().mockResolvedValue(null) }));

      await expect(service.read('conn-1')).resolves.toEqual({ ok: false, reason: 'missing' });
    });

    it('reports missing when the stored value is malformed', async () => {
      const service = makeService(makeRedis({ get: jest.fn().mockResolvedValue('{not json') }));

      await expect(service.read('conn-1')).resolves.toEqual({ ok: false, reason: 'missing' });
    });

    it('reports missing when the stored value is not an envelope', async () => {
      const service = makeService(makeRedis({ get: jest.fn().mockResolvedValue('"a string"') }));

      await expect(service.read('conn-1')).resolves.toEqual({ ok: false, reason: 'missing' });
    });

    it.each(['pending', 'Running', '', 'idle'])(
      'reports missing when the stored phase is %p, which is not a real phase',
      async (phase) => {
        // Anything outside the enum is not `running`, so the controller would
        // pass it straight through as a terminal phase: `done: true`, and a
        // phase value the client's own type says cannot exist.
        const envelope = { ...makeEnvelope(), phase } as unknown as RefreshEnvelope;
        const service = makeService(
          makeRedis({ get: jest.fn().mockResolvedValue(JSON.stringify(envelope)) }),
        );

        await expect(service.read('conn-1')).resolves.toEqual({ ok: false, reason: 'missing' });
      },
    );

    it('reports missing when tasks is not an array', async () => {
      const envelope = { ...makeEnvelope(), tasks: 'nope' } as unknown as RefreshEnvelope;
      const service = makeService(
        makeRedis({ get: jest.fn().mockResolvedValue(JSON.stringify(envelope)) }),
      );

      await expect(service.read('conn-1')).resolves.toEqual({ ok: false, reason: 'missing' });
    });

    it('reports unavailable when Redis throws, rather than propagating', async () => {
      const service = makeService(
        makeRedis({ get: jest.fn().mockRejectedValue(new Error('redis down')) }),
      );

      await expect(service.read('conn-1')).resolves.toEqual({ ok: false, reason: 'unavailable' });
    });
  });

  describe('isStale', () => {
    const now = new Date('2026-03-17T12:00:00.000Z');

    it('is not stale exactly at the boundary', () => {
      const service = makeService(makeRedis());
      const envelope = makeEnvelope({
        updatedAt: new Date(now.getTime() - STALE_RUNNING_MS).toISOString(),
      });

      expect(service.isStale(envelope, now)).toBe(false);
    });

    it('is stale one millisecond past the boundary', () => {
      const service = makeService(makeRedis());
      const envelope = makeEnvelope({
        updatedAt: new Date(now.getTime() - STALE_RUNNING_MS - 1).toISOString(),
      });

      expect(service.isStale(envelope, now)).toBe(true);
    });

    it('treats an unparseable updatedAt as stale', () => {
      const service = makeService(makeRedis());

      expect(service.isStale(makeEnvelope({ updatedAt: 'not-a-date' }), now)).toBe(true);
    });
  });
});
