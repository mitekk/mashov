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
import { StudentsTask } from './tasks/students.task';
import type { RefreshEnvelope, RefreshProgressService } from './refresh-progress.service';

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
  const EXPECTED_TASK_COUNT = 16;

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

    it('names the task in flight so the screen can say what is happening', async () => {
      const progress = makeRefreshProgress();
      const { service } = createService({}, progress);

      await service.refreshAll({ connectionId: 'conn-1' });

      expect(progress.snapshots.some((snapshot) => snapshot.currentTask === 'students')).toBe(true);
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
