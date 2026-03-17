import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { UserItemStateService } from '../common/user-item-state.service';

@Module({
  imports: [PrismaModule, SyncModule, MashovSessionModule],
  controllers: [DashboardController],
  providers: [DashboardService, UserItemStateService],
})
export class DashboardModule {}
