import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { ConnectionService } from './connection.service';
import { ConnectionController } from './connection.controller';

@Module({
  imports: [ConfigModule, PrismaModule, MashovSessionModule],
  controllers: [ConnectionController],
  providers: [ConnectionService],
  exports: [ConnectionService],
})
export class ConnectionModule {}
