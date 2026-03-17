import { Controller, Post, Get, HttpCode, HttpStatus, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { SyncService } from './sync.service';
import { PrismaService } from '../prisma/prisma.service';

const TOTAL_SYNC_SOURCES = 13; // approximate total sources

@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async refresh() {
    return this.syncService.refreshAll();
  }

  @Get('status')
  async getStatus(@Req() req: Request) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }

    // Find user's connection
    const connection = await this.prisma.householdConnection.findFirst({
      where: { userId, active: true },
      orderBy: { lastLoginAt: 'desc' },
    });

    if (!connection) {
      return {
        done: false,
        sourcesCompleted: 0,
        sourcesTotal: TOTAL_SYNC_SOURCES,
      };
    }

    // Count distinct sources that have completed successfully in the last 30 minutes
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const completedRuns = await this.prisma.syncRun.groupBy({
      by: ['source'],
      where: {
        status: 'success',
        endedAt: { gte: thirtyMinutesAgo },
      },
    });

    const sourcesCompleted = completedRuns.length;
    const done = sourcesCompleted >= TOTAL_SYNC_SOURCES;

    return {
      done,
      sourcesCompleted,
      sourcesTotal: TOTAL_SYNC_SOURCES,
    };
  }
}
