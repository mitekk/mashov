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
/**
 * How many failed attempts retire a year. Without a cap, a year the child was
 * never enrolled in — or one Mashov refuses outright — costs eight fetches a
 * night forever. The failed `syncRun` rows ARE the counter, so this still
 * needs no new table.
 */
const MAX_ATTEMPTS_PER_YEAR = 3;

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

    // One year per connection per nightly run: a historical year is not
    // urgent. Which year is chosen by fewest failed attempts first, most
    // recent year breaking the tie — so a year that fails every night cannot
    // block the older one forever, which a plain "first incomplete wins"
    // order would do as soon as failures are reported honestly.
    const year = await this.nextYearToAttempt(connection.id, eligible);
    if (year === null) return;

    await this.backfillYear(connection, year);
  }

  private async nextYearToAttempt(
    connectionId: string,
    eligible: number[],
  ): Promise<number | null> {
    let best: { year: number; attempts: number } | null = null;

    for (const year of eligible) {
      if (await this.isAlreadyComplete(connectionId, year)) continue;

      const attempts = await this.failedAttempts(connectionId, year);
      if (attempts >= MAX_ATTEMPTS_PER_YEAR) {
        this.logger.warn(
          `History backfill giving up on connection ${connectionId} year=${year} after ${attempts} failed attempts; Mashov may not serve it at all`,
        );
        continue;
      }

      // `eligible` is descending, so a strict `<` keeps the most recent year
      // when attempt counts tie.
      if (best === null || attempts < best.attempts) {
        best = { year, attempts };
      }
    }

    return best?.year ?? null;
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
    let fetchedCount = 0;

    // Sequential, not Promise.all: eight concurrent logins for one connection
    // against a rate-limited upstream is how you earn a block, and nothing
    // about a finished school year is urgent.
    for (const [name, task] of this.yearScopedTasks()) {
      try {
        const result = await task.execute(context);
        fetchedCount += result.summary.fetchedCount;
        if (result.status !== 'success') {
          failures.push(`${name}: ${result.errorMessages.join('; ') || 'failed'}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${name}: ${message}`);
      }
    }

    // A task reporting success having fetched nothing is not evidence of a
    // finished year — a refused historical login looks exactly like an empty
    // one. Recording it complete would retire the year permanently with no
    // data and no path back short of manual SQL.
    if (failures.length === 0 && fetchedCount === 0) {
      failures.push('fetched nothing at all; treating the year as not yet done');
    }

    // If Mashov silently coerced the login to the current year, the rows were
    // stamped `year` while holding another year's content. Both rows satisfy
    // the unique key, so every item would appear twice in the feed with
    // nothing anywhere to notice. Dates are the only evidence available.
    if (failures.length === 0) {
      const strayed = await this.contentOutsideYear(year);
      if (strayed !== null) {
        failures.push(
          `newest content ${strayed.toISOString()} is outside school year ${year}; Mashov may have answered with a different year`,
        );
      }
    }

    if (failures.length === 0) {
      await this.syncRunService.closeRun(run.id, 'success', { fetchedCount });
      this.logger.log(
        `History backfill complete for connection ${connection.id} year=${year} fetched=${fetchedCount}`,
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

  /**
   * The newest dated row stamped with `year`, if it falls outside that school
   * year — else null. A Mashov year N runs Sep (N-1) to Jun N, so anything
   * from 1 September of year N onwards belongs to year N+1.
   */
  private async contentOutsideYear(year: number): Promise<Date | null> {
    const [homework, behavior] = await Promise.all([
      this.prisma.homeworkItem.aggregate({
        where: { schoolYear: year },
        _max: { lessonDate: true },
      }),
      this.prisma.behaviorItem.aggregate({
        where: { schoolYear: year },
        _max: { eventAt: true },
      }),
    ]);

    const newest = [homework._max.lessonDate, behavior._max.eventAt]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    if (!newest) return null;
    const nextYearStart = new Date(Date.UTC(year, 8, 1));
    return newest >= nextYearStart ? newest : null;
  }

  private async failedAttempts(connectionId: string, year: number): Promise<number> {
    return this.prisma.syncRun.count({
      where: {
        source: HistoryBackfillTask.completionSource(year),
        householdConnectionId: connectionId,
        status: 'failed',
      },
    });
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
