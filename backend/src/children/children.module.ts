import { Module } from '@nestjs/common';
import { ChildrenController } from './children.controller';
import { ChildrenService } from './children.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { ConnectionScopeModule } from '../common/connection-scope/connection-scope.module';
import { UserItemStateService } from '../common/user-item-state.service';

/**
 * ChildrenService is exported for TelegramMediaModule, which downloads a
 * homework or behaviour attachment to forward it into a Telegram chat. Its
 * download methods take an `AppUser.id` and enforce visibility with it, which
 * is exactly why the media module calls them rather than reaching for the
 * Mashov client itself. See ADR-0038.
 */
@Module({
  imports: [PrismaModule, MashovSessionModule, ConnectionScopeModule],
  controllers: [ChildrenController],
  providers: [ChildrenService, UserItemStateService],
  exports: [ChildrenService],
})
export class ChildrenModule {}
