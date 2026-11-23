import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AppSessionModule } from '../app-session/app-session.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { SchoolYearModule } from '../common/school-year/school-year.module';
import { SchoolLinksModule } from '../school-links/school-links.module';
import { MashovLoginModule } from '../common/mashov-login/mashov-login.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AppSessionModule,
    MashovSessionModule,
    SchoolYearModule,
    SchoolLinksModule,
    MashovLoginModule,
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
