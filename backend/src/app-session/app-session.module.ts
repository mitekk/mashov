import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AppSessionService } from './app-session.service';
import { AppSessionGuard } from './app-session.guard';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [AppSessionService, AppSessionGuard],
  exports: [AppSessionService, AppSessionGuard],
})
export class AppSessionModule {}
