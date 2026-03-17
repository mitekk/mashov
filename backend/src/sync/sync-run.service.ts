import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SyncRun } from '@prisma/client';

@Injectable()
export class SyncRunService {
  constructor(private readonly prisma: PrismaService) {}

  async openRun(source: string, householdConnectionId?: string): Promise<SyncRun> {
    return this.prisma.syncRun.create({
      data: {
        source,
        status: 'running',
        startedAt: new Date(),
        householdConnectionId: householdConnectionId ?? null,
      },
    });
  }

  async closeRun(
    id: string,
    status: 'success' | 'failed' | 'partial',
    options?: {
      fetchedCount?: number;
      createdCount?: number;
      updatedCount?: number;
      errorMessage?: string;
    },
  ): Promise<SyncRun> {
    return this.prisma.syncRun.update({
      where: { id },
      data: {
        status,
        endedAt: new Date(),
        ...options,
      },
    });
  }

  async getLatestSuccessfulRun(source: string): Promise<SyncRun | null> {
    return this.prisma.syncRun.findFirst({
      where: { source, status: 'success' },
      orderBy: { endedAt: 'desc' },
    });
  }

  async getLatestRun(source: string): Promise<SyncRun | null> {
    return this.prisma.syncRun.findFirst({
      where: { source },
      orderBy: { startedAt: 'desc' },
    });
  }

  async getAllSourceHealth(): Promise<Map<string, SyncRun>> {
    const runs = await this.prisma.syncRun.findMany({
      orderBy: { startedAt: 'desc' },
    });

    const latest = new Map<string, SyncRun>();
    for (const run of runs) {
      if (!latest.has(run.source)) {
        latest.set(run.source, run);
      }
    }
    return latest;
  }

  async getLatestSuccessfulRuns(): Promise<Map<string, SyncRun>> {
    const runs = await this.prisma.syncRun.findMany({
      where: { status: 'success' },
      orderBy: { endedAt: 'desc' },
    });

    const latest = new Map<string, SyncRun>();
    for (const run of runs) {
      if (!latest.has(run.source)) {
        latest.set(run.source, run);
      }
    }
    return latest;
  }
}
