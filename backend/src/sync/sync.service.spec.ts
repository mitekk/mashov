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
import { TimetableTask } from './tasks/timetable.task';

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

describe('SyncService', () => {
  const EXPECTED_TASK_COUNT = 13;

  function createService(overrides: Partial<Record<string, { execute: jest.Mock }>> = {}) {
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
    const timetable = overrides.timetable ?? makeMockTask(makeResult());

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
      timetable as unknown as TimetableTask,
    );

    return {
      service,
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
        timetable,
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

  it('joins in-flight manual refresh requests', async () => {
    let resolveNotifications!: () => void;
    const notificationsPromise = new Promise<SyncTaskRunResult>((resolve) => {
      resolveNotifications = () => resolve(makeResult());
    });

    const notifications = { execute: jest.fn().mockReturnValue(notificationsPromise) };
    const { service, tasks } = createService({ notifications });

    const first = service.refreshAll();
    const second = service.refreshAll();

    expect(tasks.notifications.execute).toHaveBeenCalledTimes(1);

    resolveNotifications();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(tasks.notifications.execute).toHaveBeenCalledTimes(1);
  });
});
