import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [PrismaModule, SyncModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
