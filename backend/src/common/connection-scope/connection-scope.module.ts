import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SessionModule } from '../../session/session.module';
import { ConnectionScopeService } from './connection-scope.service';

/**
 * Ownership resolution, imported by every module that reads or writes a
 * per-school table: MailModule, ChildrenModule, SyncModule, DashboardModule,
 * SettingsModule.
 */
@Module({
  imports: [PrismaModule, SessionModule],
  providers: [ConnectionScopeService],
  exports: [ConnectionScopeService],
})
export class ConnectionScopeModule {}
