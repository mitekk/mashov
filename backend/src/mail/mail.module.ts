import { Module } from '@nestjs/common';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { ConnectionScopeModule } from '../common/connection-scope/connection-scope.module';

/**
 * MailService is exported for TelegramMediaModule, which downloads a mail
 * attachment to forward it into a Telegram chat. The edge runs one way only --
 * nothing here depends on that module -- so there is no circular dependency to
 * forwardRef around. See ADR-0038.
 */
@Module({
  imports: [PrismaModule, MashovSessionModule, ConnectionScopeModule],
  controllers: [MailController],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
