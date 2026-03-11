import { Injectable, Logger } from '@nestjs/common';
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

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly notificationsTask: NotificationsTask,
    private readonly mailCountsTask: MailCountsTask,
    private readonly mailInboxTask: MailInboxTask,
    private readonly homeworkTask: HomeworkTask,
    private readonly behaviorTask: BehaviorTask,
    private readonly achvasTask: AchvasTask,
    private readonly groupsTask: GroupsTask,
    private readonly lessonsCountTask: LessonsCountTask,
    private readonly messageBoardTask: MessageBoardTask,
    private readonly userDetailsTask: UserDetailsTask,
    private readonly dailyBehaveTask: DailyBehaveTask,
    private readonly outBehaveTask: OutBehaveTask,
  ) {}

  async refreshAll(): Promise<void> {
    this.logger.log('Manual refresh triggered — running all sync tasks');

    const tasks: Array<{ name: string; fn: () => Promise<void> }> = [
      { name: 'notifications', fn: () => this.notificationsTask.execute() },
      { name: 'mailCounts', fn: () => this.mailCountsTask.execute() },
      { name: 'mailInbox', fn: () => this.mailInboxTask.execute() },
      { name: 'homework', fn: () => this.homeworkTask.execute() },
      { name: 'behavior', fn: () => this.behaviorTask.execute() },
      { name: 'achvas', fn: () => this.achvasTask.execute() },
      { name: 'groups', fn: () => this.groupsTask.execute() },
      { name: 'lessonsCount', fn: () => this.lessonsCountTask.execute() },
      { name: 'messageBoard', fn: () => this.messageBoardTask.execute() },
      { name: 'userDetails', fn: () => this.userDetailsTask.execute() },
      { name: 'dailyBehave', fn: () => this.dailyBehaveTask.execute() },
      { name: 'outBehave', fn: () => this.outBehaveTask.execute() },
    ];

    const results = await Promise.allSettled(tasks.map((t) => t.fn()));

    results.forEach((result, index) => {
      const taskName = tasks[index]?.name ?? `task[${index}]`;
      if (result.status === 'rejected') {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.error(`Task ${taskName} failed during refreshAll: ${msg}`);
      } else {
        this.logger.debug(`Task ${taskName} completed successfully`);
      }
    });

    this.logger.log('Manual refresh complete');
  }
}
