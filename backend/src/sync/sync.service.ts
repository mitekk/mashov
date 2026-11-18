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
import { ReleasesTask } from './tasks/releases.task';
import { SchoolActivitiesTask } from './tasks/school-activities.task';
import { TimetableTask } from './tasks/timetable.task';
import { StudentsTask } from './tasks/students.task';
import { RefreshProgressService } from './refresh-progress.service';
import type { RefreshEnvelope } from './refresh-progress.service';
import type {
  ManualSyncRefreshResponse,
  ManualSyncTaskResult,
  SyncExecutionContext,
  SyncTaskRunResult,
} from './sync.types';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private inFlightManualRefreshByConnection = new Map<string, Promise<ManualSyncRefreshResponse>>();

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
    private readonly releasesTask: ReleasesTask,
    private readonly schoolActivitiesTask: SchoolActivitiesTask,
    private readonly timetableTask: TimetableTask,
    private readonly studentsTask: StudentsTask,
    private readonly refreshProgress: RefreshProgressService,
  ) {}

  async refreshAll(context: SyncExecutionContext = {}): Promise<ManualSyncRefreshResponse> {
    const dedupeKey = context.connectionId ?? '__global__';
    const existing = this.inFlightManualRefreshByConnection.get(dedupeKey);
    if (existing) {
      this.logger.debug(`Manual refresh already running for key=${dedupeKey}, joining existing request`);
      return existing;
    }

    const inFlight = this.runManualRefresh(context).finally(() => {
      this.inFlightManualRefreshByConnection.delete(dedupeKey);
    });
    this.inFlightManualRefreshByConnection.set(dedupeKey, inFlight);
    return inFlight;
  }

  private async runManualRefresh(context: SyncExecutionContext): Promise<ManualSyncRefreshResponse> {
    this.logger.log(
      `Manual refresh triggered — running all sync tasks (connectionId=${context.connectionId ?? 'global'})`,
    );

    const refreshStartedAt = new Date();
    const tasks = this.buildTasks(context);
    // +1 for the roster, which runs on its own ahead of the rest. Derived from
    // the wired list and known before anything runs: the status endpoint used
    // to compare a count of successful `sync_run` sources against a hardcoded
    // 16, a number nothing made reachable.
    const tasksTotal = tasks.length + 1;

    // Only a real, unprefixed, per-connection refresh owns an envelope. The
    // global cron path has no connection to key it on, and a prefixed history
    // backfill is not what the first-login screen is waiting for — it must not
    // overwrite the envelope of a live refresh.
    const envelope =
      context.connectionId && context.sourcePrefix === undefined
        ? this.refreshProgress.open(context.connectionId, tasksTotal)
        : null;

    try {
      if (envelope) {
        this.publish(envelope);
      }

      // The roster goes first, on its own: every other task iterates
      // `prisma.student.findMany`, so a child who moved up a grade — or a child
      // who is new — is invisible to them until this has landed.
      const rosterResult = await this.runTracked(envelope, 'students', () =>
        this.studentsTask.execute(context),
      );

      const taskResults = [
        rosterResult,
        ...(await Promise.all(
          tasks.map((task) => this.runTracked(envelope, task.name, task.fn)),
        )),
      ];
      const hasFailures = taskResults.some((result) => result.status === 'failed');
      const refreshEndedAt = new Date();

      if (envelope) {
        envelope.phase = hasFailures ? 'partial' : 'success';
        envelope.endedAt = refreshEndedAt.toISOString();
        envelope.currentTask = null;
        // Awaited, not fired and forgotten: the client polls every few seconds
        // and must not be able to read a `running` envelope after the response
        // that completed it.
        await this.publishAndWait(envelope);
      }

      const response: ManualSyncRefreshResponse = {
        status: hasFailures ? 'partial' : 'success',
        startedAt: refreshStartedAt.toISOString(),
        endedAt: refreshEndedAt.toISOString(),
        durationMs: refreshEndedAt.getTime() - refreshStartedAt.getTime(),
        tasks: taskResults,
      };

      this.logger.log(`Manual refresh complete with status=${response.status}`);
      return response;
    } catch (error) {
      // `executeTask` swallows task failures, so reaching here means the
      // orchestration itself broke. Left alone the envelope would stay
      // `running` and only the staleness clock would release the client.
      if (envelope) {
        envelope.phase = 'failed';
        envelope.endedAt = new Date().toISOString();
        await this.publishAndWait(envelope);
      }
      throw error;
    }
  }

  /** The task list, built before anything runs so its length is known up front. */
  private buildTasks(
    context: SyncExecutionContext,
  ): Array<{ name: string; fn: () => Promise<SyncTaskRunResult> }> {
    return [
      { name: 'notifications', fn: () => this.notificationsTask.execute(context) },
      { name: 'mailCounts', fn: () => this.mailCountsTask.execute(context) },
      { name: 'mailInbox', fn: () => this.mailInboxTask.execute(context) },
      { name: 'homework', fn: () => this.homeworkTask.execute(context) },
      { name: 'behavior', fn: () => this.behaviorTask.execute(context) },
      { name: 'achvas', fn: () => this.achvasTask.execute(context) },
      { name: 'groups', fn: () => this.groupsTask.execute(context) },
      { name: 'lessonsCount', fn: () => this.lessonsCountTask.execute(context) },
      { name: 'messageBoard', fn: () => this.messageBoardTask.execute(context) },
      { name: 'userDetails', fn: () => this.userDetailsTask.execute(context) },
      { name: 'dailyBehave', fn: () => this.dailyBehaveTask.execute(context) },
      { name: 'outBehave', fn: () => this.outBehaveTask.execute(context) },
      { name: 'releases', fn: () => this.releasesTask.execute(context) },
      { name: 'schoolActivities', fn: () => this.schoolActivitiesTask.execute(context) },
      { name: 'timetable', fn: () => this.timetableTask.execute(context) },
    ];
  }

  /**
   * Runs one task and reports its settlement into the envelope as it happens.
   *
   * Progress has to stream: a single update at the end would leave the screen
   * at zero for the whole refresh, which is indistinguishable from the hang
   * this replaced.
   */
  private async runTracked(
    envelope: RefreshEnvelope | null,
    taskName: string,
    fn: () => Promise<SyncTaskRunResult>,
  ): Promise<ManualSyncTaskResult> {
    if (envelope) {
      envelope.currentTask = taskName;
      envelope.tasks.push({ task: taskName, status: 'running' });
      this.publish(envelope);
    }

    const result = await this.executeTask(taskName, fn);

    if (envelope) {
      const entry = envelope.tasks.find((task) => task.task === taskName);
      if (entry) {
        entry.status = result.status;
      }
      envelope.tasksSettled += 1;
      if (result.status === 'failed') {
        envelope.tasksFailed += 1;
      }
      this.publish(envelope);
    }

    return result;
  }

  /**
   * Fire-and-forget write. `write` serialises the envelope synchronously before
   * it touches Redis, so the snapshot is accurate even though we do not await
   * it — and a slow Redis cannot pace the refresh.
   */
  private publish(envelope: RefreshEnvelope): void {
    void this.publishAndWait(envelope);
  }

  /**
   * Awaited write for the terminal phase, with the same guarantee as the
   * fire-and-forget one: progress reporting must never be able to fail the
   * refresh it reports on, so a rejection here is swallowed too.
   */
  private async publishAndWait(envelope: RefreshEnvelope): Promise<void> {
    try {
      await this.refreshProgress.write(envelope);
    } catch {
      // `RefreshProgressService.write` already logs its own failures.
    }
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
