import { Controller, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async refresh() {
    return this.syncService.refreshAll();
  }
}
