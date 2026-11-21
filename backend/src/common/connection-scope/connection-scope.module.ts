import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MashovSessionModule } from '../../session/mashov-session.module';
import { ConnectionScopeService } from './connection-scope.service';

/**
 * Ownership resolution, imported by every module that reads or writes a
 * per-school table: MailModule, ChildrenModule, SyncModule, DashboardModule,
 * SettingsModule.
 */
@Module({
  imports: [PrismaModule, MashovSessionModule],
  providers: [ConnectionScopeService],
  exports: [ConnectionScopeService],
})
export class ConnectionScopeModule {}
