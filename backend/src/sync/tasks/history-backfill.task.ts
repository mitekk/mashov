import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { historyStartYear } from '../../common/school-year/school-year.scope';
import { SyncRunService } from '../sync-run.service';
import type { SyncExecutionContext, SyncTaskRunResult } from '../sync.types';
import { HomeworkTask } from './homework.task';
import { BehaviorTask } from './behavior.task';
import { GroupsTask } from './groups.task';
import { LessonsCountTask } from './lessons-count.task';
import { MessageBoardTask } from './message-board.task';
import { DailyBehaveTask } from './daily-behave.task';
import { OutBehaveTask } from './out-behave.task';
import { TimetableTask } from './timetable.task';

interface YearScopedTask {
  execute(context?: SyncExecutionContext): Promise<SyncTaskRunResult>;
}

interface BackfillConnection {
  id: string;
  schoolYear: number;
  schoolYears: unknown;
}

/**
 * Fetches each historical school year once, then no-ops forever.
 *
 * The crons run the current year only. This fills in the years behind it, so
 * `MASHOV_YEAR` can mean "the earliest year to fetch" without every tick
 * paying for every year. A year is marked complete only once all eight
 * year-scoped tasks have succeeded for it, which makes the whole thing
 * resumable after a crash: a partial year is retried tomorrow rather than
 * recorded as done.
 *
 * Deliberately has NO `onApplicationBootstrap` hook. The rollover task's
 * awaited hook was a review finding on PR #8 for exactly this reason: boot
 * must not depend on upstream availability.
 */
@Injectable()
export class HistoryBackfillTask {
  private readonly logger = new Logger(HistoryBackfillTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly syncRunService: SyncRunService,
    private readonly homeworkTask: HomeworkTask,
    private readonly behaviorTask: BehaviorTask,
    private readonly groupsTask: GroupsTask,
    private readonly lessonsCountTask: LessonsCountTask,
    private readonly messageBoardTask: MessageBoardTask,
    private readonly dailyBehaveTask: DailyBehaveTask,
    private readonly outBehaveTask: OutBehaveTask,
    private readonly timetableTask: TimetableTask,
  ) {}

  /** The source that records a finished year. This row IS the ledger. */
  static completionSource(year: number): string {
    return `${HistoryBackfillTask.sourcePrefix(year)}complete`;
  }

  static sourcePrefix(year: number): string {
    return `history:${year}:`;
  }

  @Cron('0 3 * * *')
  async run(): Promise<void> {
    const connections = await this.prisma.householdConnection.findMany({
      where: { active: true },
    });

    for (const connection of connections) {
      try {
        await this.backfillConnection(connection);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `History backfill failed for connection ${connection.id}: ${message}`,
        );
      }
    }
  }

  private async backfillConnection(connection: BackfillConnection): Promise<void> {
    const current = connection.schoolYear;
    const start = historyStartYear(current, this.configService);

    // Descending, so the most recent and most useful year lands first if the
    // run is interrupted. The current year is never a candidate — that is the
    // crons' job, and this task must not compete with them for it.
    const candidates: number[] = [];
    for (let year = current - 1; year >= start; year--) {
      candidates.push(year);
    }
    if (candidates.length === 0) return;

    // A year the child has no records for costs nothing if we know about it.
    // An empty or missing array means Mashov did not say, so the capped
    // window is used blind rather than skipping everything.
    const enrolled = this.enrolledYears(connection.schoolYears);
    const eligible =
      enrolled.length > 0 ? candidates.filter((year) => enrolled.includes(year)) : candidates;

    for (const year of eligible) {
      if (await this.isAlreadyComplete(connection.id, year)) continue;
      // One year per connection per nightly run: a historical year is not
      // urgent, and the worst case stays bounded at two nights.
      await this.backfillYear(connection, year);
      return;
    }
  }

  private async backfillYear(connection: BackfillConnection, year: number): Promise<void> {
    const sourcePrefix = HistoryBackfillTask.sourcePrefix(year);
    const run = await this.syncRunService.openRun(
      HistoryBackfillTask.completionSource(year),
      connection.id,
    );

    const context: SyncExecutionContext = {
      connectionId: connection.id,
      schoolYear: year,
      sourcePrefix,
    };

    const failures: string[] = [];

    // Sequential, not Promise.all: eight concurrent logins for one connection
    // against a rate-limited upstream is how you earn a block, and nothing
    // about a finished school year is urgent.
    for (const [name, task] of this.yearScopedTasks()) {
      try {
        const result = await task.execute(context);
        if (result.status !== 'success') {
          failures.push(`${name}: ${result.errorMessages.join('; ') || 'failed'}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${name}: ${message}`);
      }
    }

    if (failures.length === 0) {
      await this.syncRunService.closeRun(run.id, 'success', { fetchedCount: 0 });
      this.logger.log(
        `History backfill complete for connection ${connection.id} year=${year}`,
      );
      return;
    }

    // Failed, so the ledger row does not count as complete and tomorrow's run
    // retries this year rather than moving past it.
    await this.syncRunService.closeRun(run.id, 'failed', {
      errorMessage: failures.join(' | ').substring(0, 1000),
    });
    this.logger.warn(
      `History backfill incomplete for connection ${connection.id} year=${year}; will retry: ${failures.join(' | ')}`,
    );
  }

  /** The eight year-scoped tasks. Mail and notifications carry no year. */
  private yearScopedTasks(): Array<[string, YearScopedTask]> {
    return [
      [HomeworkTask.SOURCE, this.homeworkTask],
      [BehaviorTask.SOURCE, this.behaviorTask],
      [GroupsTask.SOURCE, this.groupsTask],
      [LessonsCountTask.SOURCE, this.lessonsCountTask],
      [MessageBoardTask.SOURCE, this.messageBoardTask],
      [DailyBehaveTask.SOURCE, this.dailyBehaveTask],
      [OutBehaveTask.SOURCE, this.outBehaveTask],
      [TimetableTask.SOURCE, this.timetableTask],
    ];
  }

  private async isAlreadyComplete(connectionId: string, year: number): Promise<boolean> {
    const run = await this.prisma.syncRun.findFirst({
      where: {
        source: HistoryBackfillTask.completionSource(year),
        householdConnectionId: connectionId,
        status: 'success',
      },
    });
    return run !== null;
  }

  private enrolledYears(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => Number(entry))
      .filter((year) => Number.isInteger(year) && year > 0);
  }
}
