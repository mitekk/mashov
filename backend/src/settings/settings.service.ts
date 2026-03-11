import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSourceHealth() {
    const runs = await this.prisma.syncRun.findMany({
      orderBy: { startedAt: 'desc' },
    });

    const latestPerSource = new Map<string, typeof runs[0]>();
    for (const run of runs) {
      if (!latestPerSource.has(run.source)) {
        latestPerSource.set(run.source, run);
      }
    }

    return Array.from(latestPerSource.entries()).map(([source, run]) => ({
      source,
      status: run.status,
      lastRun: run.startedAt.toISOString(),
      errorMessage: run.errorMessage ?? null,
    }));
  }

  async getProfile() {
    return this.prisma.parentProfile.findFirst();
  }
}
