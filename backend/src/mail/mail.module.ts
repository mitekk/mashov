import { Module } from '@nestjs/common';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MashovSessionModule } from '../session/mashov-session.module';
import { ConnectionScopeModule } from '../common/connection-scope/connection-scope.module';

@Module({
  imports: [PrismaModule, MashovSessionModule, ConnectionScopeModule],
  controllers: [MailController],
  providers: [MailService],
})
export class MailModule {}
