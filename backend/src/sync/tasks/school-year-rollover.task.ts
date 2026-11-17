import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { SchoolYearService } from '../../common/school-year/school-year.service';
import { MashovSessionService } from '../../session/mashov-session.service';
import { StudentsTask } from './students.task';

/**
 * Advances every active connection to the live school year.
 *
 * This is what makes the August rollover self-maintaining: it does not depend
 * on anyone signing in. Sign-in advances a connection too, but the family that
 * stays signed in all summer is exactly the family that would otherwise sit on
 * a dead year for months — which is what happened in 2026.
 */
@Injectable()
export class SchoolYearRolloverTask implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchoolYearRolloverTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolYearService: SchoolYearService,
    private readonly sessionService: MashovSessionService,
    private readonly studentsTask: StudentsTask,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    await this.run();
  }

  @Cron('0 4 * * *')
  async run(): Promise<void> {
    const connections = await this.prisma.householdConnection.findMany({
      where: { active: true },
    });

    for (const connection of connections) {
      try {
        const resolved = await this.schoolYearService.resolveForSchool(connection.schoolCode);

        if (resolved.year <= connection.schoolYear) {
          continue;
        }

        this.logger.warn(
          `School year rollover candidate for connection ${connection.id}: ${connection.schoolYear} -> ${resolved.year} (source=${resolved.source})`,
        );

        // The candidate is *offered* to Mashov rather than written down first.
        // `resolveForSchool` takes max(calendar, schools-api), so on 1 September
        // it returns the new year whether or not Mashov has opened it; writing
        // that straight to the connection empties every list, and because this
        // task only ever advances, it would re-apply the bad year each morning
        // after a sign-in corrected it. `refreshRosterForConnection` logs in at
        // the candidate, reconciles against Mashov's own answer and persists
        // whichever year Mashov confirms.
        const result = await this.sessionService.refreshRosterForConnection(
          connection.id,
          resolved.year,
        );

        if (result.year !== resolved.year) {
          this.logger.warn(
            `Mashov did not accept year=${resolved.year} for connection ${connection.id}; staying on ${result.year}`,
          );
        }

        // Re-reads the roster at the year Mashov confirmed — which matters when
        // it vetoed the candidate, since the read above happened at the vetoed
        // year — and records the `syncRun` under `students`, which the freshness
        // page and the self-heal TTL both read. One extra login per connection
        // per day when the candidate was accepted; worth the simplicity of
        // having exactly one place that records a roster sync.
        await this.studentsTask.execute({ connectionId: connection.id });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `School year rollover failed for connection ${connection.id}: ${msg}`,
        );
      }
    }
  }
}
