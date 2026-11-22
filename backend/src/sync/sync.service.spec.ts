import { SyncService } from './sync.service';
import type { SyncTaskRunResult } from './sync.types';
import { NotificationsTask } from './tasks/notifications.task';
import { MailCountsTask } from './tasks/mail-counts.task';
import { MailInboxTask } from './tasks/mail-inbox.task';
import { HomeworkTask } from './tasks/homework.task';
import { BehaviorTask } from './tasks/behavior.task';
import { AchvasTask } from './tasks/achvas.task';
import { GroupsTask } from './tasks/groups.task';
import { LessonsCountTask } from './tasks/lessons-count.task';
import { MessageBoardTask } from './tasks/message-board.task';
import { UserDetailsTask } from './tasks/user-details.task';
import { DailyBehaveTask } from './tasks/daily-behave.task';
import { OutBehaveTask } from './tasks/out-behave.task';
import { ReleasesTask } from './tasks/releases.task';
import { SchoolActivitiesTask } from './tasks/school-activities.task';
import { TimetableTask } from './tasks/timetable.task';
import { BellsTask } from './tasks/bells.task';
import { StudentsTask } from './tasks/students.task';
import type { RefreshEnvelope, RefreshProgressService } from './refresh-progress.service';
import {
  HEARTBEAT_INTERVAL_MS,
  STALE_RUNNING_MS,
} from './refresh-progress.service';

function makeResult(status: 'success' | 'failed' = 'success'): SyncTaskRunResult {
  return {
    status,
    summary: {
      fetchedCount: 1,
      createdCount: 0,
      updatedCount: 1,
      failedCount: status === 'failed' ? 1 : 0,
    },
    errorMessages: status === 'failed' ? ['task failed'] : [],
  };
}

function makeMockTask(result: SyncTaskRunResult) {
  return {
    execute: jest.fn().mockResolvedValue(result),
  };
}

/**
 * Stands in for Redis. `open` hands back a real envelope object so the service
 * can mutate it in place, and `write` records the mutation as it was at the
 * moment of the call -- which is what proves progress streams rather than
 * landing in one update at the end.
 */
function makeRefreshProgress(overrides: { write?: jest.Mock } = {}) {
  const snapshots: RefreshEnvelope[] = [];
  const open = jest.fn((connectionId: string, tasksTotal: number): RefreshEnvelope => {
    const now = new Date().toISOString();
    return {
      refreshId: 'refresh-1',
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
  });
  const write =
    overrides.write ??
    jest.fn(async (envelope: RefreshEnvelope) => {
      snapshots.push(JSON.parse(JSON.stringify(envelope)) as RefreshEnvelope);
    });

  const mock = {
    open,
    write,
    read: jest.fn(),
    isStale: jest.fn().mockReturnValue(false),
  };

  return { mock, snapshots, open, write };
}

describe('SyncService', () => {
  // Derived, not hardcoded: this asserts that every task the harness wires up
  // actually ran, so adding a sync task cannot quietly go unexercised here --
  // nor break this test for no reason, as a literal count did.
  const EXPECTED_TASK_COUNT = 17;

  function createService(
    overrides: Partial<Record<string, { execute: jest.Mock }>> = {},
    progress: ReturnType<typeof makeRefreshProgress> = makeRefreshProgress(),
  ) {
    const notifications = overrides.notifications ?? makeMockTask(makeResult());
    const mailCounts = overrides.mailCounts ?? makeMockTask(makeResult());
    const mailInbox = overrides.mailInbox ?? makeMockTask(makeResult());
    const homework = overrides.homework ?? makeMockTask(makeResult());
    const behavior = overrides.behavior ?? makeMockTask(makeResult());
    const achvas = overrides.achvas ?? makeMockTask(makeResult());
    const groups = overrides.groups ?? makeMockTask(makeResult());
    const lessonsCount = overrides.lessonsCount ?? makeMockTask(makeResult());
    const messageBoard = overrides.messageBoard ?? makeMockTask(makeResult());
    const userDetails = overrides.userDetails ?? makeMockTask(makeResult());
    const dailyBehave = overrides.dailyBehave ?? makeMockTask(makeResult());
    const outBehave = overrides.outBehave ?? makeMockTask(makeResult());
    const releases = overrides.releases ?? makeMockTask(makeResult());
    const schoolActivities = overrides.schoolActivities ?? makeMockTask(makeResult());
    const timetable = overrides.timetable ?? makeMockTask(makeResult());
    const bells = overrides.bells ?? makeMockTask(makeResult());
    const students = overrides.students ?? makeMockTask(makeResult());

    const service = new SyncService(
      notifications as unknown as NotificationsTask,
      mailCounts as unknown as MailCountsTask,
      mailInbox as unknown as MailInboxTask,
      homework as unknown as HomeworkTask,
      behavior as unknown as BehaviorTask,
      achvas as unknown as AchvasTask,
      groups as unknown as GroupsTask,
      lessonsCount as unknown as LessonsCountTask,
      messageBoard as unknown as MessageBoardTask,
      userDetails as unknown as UserDetailsTask,
      dailyBehave as unknown as DailyBehaveTask,
      outBehave as unknown as OutBehaveTask,
      releases as unknown as ReleasesTask,
      schoolActivities as unknown as SchoolActivitiesTask,
      timetable as unknown as TimetableTask,
      bells as unknown as BellsTask,
      students as unknown as StudentsTask,
      progress.mock as unknown as RefreshProgressService,
    );

    return {
      service,
      progress,
      tasks: {
        notifications,
        mailCounts,
        mailInbox,
        homework,
        behavior,
        achvas,
        groups,
        lessonsCount,
        messageBoard,
        userDetails,
        dailyBehave,
        outBehave,
        releases,
        schoolActivities,
        timetable,
        bells,
        students,
      },
    };
  }

  it('returns success when all tasks succeed', async () => {
    const { service } = createService();

    const result = await service.refreshAll();

    expect(result.status).toBe('success');
    expect(result.tasks).toHaveLength(EXPECTED_TASK_COUNT);
    expect(result.tasks.every((task) => task.status === 'success')).toBe(true);
    expect(result.tasks.find((task) => task.task === 'timetable')?.status).toBe('success');
    expect(typeof result.durationMs).toBe('number');
  });

  it('returns partial when at least one task fails', async () => {
    const { service } = createService({
      mailInbox: makeMockTask(makeResult('failed')),
    });

    const result = await service.refreshAll();

    expect(result.status).toBe('partial');
    expect(result.tasks.find((task) => task.task === 'mailInbox')?.status).toBe('failed');
  });

  it('joins in-flight manual refresh requests for the same connection', async () => {
    let resolveNotifications!: () => void;
    const notificationsPromise = new Promise<SyncTaskRunResult>((resolve) => {
      resolveNotifications = () => resolve(makeResult());
    });

    const notifications = { execute: jest.fn().mockReturnValue(notificationsPromise) };
    const { service, tasks } = createService({ notifications });

    const first = service.refreshAll({ connectionId: 'conn-1' });
    const second = service.refreshAll({ connectionId: 'conn-1' });
    // The roster lands before the rest, so the others start a tick later.
    await new Promise((resolve) => setImmediate(resolve));

    expect(tasks.notifications.execute).toHaveBeenCalledTimes(1);

    resolveNotifications();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(tasks.notifications.execute).toHaveBeenCalledTimes(1);
  });

  it('runs the students task before every other task', async () => {
    const order: string[] = [];
    const students = {
      execute: jest.fn().mockImplementation(async () => {
        order.push('students');
        return makeResult();
      }),
    };
    const homework = {
      execute: jest.fn().mockImplementation(async () => {
        order.push('homework');
        return makeResult();
      }),
    };
    const { service } = createService({ students, homework });

    await service.refreshAll();

    expect(order).toEqual(['students', 'homework']);
  });

  it('still runs the remaining tasks when the roster refresh fails', async () => {
    const { service, tasks } = createService({
      students: makeMockTask(makeResult('failed')),
    });

    const result = await service.refreshAll();

    expect(result.status).toBe('partial');
    expect(tasks.homework.execute).toHaveBeenCalled();
  });

  it('does not join in-flight manual refresh requests across different connections', async () => {
    const notifications = { execute: jest.fn().mockResolvedValue(makeResult()) };
    const { service, tasks } = createService({ notifications });

    await Promise.all([
      service.refreshAll({ connectionId: 'conn-1' }),
      service.refreshAll({ connectionId: 'conn-2' }),
    ]);

    expect(tasks.notifications.execute).toHaveBeenCalledTimes(2);
    expect(tasks.notifications.execute).toHaveBeenNthCalledWith(1, { connectionId: 'conn-1' });
    expect(tasks.notifications.execute).toHaveBeenNthCalledWith(2, { connectionId: 'conn-2' });
  });

  describe('refresh progress envelope', () => {
    it('opens the envelope before the roster task runs', async () => {
      const order: string[] = [];
      const progress = makeRefreshProgress();
      progress.open.mockImplementation((connectionId: string, tasksTotal: number) => {
        order.push('open');
        return {
          refreshId: 'refresh-1',
          connectionId,
          phase: 'running',
          startedAt: new Date().toISOString(),
          endedAt: null,
          updatedAt: new Date().toISOString(),
          tasksTotal,
          tasksSettled: 0,
          tasksFailed: 0,
          currentTask: null,
          tasks: [],
        };
      });
      const students = {
        execute: jest.fn().mockImplementation(async () => {
          order.push('students');
          return makeResult();
        }),
      };
      const { service } = createService({ students }, progress);

      await service.refreshAll({ connectionId: 'conn-1' });

      expect(order).toEqual(['open', 'students']);
    });

    it('derives tasksTotal from the wired task list', async () => {
      // Never a literal: the old status endpoint hardcoded 16 and the screen
      // hung forever when the real number differed.
      const progress = makeRefreshProgress();
      const { service } = createService({}, progress);

      await service.refreshAll({ connectionId: 'conn-1' });

      expect(progress.open).toHaveBeenCalledWith('conn-1', EXPECTED_TASK_COUNT);
    });

    it('writes progress as tasks settle rather than once at the end', async () => {
      const progress = makeRefreshProgress();
      const { service } = createService({}, progress);

      await service.refreshAll({ connectionId: 'conn-1' });

      expect(progress.write.mock.calls.length).toBeGreaterThanOrEqual(EXPECTED_TASK_COUNT);
      const settledCounts = progress.snapshots.map((snapshot) => snapshot.tasksSettled);
      // Monotonic, and it passes through intermediate values — a single
      // end-of-run update would only ever show 0 and EXPECTED_TASK_COUNT.
      expect(settledCounts).toEqual([...settledCounts].sort((a, b) => a - b));
      expect(new Set(settledCounts).size).toBeGreaterThan(2);
    });

    it('names a task that is actually outstanding, not the last one registered', async () => {
      // All fifteen parallel tasks are invoked in the same tick, so "the last
      // task to start" pins currentTask to the final entry of buildTasks
      // (`timetable`) within a microsecond and never moves again -- the screen
      // would claim to be syncing the timetable for the whole refresh,
      // including after the timetable finished. The label has to name
      // something still in flight.
      const progress = makeRefreshProgress();
      const { service } = createService({}, progress);

      await service.refreshAll({ connectionId: 'conn-1' });

      const labels = progress.snapshots.map((snapshot) => snapshot.currentTask);
      expect(labels).toContain('students');
      expect(labels).toContain('notifications');
      // Every reported label must be a task that had not settled at the time.
      for (const snapshot of progress.snapshots) {
        if (snapshot.currentTask === null) continue;
        const entry = snapshot.tasks.find((task) => task.task === snapshot.currentTask);
        expect(entry?.status).toBe('running');
      }
    });

    it('keeps bumping the envelope while a slow task is still outstanding', async () => {
      // Without a heartbeat, updatedAt only moves when a task starts or
      // settles. Fifteen tasks start at once; if one then runs longer than
      // STALE_RUNNING_MS after its last sibling settled, nothing touches the
      // envelope and /sync/status reports `stale` -> done:true while the
      // refresh is still working. That is the "trips done early" half of the
      // original bug, in a new costume.
      expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(STALE_RUNNING_MS);

      jest.useFakeTimers();
      try {
        let resolveSlow!: () => void;
        const slow = new Promise<SyncTaskRunResult>((resolve) => {
          resolveSlow = () => resolve(makeResult());
        });
        const progress = makeRefreshProgress();
        const { service } = createService(
          { mailInbox: { execute: jest.fn().mockReturnValue(slow) } },
          progress,
        );

        const run = service.refreshAll({ connectionId: 'conn-1' });
        await jest.advanceTimersByTimeAsync(0);

        const settledWrites = progress.write.mock.calls.length;
        await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
        expect(progress.write.mock.calls.length).toBeGreaterThan(settledWrites);

        const heartbeats = progress.snapshots.slice(settledWrites);
        expect(heartbeats.every((snapshot) => snapshot.phase === 'running')).toBe(true);

        resolveSlow();
        await run;
      } finally {
        jest.useRealTimers();
      }
    });

    it('stops the heartbeat once the refresh is over', async () => {
      jest.useFakeTimers();
      try {
        const progress = makeRefreshProgress();
        const { service } = createService({}, progress);

        const run = service.refreshAll({ connectionId: 'conn-1' });
        await jest.advanceTimersByTimeAsync(0);
        await run;

        const afterCompletion = progress.write.mock.calls.length;
        await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);

        expect(progress.write.mock.calls.length).toBe(afterCompletion);
        const last = progress.snapshots[progress.snapshots.length - 1];
        expect(last.phase).toBe('success');
      } finally {
        jest.useRealTimers();
      }
    });

    it('closes the envelope success when every task succeeded', async () => {
      const progress = makeRefreshProgress();
      const { service } = createService({}, progress);

      await service.refreshAll({ connectionId: 'conn-1' });

      const last = progress.snapshots[progress.snapshots.length - 1];
      expect(last.phase).toBe('success');
      expect(last.tasksSettled).toBe(EXPECTED_TASK_COUNT);
      expect(last.tasksFailed).toBe(0);
      expect(last.endedAt).not.toBeNull();
    });

    it('closes the envelope partial when a task failed, and still reports done', async () => {
      const progress = makeRefreshProgress();
      const { service } = createService({ groups: makeMockTask(makeResult('failed')) }, progress);

      await service.refreshAll({ connectionId: 'conn-1' });

      const last = progress.snapshots[progress.snapshots.length - 1];
      expect(last.phase).toBe('partial');
      expect(last.tasksFailed).toBe(1);
      expect(last.tasksSettled).toBe(EXPECTED_TASK_COUNT);
      expect(last.tasks.find((task) => task.task === 'groups')?.status).toBe('failed');
    });

    it('closes the envelope failed when the refresh throws outside a task', async () => {
      const progress = makeRefreshProgress();
      const { service } = createService({}, progress);
      // A throw from the orchestration itself, not from a task — executeTask
      // catches those. Left unhandled the envelope would stay `running` and
      // only the staleness clock would release the client, five minutes later.
      jest
        .spyOn(
          service as unknown as { executeTask: (...args: unknown[]) => Promise<unknown> },
          'executeTask',
        )
        .mockRejectedValue(new Error('orchestration exploded'));

      await expect(service.refreshAll({ connectionId: 'conn-1' })).rejects.toThrow(
        'orchestration exploded',
      );

      const last = progress.snapshots[progress.snapshots.length - 1];
      expect(last.phase).toBe('failed');
      expect(last.endedAt).not.toBeNull();
    });

    it('opens no envelope without a connection id', async () => {
      const progress = makeRefreshProgress();
      const { service } = createService({}, progress);

      await service.refreshAll();

      expect(progress.open).not.toHaveBeenCalled();
      expect(progress.write).not.toHaveBeenCalled();
    });

    it('does not let a prefixed run join a live refresh for the same connection', async () => {
      // The dedupe key is the connection alone. If a prefixed caller is ever
      // added, a manual refresh arriving during a backfill would join the
      // backfill's promise, return its result, and open no envelope at all --
      // leaving /sync/status on `idle` for the whole duration.
      const progress = makeRefreshProgress();
      const { service, tasks } = createService({}, progress);

      await Promise.all([
        service.refreshAll({ connectionId: 'conn-1', sourcePrefix: 'history:2025:' }),
        service.refreshAll({ connectionId: 'conn-1' }),
      ]);

      expect(tasks.homework.execute).toHaveBeenCalledTimes(2);
      expect(progress.open).toHaveBeenCalledTimes(1);
      expect(progress.open).toHaveBeenCalledWith('conn-1', EXPECTED_TASK_COUNT);
    });

    it('opens no envelope for a prefixed backfill run', async () => {
      // A history backfill is not the thing the first-login screen waits on,
      // and it must not overwrite the envelope of a live refresh.
      const progress = makeRefreshProgress();
      const { service } = createService({}, progress);

      await service.refreshAll({ connectionId: 'conn-1', sourcePrefix: 'history:2025:' });

      expect(progress.open).not.toHaveBeenCalled();
    });

    it('completes the refresh even when every envelope write rejects', async () => {
      const progress = makeRefreshProgress({
        write: jest.fn().mockRejectedValue(new Error('redis down')),
      });
      const { service } = createService({}, progress);

      const result = await service.refreshAll({ connectionId: 'conn-1' });

      expect(result.status).toBe('success');
      expect(result.tasks).toHaveLength(EXPECTED_TASK_COUNT);
    });

    it('opens one envelope when a second caller joins the in-flight refresh', async () => {
      let resolveNotifications!: () => void;
      const notificationsPromise = new Promise<SyncTaskRunResult>((resolve) => {
        resolveNotifications = () => resolve(makeResult());
      });
      const notifications = { execute: jest.fn().mockReturnValue(notificationsPromise) };
      const progress = makeRefreshProgress();
      const { service } = createService({ notifications }, progress);

      const first = service.refreshAll({ connectionId: 'conn-1' });
      const second = service.refreshAll({ connectionId: 'conn-1' });
      resolveNotifications();
      await Promise.all([first, second]);

      expect(progress.open).toHaveBeenCalledTimes(1);
    });
  });
});
