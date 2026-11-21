import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { SchoolYearModule } from '../common/school-year/school-year.module';
import { ConnectionService } from './connection.service';

@Module({
  imports: [ConfigModule, PrismaModule, MashovSessionModule, SchoolYearModule],
  providers: [ConnectionService],
  exports: [ConnectionService],
})
export class ConnectionModule {}
