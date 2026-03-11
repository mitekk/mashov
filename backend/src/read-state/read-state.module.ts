import { Module } from '@nestjs/common';
import { ReadStateController } from './read-state.controller';
import { ReadStateService } from './read-state.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ReadStateController],
  providers: [ReadStateService],
})
export class ReadStateModule {}
