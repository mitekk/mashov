import { Module } from '@nestjs/common';
import { ChildrenController } from './children.controller';
import { ChildrenService } from './children.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { UserItemStateService } from '../common/user-item-state.service';

@Module({
  imports: [PrismaModule, MashovSessionModule],
  controllers: [ChildrenController],
  providers: [ChildrenService, UserItemStateService],
})
export class ChildrenModule {}
