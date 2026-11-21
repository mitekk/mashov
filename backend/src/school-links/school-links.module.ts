import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { SchoolYearModule } from '../common/school-year/school-year.module';
import { MashovLoginModule } from '../common/mashov-login/mashov-login.module';
import { SyncModule } from '../sync/sync.module';
import { ConnectionModule } from '../connection/connection.module';
import { AppSessionModule } from '../app-session/app-session.module';
import { SchoolLinksController } from './school-links.controller';
import { SchoolLinksService } from './school-links.service';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    MashovSessionModule,
    SchoolYearModule,
    MashovLoginModule,
    SyncModule,
    ConnectionModule,
    // For `revokeAllSessionsForUser` on a household merge: the Redis session
    // mirror is what actually ends a session, and that method is the only
    // call that clears both it and the DB row. AppSessionModule imports only
    // ConfigModule + PrismaModule, so there is no cycle.
    AppSessionModule,
  ],
  controllers: [SchoolLinksController],
  providers: [SchoolLinksService],
  exports: [SchoolLinksService],
})
export class SchoolLinksModule {}
