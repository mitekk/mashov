import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SettingsService } from './settings.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('source-health')
  async getSourceHealth(@Req() req: Request) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }

    // Same lookup `SyncController` does. Without it this endpoint reported
    // every household's sources to every signed-in user.
    const connection = await this.prisma.householdConnection.findFirst({
      where: { userId, active: true },
      orderBy: { lastLoginAt: 'desc' },
    });

    return this.settingsService.getSourceHealth(connection?.id ?? null);
  }

  @Get('profile')
  async getProfile() {
    return this.settingsService.getProfile();
  }
}
