import { Injectable, Logger } from '@nestjs/common';
import { MailCountsTask } from './tasks/mail-counts.task';
import { MailInboxTask } from './tasks/mail-inbox.task';
import { HomeworkTask } from './tasks/homework.task';
import { BehaviorTask } from './tasks/behavior.task';
import { GradesTask } from './tasks/grades.task';
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
import { HEARTBEAT_INTERVAL_MS, RefreshProgressService } from './refresh-progress.service';
import type { RefreshEnvelope } from './refresh-progress.service';
import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService } from './freshness.service';
import { policyForTask, sourcesForSet } from './source-policy';
import { studentScopeForContext } from './connection-fanout';
import type {
  ManualSyncRefreshResponse,
  ManualSyncTaskResult,
  SyncExecutionContext,
  SyncTaskRunResult,
} from './sync.types';

/**
 * The task the screen should name: the first one still outstanding.
 *
 * Every parallel task is invoked in the same tick, so "the last task to start"
 * settles on the final entry of the list immediately and never moves — the UI
 * would name one task for the entire refresh, including after it finished.
 * Insertion order makes this stable and monotonic.
 */
function firstOutstanding(envelope: RefreshEnvelope): string | null {
  return envelope.tasks.find((task) => task.status === 'running')?.task ?? null;
}

/**
 * A source the TTL already covers: reported as a zero-count success rather
 * than dropped, so a caller reading `tasks` can see it was considered and
 * found fresh instead of inferring it from an absence.
 *
 * These are deliberately NOT counted in `tasksTotal`, which covers only what
 * actually runs -- the progress bar must not sit at 4/9 forever because five
 * sources were skipped before it opened. So `tasks.length > tasksTotal`
 * whenever anything is skipped, and that is the intended shape.
 */
function skippedResult(task: string, at: Date): ManualSyncTaskResult {
  const stamp = at.toISOString();
  return {
    task,
    status: 'success',
    summary: { fetchedCount: 0, createdCount: 0, updatedCount: 0, failedCount: 0 },
    errorMessages: [],
    startedAt: stamp,
    endedAt: stamp,
    durationMs: 0,
  };
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  /**
   * Per-process, like the `@Throttle` budget on the controller.
   *
   * With more than one replica two tabs on the same connection can land on
   * different processes: each opens its own envelope under the same Redis key,
   * so `tasksSettled` can regress between polls and the slower replica's next
   * heartbeat can overwrite the faster one's terminal write with `running`
   * again. It self-heals when the second replica finishes, and the first
   * client has already navigated — but the ADR's "an awaited terminal write
   * cannot be raced" is a single-process guarantee. Deployment is currently
   * single-replica; scaling out needs a Redis lock here, not a Map.
   */
  private inFlightManualRefreshByConnection = new Map<string, Promise<ManualSyncRefreshResponse>>();

  constructor(
    private readonly mailCountsTask: MailCountsTask,
    private readonly mailInboxTask: MailInboxTask,
    private readonly homeworkTask: HomeworkTask,
    private readonly behaviorTask: BehaviorTask,
    private readonly gradesTask: GradesTask,
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
    private readonly bellsTask: BellsTask,
    private readonly studentsTask: StudentsTask,
    private readonly refreshProgress: RefreshProgressService,
    private readonly prisma: PrismaService,
    private readonly freshness: FreshnessService,
  ) {}

  /**
   * The tasks whose newest successful run is still inside their TTL.
   *
   * One `sync_run` read for the whole decision, reusing `loadSyncRuns` -- the
   * same "one read, many questions" the freshness page does. Matching follows
   * the variant-key rule (`key === base || key.startsWith(base + ':')`), so a
   * per-student or per-connection run counts for its base source.
   *
   * A source with NO successful run is never skipped, which is what makes a
   * first login fetch everything in its set.
   */
  private async tasksInsideTtl(
    context: SyncExecutionContext,
    tasks: Array<{ name: string }>,
  ): Promise<Set<string>> {
    const skip = new Set<string>();
    // A historical backfill is not 'recent work on this source' in the sense
    // the TTL asks about, and its prefixed keys must not satisfy the gate.
    if (context.sourcePrefix !== undefined) return skip;

    const { successRuns } = await this.freshness.loadSyncRuns(context.connectionId);
    const now = Date.now();

    for (const task of tasks) {
      const policy = policyForTask(task.name);
      if (!policy) continue;
      let newest: number | null = null;
      for (const [key, run] of successRuns) {
        if (key !== policy.source && !key.startsWith(`${policy.source}:`)) continue;
        const endedAt = run.endedAt ? new Date(run.endedAt).getTime() : null;
        if (endedAt !== null && (newest === null || endedAt > newest)) newest = endedAt;
      }
      if (newest !== null && now - newest < policy.syncTtlMinutes * 60_000) {
        skip.add(task.name);
      }
    }
    return skip;
  }

  /** Whether this run has any child to iterate at all. */
  private async scopedRosterIsEmpty(context: SyncExecutionContext): Promise<boolean> {
    const count = await this.prisma.student.count({
      where: studentScopeForContext(context),
      take: 1,
    });
    return count === 0;
  }

  async refreshAll(context: SyncExecutionContext = {}): Promise<ManualSyncRefreshResponse> {
    // The prefix is part of the key, not just the connection: a prefixed
    // backfill and a live refresh for the same connection are different work
    // with different output. Joined together, the manual refresh would return
    // the backfill's result and open no envelope, leaving /sync/status on
    // `idle` for as long as the backfill ran.
    //
    // The task set is part of the key too. Without it a background `digest`
    // run could be joined and RETURNED to a user's `login` refresh: the user
    // would be handed a result covering five sources as though it covered
    // theirs, and no envelope would be opened for the screen they are watching.
    const dedupeKey =
      `${context.connectionId ?? '__global__'}::${context.sourcePrefix ?? ''}` +
      `::${context.taskSet ?? 'full'}`;
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
      `Refresh triggered (set=${context.taskSet ?? 'full'}, ` +
        `connectionId=${context.connectionId ?? 'global'})`,
    );

    const refreshStartedAt = new Date();
    const set = context.taskSet ?? 'full';
    const wanted = new Set(sourcesForSet(set).map((policy) => policy.task));
    const allTasks = this.buildTasks(context).filter((task) => wanted.has(task.name));
    // `students` is probed alongside them although it is NOT in `buildTasks`:
    // the roster runs on its own, ahead of the rest. Omit it here and
    // `skipped.has('students')` is false by construction, so `rosterInSet`
    // collapses to `wanted.has('students')` and the roster -- a full upstream
    // login, with no TTL gate of its own inside `StudentsTask` -- runs on
    // EVERY digest-lead tick. That is nine logins per connection per day for
    // data that changes once a year, which is the opposite of this change.
    const ttlProbe = wanted.has('students') ? [...allTasks, { name: 'students' }] : allTasks;
    const skipped = context.respectTtl ? await this.tasksInsideTtl(context, ttlProbe) : new Set<string>();
    const tasks = allTasks.filter((task) => !skipped.has(task.name));
    // +1 for the roster, which runs on its own ahead of the rest. Derived from
    // the wired list and known before anything runs: the status endpoint used
    // to compare a count of successful `sync_run` sources against a hardcoded
    // 16, a number nothing made reachable.
    //
    // The roster runs when its set includes it, or when the scoped roster is
    // EMPTY. Skipping it unconditionally for the `digest`/`mail` sets looks
    // right but is not: every other task iterates `prisma.student.findMany`,
    // so with no local roster a digest-set run does literally nothing and
    // reports `success` with every count zero.
    const rosterInSet = wanted.has('students') && !skipped.has('students');
    const runRoster = rosterInSet || (await this.scopedRosterIsEmpty(context));
    if (runRoster && !rosterInSet) {
      this.logger.warn(
        `Roster is empty for connectionId=${context.connectionId ?? 'global'}; ` +
          `running students ahead of the ${set} set, which would otherwise fetch nothing`,
      );
    }
    const tasksTotal = tasks.length + (runRoster ? 1 : 0);

    // Only a real, unprefixed, per-connection refresh that somebody is
    // WATCHING owns an envelope. The global path has no connection to key it
    // on; a prefixed history backfill is not what the first-login screen is
    // waiting for and must not overwrite a live refresh's envelope; and a
    // `silent` background run must not either -- publishing under the
    // connection's key would tell `/sync/status` a refresh is `running` to a
    // parent who is only browsing.
    const envelope =
      context.connectionId && context.sourcePrefix === undefined && !context.silent
        ? this.refreshProgress.open(context.connectionId, tasksTotal)
        : null;

    // Proves liveness while a slow task holds the refresh open. Without it a
    // task running longer than STALE_RUNNING_MS past its last sibling leaves
    // the envelope untouched, and every polling client is told the refresh is
    // over while it is still working.
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    try {
      if (envelope) {
        this.publish(envelope);
        heartbeat = setInterval(() => this.publish(envelope), HEARTBEAT_INTERVAL_MS);
        // Never hold the event loop open for a heartbeat.
        heartbeat.unref?.();
      }

      // The roster goes first, on its own: every other task iterates
      // `prisma.student.findMany`, so a child who moved up a grade — or a child
      // who is new — is invisible to them until this has landed.
      const rosterResults = runRoster
        ? [
            await this.runTracked(envelope, 'students', () =>
              this.studentsTask.execute(context),
            ),
          ]
        : [];

      const taskResults = [
        ...rosterResults,
        ...(await Promise.all(
          tasks.map((task) => this.runTracked(envelope, task.name, task.fn)),
        )),
        // Reported, not dropped. A caller reading `tasks` must be able to see
        // that a source was considered and found fresh, rather than infer it
        // from an absence.
        ...[...skipped].map((name) => skippedResult(name, refreshStartedAt)),
      ];
      // Stopped before the terminal write, so no heartbeat can land after it
      // and resurrect `phase: 'running'`.
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }

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
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (envelope) {
        envelope.phase = 'failed';
        envelope.endedAt = new Date().toISOString();
        await this.publishAndWait(envelope);
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  /** The task list, built before anything runs so its length is known up front. */
  private buildTasks(
    context: SyncExecutionContext,
  ): Array<{ name: string; fn: () => Promise<SyncTaskRunResult> }> {
    return [
      { name: 'mailCounts', fn: () => this.mailCountsTask.execute(context) },
      { name: 'mailInbox', fn: () => this.mailInboxTask.execute(context) },
      { name: 'homework', fn: () => this.homeworkTask.execute(context) },
      { name: 'behavior', fn: () => this.behaviorTask.execute(context) },
      { name: 'grades', fn: () => this.gradesTask.execute(context) },
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
      { name: 'bells', fn: () => this.bellsTask.execute(context) },
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
      envelope.tasks.push({ task: taskName, status: 'running' });
      envelope.currentTask = firstOutstanding(envelope);
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
      // Recomputed on every settle so the label advances through the parallel
      // phase instead of naming whichever task happened to be registered last.
      envelope.currentTask = firstOutstanding(envelope);
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
