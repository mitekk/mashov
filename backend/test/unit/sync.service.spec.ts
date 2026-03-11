import { Test, TestingModule } from '@nestjs/testing';
import { SyncService } from '../../src/sync/sync.service';
import { NotificationsTask } from '../../src/sync/tasks/notifications.task';
import { MailCountsTask } from '../../src/sync/tasks/mail-counts.task';
import { MailInboxTask } from '../../src/sync/tasks/mail-inbox.task';
import { HomeworkTask } from '../../src/sync/tasks/homework.task';
import { BehaviorTask } from '../../src/sync/tasks/behavior.task';
import { AchvasTask } from '../../src/sync/tasks/achvas.task';
import { GroupsTask } from '../../src/sync/tasks/groups.task';
import { LessonsCountTask } from '../../src/sync/tasks/lessons-count.task';
import { MessageBoardTask } from '../../src/sync/tasks/message-board.task';
import { UserDetailsTask } from '../../src/sync/tasks/user-details.task';
import { DailyBehaveTask } from '../../src/sync/tasks/daily-behave.task';
import { OutBehaveTask } from '../../src/sync/tasks/out-behave.task';

const createMockTask = () => ({
  execute: jest.fn().mockResolvedValue(undefined),
});

describe('SyncService', () => {
  let service: SyncService;
  let notificationsTask: ReturnType<typeof createMockTask>;
  let mailCountsTask: ReturnType<typeof createMockTask>;
  let mailInboxTask: ReturnType<typeof createMockTask>;
  let homeworkTask: ReturnType<typeof createMockTask>;
  let behaviorTask: ReturnType<typeof createMockTask>;
  let achvasTask: ReturnType<typeof createMockTask>;
  let groupsTask: ReturnType<typeof createMockTask>;
  let lessonsCountTask: ReturnType<typeof createMockTask>;
  let messageBoardTask: ReturnType<typeof createMockTask>;
  let userDetailsTask: ReturnType<typeof createMockTask>;
  let dailyBehaveTask: ReturnType<typeof createMockTask>;
  let outBehaveTask: ReturnType<typeof createMockTask>;

  beforeEach(async () => {
    notificationsTask = createMockTask();
    mailCountsTask = createMockTask();
    mailInboxTask = createMockTask();
    homeworkTask = createMockTask();
    behaviorTask = createMockTask();
    achvasTask = createMockTask();
    groupsTask = createMockTask();
    lessonsCountTask = createMockTask();
    messageBoardTask = createMockTask();
    userDetailsTask = createMockTask();
    dailyBehaveTask = createMockTask();
    outBehaveTask = createMockTask();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: NotificationsTask, useValue: notificationsTask },
        { provide: MailCountsTask, useValue: mailCountsTask },
        { provide: MailInboxTask, useValue: mailInboxTask },
        { provide: HomeworkTask, useValue: homeworkTask },
        { provide: BehaviorTask, useValue: behaviorTask },
        { provide: AchvasTask, useValue: achvasTask },
        { provide: GroupsTask, useValue: groupsTask },
        { provide: LessonsCountTask, useValue: lessonsCountTask },
        { provide: MessageBoardTask, useValue: messageBoardTask },
        { provide: UserDetailsTask, useValue: userDetailsTask },
        { provide: DailyBehaveTask, useValue: dailyBehaveTask },
        { provide: OutBehaveTask, useValue: outBehaveTask },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
  });

  describe('refreshAll', () => {
    it('calls execute() on all tasks', async () => {
      await service.refreshAll();

      expect(notificationsTask.execute).toHaveBeenCalledTimes(1);
      expect(mailCountsTask.execute).toHaveBeenCalledTimes(1);
      expect(mailInboxTask.execute).toHaveBeenCalledTimes(1);
      expect(homeworkTask.execute).toHaveBeenCalledTimes(1);
      expect(behaviorTask.execute).toHaveBeenCalledTimes(1);
      expect(achvasTask.execute).toHaveBeenCalledTimes(1);
      expect(groupsTask.execute).toHaveBeenCalledTimes(1);
      expect(lessonsCountTask.execute).toHaveBeenCalledTimes(1);
      expect(messageBoardTask.execute).toHaveBeenCalledTimes(1);
      expect(userDetailsTask.execute).toHaveBeenCalledTimes(1);
      expect(dailyBehaveTask.execute).toHaveBeenCalledTimes(1);
      expect(outBehaveTask.execute).toHaveBeenCalledTimes(1);
    });

    it('does not reject when one task throws an error', async () => {
      notificationsTask.execute.mockRejectedValueOnce(new Error('Upstream unavailable'));

      // Should not throw
      await expect(service.refreshAll()).resolves.toBeUndefined();
    });

    it('continues running remaining tasks even when one fails', async () => {
      homeworkTask.execute.mockRejectedValueOnce(new Error('DB timeout'));

      await service.refreshAll();

      // All other tasks should still have been called
      expect(notificationsTask.execute).toHaveBeenCalledTimes(1);
      expect(behaviorTask.execute).toHaveBeenCalledTimes(1);
      expect(achvasTask.execute).toHaveBeenCalledTimes(1);
    });

    it('handles all tasks failing without rejecting', async () => {
      const error = new Error('Network unavailable');
      notificationsTask.execute.mockRejectedValue(error);
      mailCountsTask.execute.mockRejectedValue(error);
      mailInboxTask.execute.mockRejectedValue(error);
      homeworkTask.execute.mockRejectedValue(error);
      behaviorTask.execute.mockRejectedValue(error);
      achvasTask.execute.mockRejectedValue(error);
      groupsTask.execute.mockRejectedValue(error);
      lessonsCountTask.execute.mockRejectedValue(error);
      messageBoardTask.execute.mockRejectedValue(error);
      userDetailsTask.execute.mockRejectedValue(error);
      dailyBehaveTask.execute.mockRejectedValue(error);
      outBehaveTask.execute.mockRejectedValue(error);

      await expect(service.refreshAll()).resolves.toBeUndefined();
    });
  });
});
