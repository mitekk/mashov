import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { SessionModule } from './session/session.module';
import { SyncModule } from './sync/sync.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { FeedModule } from './feed/feed.module';
import { ChildrenModule } from './children/children.module';
import { MailModule } from './mail/mail.module';
import { SettingsModule } from './settings/settings.module';
import { ReadStateModule } from './read-state/read-state.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    SessionModule,
    SyncModule,
    DashboardModule,
    FeedModule,
    ChildrenModule,
    MailModule,
    SettingsModule,
    ReadStateModule,
    HealthModule,
  ],
})
export class AppModule {}
