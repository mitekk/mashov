import { SyncRun } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SyncRunService } from '../sync-run.service';
import type { SyncTaskRunResult } from '../sync.types';
import { HistoryBackfillTask } from './history-backfill.task';

const CONNECTION: {
  id: string;
  schoolCode: number;
  schoolYear: number;
  username: string;
  schoolYears: number[];
  active: boolean;
} = {
  id: 'conn-1',
  schoolCode: 1234,
  schoolYear: 2027,
  username: 'parent',
  schoolYears: [],
  active: true,
};

function okResult(): SyncTaskRunResult {
  return {
    status: 'success',
    summary: { fetchedCount: 1, createdCount: 0, updatedCount: 1, failedCount: 0 },
    errorMessages: [],
  };
}

function failResult(): SyncTaskRunResult {
  return {
    status: 'failed',
    summary: { fetchedCount: 0, createdCount: 0, updatedCount: 0, failedCount: 1 },
    errorMessages: ['upstream said no'],
  };
}

function makeSyncRun(id: string, source: string): SyncRun {
  return {
    id,
    source,
    status: 'running',
    startedAt: new Date('2026-11-17T03:00:00Z'),
    endedAt: null,
    fetchedCount: null,
    createdCount: null,
    updatedCount: null,
    errorMessage: null,
    householdConnectionId: 'conn-1',
  };
}

/** The eight year-scoped task names, in the order the backfill runs them. */
const TASK_KEYS = [
  'homework',
  'behavior',
  'groups',
  'lessonsCount',
  'messageBoard',
  'dailyBehave',
  'outBehave',
  'timetable',
] as const;

interface Harness {
  task: HistoryBackfillTask;
  tasks: Record<(typeof TASK_KEYS)[number], { execute: jest.Mock }>;
  openRun: jest.Mock;
  closeRun: jest.Mock;
  connectionUpdate: jest.Mock;
  syncRunFindFirst: jest.Mock;
}

function makeHarness(
  options: {
    startYear?: string;
    connection?: Partial<typeof CONNECTION> | null;
    completeYears?: number[];
    failing?: (typeof TASK_KEYS)[number];
  } = {},
): Harness {
  const connection =
    options.connection === null ? null : { ...CONNECTION, ...(options.connection ?? {}) };

  const connectionUpdate = jest.fn().mockResolvedValue({});
  const completeYears = options.completeYears ?? [];
  const syncRunFindFirst = jest.fn().mockImplementation(({ where }) => {
    const match = /^history:(\d+):complete$/.exec(String(where.source));
    if (match && completeYears.includes(Number(match[1]))) {
      return Promise.resolve(makeSyncRun('done', String(where.source)));
    }
    return Promise.resolve(null);
  });

  const prisma = {
    householdConnection: {
      findMany: jest.fn().mockResolvedValue(connection ? [connection] : []),
      update: connectionUpdate,
    },
    syncRun: { findFirst: syncRunFindFirst },
  } as unknown as PrismaService;

  const openRun = jest
    .fn()
    .mockImplementation((source: string) => Promise.resolve(makeSyncRun('run-1', source)));
  const closeRun = jest.fn().mockResolvedValue(undefined);
  const syncRunService = { openRun, closeRun } as unknown as SyncRunService;

  const tasks = Object.fromEntries(
    TASK_KEYS.map((key) => [
      key,
      {
        execute: jest
          .fn()
          .mockResolvedValue(options.failing === key ? failResult() : okResult()),
      },
    ]),
  ) as Harness['tasks'];

  const config = {
    get: jest.fn((key: string) => (key === 'MASHOV_YEAR' ? options.startYear : undefined)),
  } as unknown as ConfigService;

  const task = new HistoryBackfillTask(
    prisma,
    config,
    syncRunService,
    tasks.homework as never,
    tasks.behavior as never,
    tasks.groups as never,
    tasks.lessonsCount as never,
    tasks.messageBoard as never,
    tasks.dailyBehave as never,
    tasks.outBehave as never,
    tasks.timetable as never,
  );

  return { task, tasks, openRun, closeRun, connectionUpdate, syncRunFindFirst };
}

function yearsAskedFor(harness: Harness): number[] {
  return harness.tasks.homework.execute.mock.calls.map(
    (call) => (call[0] as { schoolYear: number }).schoolYear,
  );
}

describe('HistoryBackfillTask', () => {
  it('fetches nothing when MASHOV_YEAR is unset', async () => {
    // Unset means the window is one year wide, so there is no history to get
    // and the task must not spend a single login.
    const harness = makeHarness();

    await harness.task.run();

    expect(harness.openRun).not.toHaveBeenCalled();
    for (const key of TASK_KEYS) {
      expect(harness.tasks[key].execute).not.toHaveBeenCalled();
    }
  });

  it('fetches the year before the current one when MASHOV_YEAR is set one back', async () => {
    const harness = makeHarness({ startYear: '2026' });

    await harness.task.run();

    expect(yearsAskedFor(harness)).toEqual([2026]);
  });

  it('never fetches the current year — that is the crons job', async () => {
    const harness = makeHarness({ startYear: '2026' });

    await harness.task.run();

    expect(yearsAskedFor(harness)).not.toContain(2027);
  });

  it('clamps to two years back when MASHOV_YEAR is set five back', async () => {
    // One year per connection per run, most recent first: 2026 tonight, 2025
    // tomorrow, and never 2022.
    const harness = makeHarness({ startYear: '2022' });

    await harness.task.run();

    expect(yearsAskedFor(harness)).toEqual([2026]);

    const resumed = makeHarness({ startYear: '2022', completeYears: [2026] });
    await resumed.task.run();
    expect(yearsAskedFor(resumed)).toEqual([2025]);

    const exhausted = makeHarness({ startYear: '2022', completeYears: [2026, 2025] });
    await exhausted.task.run();
    expect(yearsAskedFor(exhausted)).toEqual([]);
  });

  it("skips a year absent from the connection's persisted schoolYears", async () => {
    const harness = makeHarness({
      startYear: '2025',
      connection: { schoolYears: [2025, 2027] },
    });

    await harness.task.run();

    expect(yearsAskedFor(harness)).toEqual([2025]);
  });

  it('falls back to the capped window when the connection has no persisted years', async () => {
    const harness = makeHarness({ startYear: '2026', connection: { schoolYears: [] } });

    await harness.task.run();

    expect(yearsAskedFor(harness)).toEqual([2026]);
  });

  it('skips a year already recorded complete', async () => {
    const harness = makeHarness({ startYear: '2026', completeYears: [2026] });

    await harness.task.run();

    expect(harness.openRun).not.toHaveBeenCalled();
    expect(yearsAskedFor(harness)).toEqual([]);
  });

  it('records the year complete only when all eight tasks succeeded', async () => {
    const harness = makeHarness({ startYear: '2026' });

    await harness.task.run();

    for (const key of TASK_KEYS) {
      expect(harness.tasks[key].execute).toHaveBeenCalledTimes(1);
    }
    expect(harness.openRun).toHaveBeenCalledWith('history:2026:complete', 'conn-1');
    expect(harness.closeRun).toHaveBeenCalledWith('run-1', 'success', expect.anything());
  });

  it('records failed and so retries tomorrow when one of the eight tasks fails', async () => {
    const harness = makeHarness({ startYear: '2026', failing: 'timetable' });

    await harness.task.run();

    expect(harness.closeRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({ errorMessage: expect.stringContaining('timetable') }),
    );
  });

  it('never updates the connection school year', async () => {
    // That field is the CURRENT year and SchoolYearRolloverTask owns it.
    // Writing a historical year there empties every current-year read.
    const harness = makeHarness({ startYear: '2026' });

    await harness.task.run();

    expect(harness.connectionUpdate).not.toHaveBeenCalled();
  });

  it("prefixes every inner run's source with history:<year>:", async () => {
    const harness = makeHarness({ startYear: '2026' });

    await harness.task.run();

    for (const key of TASK_KEYS) {
      expect(harness.tasks[key].execute).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn-1',
          schoolYear: 2026,
          sourcePrefix: 'history:2026:',
        }),
      );
    }
  });

  it('keeps going to the next connection when one throws', async () => {
    const harness = makeHarness({ startYear: '2026' });
    harness.tasks.homework.execute.mockRejectedValueOnce(new Error('upstream down'));

    await expect(harness.task.run()).resolves.toBeUndefined();

    expect(harness.closeRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({ errorMessage: expect.stringContaining('upstream down') }),
    );
  });
});
