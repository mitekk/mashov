import { Controller, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async refresh() {
    // Fire-and-forget: trigger all tasks and return immediately
    void this.syncService.refreshAll();
    return { started: true, message: 'Sync refresh triggered. Poll /api/v1/settings/source-health for progress.' };
  }
}
