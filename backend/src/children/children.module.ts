import { Module } from '@nestjs/common';
import { ChildrenController } from './children.controller';
import { ChildrenService } from './children.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [PrismaModule, SessionModule],
  controllers: [ChildrenController],
  providers: [ChildrenService],
})
export class ChildrenModule {}
