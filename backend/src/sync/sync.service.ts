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
import { TimetableTask } from './tasks/timetable.task';
import type { ManualSyncRefreshResponse, ManualSyncTaskResult, SyncTaskRunResult } from './sync.types';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private inFlightManualRefresh: Promise<ManualSyncRefreshResponse> | null = null;

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
    private readonly timetableTask: TimetableTask,
  ) {}

  async refreshAll(): Promise<ManualSyncRefreshResponse> {
    if (this.inFlightManualRefresh) {
      this.logger.debug('Manual refresh already running, joining existing request');
      return this.inFlightManualRefresh;
    }

    this.inFlightManualRefresh = this.runManualRefresh().finally(() => {
      this.inFlightManualRefresh = null;
    });
    return this.inFlightManualRefresh;
  }

  private async runManualRefresh(): Promise<ManualSyncRefreshResponse> {
    this.logger.log('Manual refresh triggered — running all sync tasks');

    const refreshStartedAt = new Date();
    const tasks: Array<{ name: string; fn: () => Promise<SyncTaskRunResult> }> = [
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
      { name: 'timetable', fn: () => this.timetableTask.execute() },
    ];

    const taskResults = await Promise.all(tasks.map((task) => this.executeTask(task.name, task.fn)));
    const hasFailures = taskResults.some((result) => result.status === 'failed');
    const refreshEndedAt = new Date();

    const response: ManualSyncRefreshResponse = {
      status: hasFailures ? 'partial' : 'success',
      startedAt: refreshStartedAt.toISOString(),
      endedAt: refreshEndedAt.toISOString(),
      durationMs: refreshEndedAt.getTime() - refreshStartedAt.getTime(),
      tasks: taskResults,
    };

    this.logger.log(`Manual refresh complete with status=${response.status}`);
    return response;
  }

  private async executeTask(
    taskName: string,
    fn: () => Promise<SyncTaskRunResult>,
  ): Promise<ManualSyncTaskResult> {
    const startedAt = new Date();

    try {
      const result = await fn();
      if (result.status === 'failed') {
        const summary =
          result.errorMessages.length > 0
            ? result.errorMessages.join('; ')
            : 'No error details provided';
        this.logger.error(`Task ${taskName} failed during refreshAll: ${summary}`);
      } else {
        this.logger.debug(`Task ${taskName} completed successfully`);
      }

      const endedAt = new Date();
      return {
        task: taskName,
        status: result.status,
        summary: result.summary,
        errorMessages: result.errorMessages,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Task ${taskName} failed during refreshAll: ${msg}`);

      const endedAt = new Date();
      return {
        task: taskName,
        status: 'failed',
        summary: {
          fetchedCount: 0,
          createdCount: 0,
          updatedCount: 0,
          failedCount: 1,
        },
        errorMessages: [msg],
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
      };
    }
  }
}
