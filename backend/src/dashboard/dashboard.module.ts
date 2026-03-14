import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [PrismaModule, SyncModule, SessionModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
