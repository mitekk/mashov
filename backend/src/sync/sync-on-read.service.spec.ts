import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FreshnessService } from './freshness.service';
import { SyncRunService } from './sync-run.service';
import { SyncOnReadService } from './sync-on-read.service';
import type { SyncTaskRunResult } from './sync.types';

/**
 * `ensureFresh` returns early under NODE_ENV=test — the guard that keeps every
 * children/settings spec from needing an upstream mock. This suite is the one
 * place that has to see past it.
 */
const REAL_ENV = process.env.NODE_ENV;

function okResult(): SyncTaskRunResult {
  return {
    status: 'success',
    summary: { fetchedCount: 1, createdCount: 0, updatedCount: 1, failedCount: 0 },
    errorMessages: [],
  };
}

describe('SyncOnReadService', () => {
  let service: SyncOnReadService;
  let loadSyncRuns: jest.Mock;
  let openRun: jest.Mock;
  let closeRun: jest.Mock;
  let config: Record<string, string>;

  beforeAll(() => {
    process.env.NODE_ENV = 'development';
  });
  afterAll(() => {
    process.env.NODE_ENV = REAL_ENV;
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    loadSyncRuns = jest.fn().mockResolvedValue({ successRuns: new Map(), allRuns: new Map() });
    openRun = jest.fn().mockResolvedValue({ id: 'run-1' });
    closeRun = jest.fn().mockResolvedValue(undefined);
    config = {};

    service = new SyncOnReadService(
      { loadSyncRuns } as unknown as FreshnessService,
      { openRun, closeRun } as unknown as SyncRunService,
      { get: (key: string) => config[key] } as unknown as ConfigService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  /** A successful run `minutesAgo` old, under the given key. */
  function withRun(key: string, minutesAgo: number) {
    loadSyncRuns.mockResolvedValue({
      successRuns: new Map([
        [key, { source: key, status: 'success', endedAt: new Date(Date.now() - minutesAgo * 60_000) }],
      ]),
      allRuns: new Map(),
    });
  }

  /** A failed attempt `minutesAgo` old, under the given key. */
  function withFailedRun(key: string, minutesAgo: number) {
    loadSyncRuns.mockResolvedValue({
      successRuns: new Map(),
      allRuns: new Map([
        [key, { source: key, status: 'failed', endedAt: new Date(Date.now() - minutesAgo * 60_000) }],
      ]),
    });
  }

  const empty = async () => true;
  const notEmpty = async () => false;

  it('does not fetch while the local copy is inside its TTL', async () => {
    withRun('timetable', 60); // TTL is 7 days
    const fetch = jest.fn();

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: notEmpty });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches once the TTL has lapsed', async () => {
    withRun('timetable', 8 * 24 * 60);
    const fetch = jest.fn().mockResolvedValue(okResult());

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    expect(fetch).toHaveBeenCalledWith({ connectionId: 'conn-1' });
  });

  it('fetches when there is no successful run at all, so a first view is not blank', async () => {
    const fetch = jest.fn().mockResolvedValue(okResult());

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('counts a per-student run for its base source when the caller names no variant', async () => {
    // Variant keys: a `timetable:<guid>` run is what the task actually writes.
    // This is the base-keyed caller -- the dashboard, which freshens once per
    // connection with an emptiness probe spanning every child at once (see
    // `children.service.ts:106`), and for which any student's run is the
    // freshness it asked about. A caller that *does* know the student passes
    // `variantKey`; see the block below.
    withRun('timetable:student-1', 60);
    const fetch = jest.fn();

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: notEmpty });

    expect(fetch).not.toHaveBeenCalled();
  });

  describe('per-student freshness (variantKey)', () => {
    it("does not call a student fresh because a sibling's run succeeded", async () => {
      // THE REGRESSION. The cron's final pass wrote `grades:<nelly>` success
      // and `grades:<mika>` failed, both with a null connection -- and a
      // null-connection row is admitted into every connection's snapshot. Under
      // base-plus-any-variant matching, Nelly's success answered the question
      // "is Mika's copy fresh?", so no fetch ran and Mika's section stayed
      // empty for the whole 6h TTL. `localIsEmpty` cannot rescue it: it is
      // consulted only AFTER a fetch has been committed to.
      withRun('grades:student-2', 60); // grades TTL is 6h, so well inside it
      const fetch = jest.fn().mockResolvedValue(okResult());

      await service.ensureFresh('grades', fetch, {
        connectionId: 'conn-1',
        localIsEmpty: empty,
        variantKey: 'grades:student-1',
      });

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("still suppresses the fetch on this student's own successful run", async () => {
      // The other half: student-keyed matching must not turn the gate off.
      withRun('grades:student-1', 60);
      const fetch = jest.fn();

      await service.ensureFresh('grades', fetch, {
        connectionId: 'conn-1',
        localIsEmpty: notEmpty,
        variantKey: 'grades:student-1',
      });

      expect(fetch).not.toHaveBeenCalled();
    });

    it("backs off on this student's own failed sentinel, so there is no amplifier", async () => {
      // The sentinel has to be written under the key the probe reads. Were it
      // still `grades:<connId>`, a student-keyed probe would never see it and a
      // failing source would re-fetch on every single view -- exactly the login
      // amplifier this class exists to prevent.
      withFailedRun('grades:student-1', 2); // retry window is 15 minutes
      const fetch = jest.fn();

      await service.ensureFresh('grades', fetch, {
        connectionId: 'conn-1',
        localIsEmpty: empty,
        variantKey: 'grades:student-1',
      });

      expect(fetch).not.toHaveBeenCalled();
    });

    it('records the sentinel under the same key the probe reads', async () => {
      const fetch = jest.fn().mockRejectedValue(new Error('upstream 502'));

      await service.ensureFresh('grades', fetch, {
        connectionId: 'conn-1',
        localIsEmpty: empty,
        variantKey: 'grades:student-1',
      });

      expect(openRun).toHaveBeenCalledWith('grades:student-1', 'conn-1');
    });

    it('does not dedupe two students at one school onto one operation', async () => {
      // The in-flight marker covers the freshness READ as well as the fetch, so
      // a shared key means the second student joins the first's decision and
      // inherits it -- a second route into the same bug.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = jest.fn().mockImplementation(async () => {
        await gate;
        return okResult();
      });
      const second = jest.fn().mockResolvedValue(okResult());

      const pending = service.ensureFresh('grades', first, {
        connectionId: 'conn-1',
        localIsEmpty: notEmpty,
        variantKey: 'grades:student-1',
      });
      await service.ensureFresh('grades', second, {
        connectionId: 'conn-1',
        localIsEmpty: notEmpty,
        variantKey: 'grades:student-2',
      });

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      release();
      await pending;
    });
  });

  it('serves the stale copy rather than failing the page when upstream throws', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('upstream 502'));

    await expect(
      service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty }),
    ).resolves.toBeUndefined();
  });

  it('records a failed run so a broken upstream cannot re-fire on every request', async () => {
    // The amplifier guard. Without a row the TTL gate stays unsatisfied and
    // every request performs a fresh upstream login.
    const fetch = jest.fn().mockRejectedValue(new Error('upstream 502'));

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    expect(openRun).toHaveBeenCalledWith('timetable:conn-1', 'conn-1');
    expect(closeRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({ errorMessage: expect.stringContaining('upstream 502') }),
    );
  });

  it('records a run when the task reports failure without throwing', async () => {
    const fetch = jest.fn().mockResolvedValue({
      status: 'failed',
      summary: { fetchedCount: 0, createdCount: 0, updatedCount: 0, failedCount: 1 },
      errorMessages: ['every connection failed'],
    } satisfies SyncTaskRunResult);

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    expect(closeRun).toHaveBeenCalledWith('run-1', 'failed', expect.anything());
  });

  it('never writes a bare source key, which every household would be shown', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('nope'));

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    for (const call of openRun.mock.calls) {
      expect(call[0]).not.toBe('timetable');
      expect(call[1]).toBe('conn-1');
    }
  });

  it('backs off after a failed attempt, instead of re-fetching on every request', async () => {
    // The amplifier guard, and the reason it cannot read `successRuns` alone:
    // `recordAttempt` writes its sentinel with status `failed`, so a gate that
    // only looked at successes was never satisfied by it and every request to
    // `/children`, `/timetable`, `/subjects`, `/notices` and `/profile`
    // performed a fresh upstream login while Mashov was down.
    // Base-keyed caller, so the sentinel is the per-connection one. A caller
    // that names a `variantKey` gets its sentinel under that key instead --
    // see 'records the sentinel under the same key the probe reads'.
    withFailedRun('timetable:conn-1', 2);
    const fetch = jest.fn();

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries once the backoff window has passed, long before the TTL', async () => {
    // Timetable's TTL is 7 days. One failed blip must not strand the grid for
    // a week, so the retry window is minutes.
    withFailedRun('timetable:conn-1', 60);
    const fetch = jest.fn().mockResolvedValue(okResult());

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not probe the local copy when nothing is going to be fetched', async () => {
    // The probe is a `count` per source per connection. On the common path --
    // the copy is fresh -- paying for it on every request is pure waste.
    withRun('timetable', 60);
    const localIsEmpty = jest.fn().mockResolvedValue(false);

    await service.ensureFresh('timetable', jest.fn(), { connectionId: 'conn-1', localIsEmpty });

    expect(localIsEmpty).not.toHaveBeenCalled();
  });

  it('serves the page when the emptiness probe itself throws', async () => {
    // Documented as never throwing, and `ChildrenService` has no try/catch: a
    // transient DB error counting local rows must not 500 a servable page.
    const fetch = jest.fn().mockResolvedValue(okResult());

    await expect(
      service.ensureFresh('timetable', fetch, {
        connectionId: 'conn-1',
        localIsEmpty: async () => {
          throw new Error('db down');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('does not block past a deadline the request has already spent', async () => {
    // Several sources across several connections share one budget, so the
    // waits cannot stack into a page slower than the frontend proxy allows.
    const fetch = jest.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(okResult()), 5_000)),
    );

    const startedAt = Date.now();
    await service.ensureFresh('timetable', fetch, {
      connectionId: 'conn-1',
      localIsEmpty: empty,
      deadline: Date.now() - 1,
    });

    // Still fetched -- it just is not waited on; the next view gets the rows.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('collapses a page-load storm into one fetch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = jest.fn().mockImplementation(async () => {
      await gate;
      return okResult();
    });

    const calls = [
      service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: notEmpty }),
      service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: notEmpty }),
      service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: notEmpty }),
    ];
    release();
    await Promise.all(calls);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not block when the page already has something to render', async () => {
    let settled = false;
    const fetch = jest.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = true;
      return okResult();
    });

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: notEmpty });

    expect(fetch).toHaveBeenCalledTimes(1);
    // Returned before the fetch finished: a stale grid beats a slow one.
    expect(settled).toBe(false);
  });

  it('gives up waiting at the budget rather than inheriting the upstream timeout', async () => {
    config.SYNC_ON_READ_BUDGET_MS = '20';
    const fetch = jest.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(okResult()), 5_000)),
    );

    const startedAt = Date.now();
    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('stops fetching once the in-flight cap is reached', async () => {
    // The circuit breaker: a traffic spike here must not become one upstream.
    config.SYNC_ON_READ_MAX_INFLIGHT = '1';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = jest.fn().mockImplementation(async () => {
      await gate;
      return okResult();
    });
    const second = jest.fn().mockResolvedValue(okResult());

    const first = service.ensureFresh('timetable', slow, {
      connectionId: 'conn-1',
      localIsEmpty: notEmpty,
    });
    // A different source, so the per-key dedupe does not cover it.
    await service.ensureFresh('groups', second, { connectionId: 'conn-1', localIsEmpty: notEmpty });

    expect(second).not.toHaveBeenCalled();
    release();
    await first;
  });

  it('refuses a source with no policy rather than fetching on every view', async () => {
    const fetch = jest.fn();

    await service.ensureFresh('not_a_source', fetch, {
      connectionId: 'conn-1',
      localIsEmpty: empty,
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('serves the local copy when freshness cannot be read', async () => {
    // Cannot tell: do nothing rather than fetch blind on every request.
    loadSyncRuns.mockRejectedValue(new Error('db down'));
    const fetch = jest.fn();

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('scopes the freshness probe to the connection', async () => {
    // A global probe lets one household's fresh run suppress another's fetch.
    await service.ensureFresh('timetable', jest.fn().mockResolvedValue(okResult()), {
      connectionId: 'conn-9',
      localIsEmpty: empty,
    });

    expect(loadSyncRuns).toHaveBeenCalledWith('conn-9');
  });

  it('is a no-op under NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    const fetch = jest.fn();

    await service.ensureFresh('timetable', fetch, { connectionId: 'conn-1', localIsEmpty: empty });

    expect(fetch).not.toHaveBeenCalled();
    expect(loadSyncRuns).not.toHaveBeenCalled();
    process.env.NODE_ENV = 'development';
  });
});
