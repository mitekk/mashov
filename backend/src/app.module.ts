import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./prisma/prisma.module";
import { MashovSessionModule } from "./session/mashov-session.module";
import { RedisModule } from "./redis/redis.module";
import { AppSessionModule } from "./app-session/app-session.module";
import { AuthModule } from "./auth/auth.module";
import { ConnectionModule } from "./connection/connection.module";
import { SchoolLinksModule } from "./school-links/school-links.module";
import { SyncModule } from "./sync/sync.module";
import { DigestModule } from "./digest/digest.module";
import { InboxNotifyModule } from "./inbox-notify/inbox-notify.module";
import { TelegramMediaModule } from "./telegram-media/telegram-media.module";
import { TelegramModule } from "./telegram/telegram.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { FeedModule } from "./feed/feed.module";
import { ChildrenModule } from "./children/children.module";
import { MailModule } from "./mail/mail.module";
import { SettingsModule } from "./settings/settings.module";
import { HealthModule } from "./health/health.module";
import { FeedbackModule } from "./feedback/feedback.module";
import { AppSessionGuard } from "./app-session/app-session.guard";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 50 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    AppSessionModule,
    MashovSessionModule,
    AuthModule,
    ConnectionModule,
    SchoolLinksModule,
    SyncModule,
    // Global, and listed before its consumers for readability only -- the
    // MEDIA_DELIVERY token reaches DigestModule and InboxNotifyModule without
    // an import edge, which is what keeps MashovSessionModule out of their
    // graphs. See src/telegram-media/telegram-media.module.ts.
    TelegramMediaModule,
    DigestModule,
    InboxNotifyModule,
    TelegramModule,
    DashboardModule,
    FeedModule,
    ChildrenModule,
    MailModule,
    SettingsModule,
    HealthModule,
    FeedbackModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AppSessionGuard },
  ],
})
export class AppModule {}
