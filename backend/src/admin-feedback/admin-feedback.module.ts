import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminFeedbackController } from './admin-feedback.controller';
import { AdminFeedbackService } from './admin-feedback.service';

/**
 * The operator read path over the feedback table.
 *
 * Its own module rather than a second controller inside FeedbackModule, so
 * that module stays exactly one thing: the parent's write path. The two share
 * a table and nothing else -- no service, no provider, no code an operator can
 * run that a parent's POST also runs.
 *
 * It needs no import edge for the Access guard: AdminAuthModule is `@Global()`,
 * and the guard it provides is attached per-controller with `@UseGuards`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AdminFeedbackController],
  providers: [AdminFeedbackService],
})
export class AdminFeedbackModule {}
