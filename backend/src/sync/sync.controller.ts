import { Controller, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh() {
    // Fire-and-forget: trigger all tasks and return immediately
    void this.syncService.refreshAll();
    return { status: 'refresh_triggered' };
  }
}
