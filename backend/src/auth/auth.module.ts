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
import { CredentialRecoveryService } from './credential-recovery.service';
import { CredentialRecoveryController } from './credential-recovery.controller';

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
  controllers: [AuthController, CredentialRecoveryController],
  providers: [AuthService, CredentialRecoveryService],
  exports: [AuthService, CredentialRecoveryService],
})
export class AuthModule {}
