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
          `School year rollover for connection ${connection.id}: ${connection.schoolYear} -> ${resolved.year} (source=${resolved.source})`,
        );

        await this.prisma.householdConnection.update({
          where: { id: connection.id },
          data: { schoolYear: resolved.year },
        });

        // The cached Mashov session is scoped to the old year, so it has to go
        // before anything reads with the new one.
        await this.sessionService.refreshRosterForConnection(connection.id);
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
